import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { AccessToken } from 'livekit-server-sdk';
import { z } from 'zod';
import { db, publicUser, isCommunityMember, channelAccess } from './db.js';
import {
  createSession, destroySession, hashPassword, id, inviteCode, purgeExpiredSessions,
  recoveryCode, requireAuth, sameOrigin, sha256, userFromCookie, verifyPassword,
  type AuthRequest,
} from './security.js';

const app = express();
const httpServer = createServer(app);
const publicUrl = process.env.PUBLIC_APP_URL ?? 'https://localhost';
const livekitUrl = process.env.LIVEKIT_PUBLIC_URL ?? 'wss://localhost';
const port = Number(process.env.PORT ?? 3000);

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'", livekitUrl],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use(express.json({ limit: '24kb' }));
app.use(sameOrigin);

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 180, standardHeaders: true, legacyHeaders: false });

const credentialsSchema = z.object({
  email: z.string().email().max(160).transform((v) => v.trim().toLowerCase()),
  password: z.string().min(10).max(128),
});
const registerSchema = credentialsSchema.extend({
  username: z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_.-]+$/),
  displayName: z.string().trim().min(2).max(40),
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'telahub', time: new Date().toISOString() }));

app.post('/api/auth/register', authLimiter, (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Confira e-mail, usuário e senha. A senha deve ter ao menos 10 caracteres.' });
  const { email, username, displayName, password } = parsed.data;
  const userId = id();
  const communityId = id();
  const now = new Date().toISOString();
  const recovery = recoveryCode();
  try {
    db.transaction(() => {
      db.prepare('INSERT INTO users (id,email,username,display_name,password_hash,recovery_code_hash,created_at,last_seen) VALUES (?,?,?,?,?,?,?,?)')
        .run(userId, email, username, displayName, hashPassword(password), sha256(recovery), now, now);
      db.prepare('INSERT INTO communities (id,name,owner_id,invite_code,created_at) VALUES (?,?,?,?,?)')
        .run(communityId, `Espaço de ${displayName}`, userId, inviteCode(), now);
      db.prepare('INSERT INTO community_members (community_id,user_id,role,joined_at) VALUES (?,?,?,?)')
        .run(communityId, userId, 'owner', now);
      db.prepare('INSERT INTO channels (id,community_id,name,type,position,created_at) VALUES (?,?,?,?,?,?)')
        .run(id(), communityId, 'geral', 'text', 0, now);
      db.prepare('INSERT INTO channels (id,community_id,name,type,position,created_at) VALUES (?,?,?,?,?,?)')
        .run(id(), communityId, 'compartilhar-tela', 'screen', 1, now);
    })();
    createSession(res, userId);
    res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)), recoveryCode: recovery });
  } catch (error: any) {
    if (String(error?.message).includes('UNIQUE')) return res.status(409).json({ error: 'E-mail ou nome de usuário já está em uso.' });
    console.error(error);
    res.status(500).json({ error: 'Não foi possível criar a conta.' });
  }
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Credenciais inválidas.' });
  const row: any = db.prepare('SELECT * FROM users WHERE email = ?').get(parsed.data.email);
  if (!row || !verifyPassword(parsed.data.password, row.password_hash)) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  createSession(res, row.id);
  res.json({ user: publicUser(row) });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  destroySession(req, res);
  res.status(204).end();
});

app.get('/api/auth/me', requireAuth, (req: AuthRequest, res) => res.json({ user: req.user }));

app.post('/api/auth/recover', authLimiter, (req, res) => {
  const parsed = z.object({ email: z.string().email(), recoveryCode: z.string().min(8).max(32), newPassword: z.string().min(10).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados de recuperação inválidos.' });
  const row: any = db.prepare('SELECT * FROM users WHERE email = ?').get(parsed.data.email.trim().toLowerCase());
  if (!row || row.recovery_code_hash !== sha256(parsed.data.recoveryCode.trim().toUpperCase())) return res.status(401).json({ error: 'Código de recuperação inválido.' });
  const nextRecovery = recoveryCode();
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, recovery_code_hash = ? WHERE id = ?').run(hashPassword(parsed.data.newPassword), sha256(nextRecovery), row.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
  })();
  res.json({ ok: true, recoveryCode: nextRecovery });
});

app.get('/api/communities', requireAuth, (req: AuthRequest, res) => {
  const communities: any[] = db.prepare(`
    SELECT c.*, cm.role FROM communities c
    JOIN community_members cm ON cm.community_id = c.id
    WHERE cm.user_id = ? ORDER BY c.created_at
  `).all(req.user!.id) as any[];
  const channelStmt = db.prepare('SELECT id,community_id,name,type,position,created_at FROM channels WHERE community_id = ? ORDER BY position,name');
  res.json({ communities: communities.map((community) => ({ ...community, channels: channelStmt.all(community.id) })) });
});

app.post('/api/communities', requireAuth, writeLimiter, (req: AuthRequest, res) => {
  const parsed = z.object({ name: z.string().trim().min(2).max(50) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Nome inválido.' });
  const communityId = id();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('INSERT INTO communities (id,name,owner_id,invite_code,created_at) VALUES (?,?,?,?,?)').run(communityId, parsed.data.name, req.user!.id, inviteCode(), now);
    db.prepare('INSERT INTO community_members (community_id,user_id,role,joined_at) VALUES (?,?,?,?)').run(communityId, req.user!.id, 'owner', now);
    db.prepare('INSERT INTO channels (id,community_id,name,type,position,created_at) VALUES (?,?,?,?,?,?)').run(id(), communityId, 'geral', 'text', 0, now);
    db.prepare('INSERT INTO channels (id,community_id,name,type,position,created_at) VALUES (?,?,?,?,?,?)').run(id(), communityId, 'compartilhar-tela', 'screen', 1, now);
  })();
  res.status(201).json({ ok: true, id: communityId });
});

app.post('/api/communities/join', requireAuth, writeLimiter, (req: AuthRequest, res) => {
  const parsed = z.object({ inviteCode: z.string().trim().min(4).max(32) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Convite inválido.' });
  const community: any = db.prepare('SELECT * FROM communities WHERE invite_code = ?').get(parsed.data.inviteCode.toUpperCase());
  if (!community) return res.status(404).json({ error: 'Comunidade não encontrada.' });
  db.prepare('INSERT OR IGNORE INTO community_members (community_id,user_id,role,joined_at) VALUES (?,?,?,?)')
    .run(community.id, req.user!.id, 'member', new Date().toISOString());
  res.json({ ok: true, id: community.id });
});

app.get('/api/communities/:communityId/members', requireAuth, (req: AuthRequest, res) => {
  const communityId = String(req.params.communityId);
  if (!isCommunityMember(req.user!.id, communityId)) return res.status(403).json({ error: 'Acesso negado.' });
  const members = db.prepare(`
    SELECT u.id,u.username,u.display_name,u.last_seen,cm.role
    FROM community_members cm JOIN users u ON u.id = cm.user_id
    WHERE cm.community_id = ? ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,u.display_name
  `).all(communityId);
  res.json({ members });
});

app.post('/api/communities/:communityId/channels', requireAuth, writeLimiter, (req: AuthRequest, res) => {
  const membership: any = db.prepare('SELECT role FROM community_members WHERE community_id = ? AND user_id = ?').get(req.params.communityId, req.user!.id);
  if (!membership || !['owner', 'admin'].includes(membership.role)) return res.status(403).json({ error: 'Somente administradores podem criar canais.' });
  const parsed = z.object({ name: z.string().trim().min(2).max(40).regex(/^[a-zA-Z0-9_\-À-ÿ ]+$/), type: z.enum(['text', 'screen']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Nome ou tipo de canal inválido.' });
  const channelId = id();
  const position: any = db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS next FROM channels WHERE community_id = ?').get(req.params.communityId);
  try {
    db.prepare('INSERT INTO channels (id,community_id,name,type,position,created_at) VALUES (?,?,?,?,?,?)')
      .run(channelId, req.params.communityId, parsed.data.name.toLowerCase().replace(/\s+/g, '-'), parsed.data.type, position.next, new Date().toISOString());
    res.status(201).json({ ok: true, id: channelId });
  } catch {
    res.status(409).json({ error: 'Já existe um canal com esse nome.' });
  }
});

app.get('/api/channels/:channelId/messages', requireAuth, (req: AuthRequest, res) => {
  const channelId = String(req.params.channelId);
  if (!channelAccess(req.user!.id, channelId)) return res.status(403).json({ error: 'Acesso negado.' });
  const before = typeof req.query.before === 'string' ? req.query.before : '9999-12-31T23:59:59.999Z';
  const messages = db.prepare(`
    SELECT m.id,m.channel_id,m.content,m.created_at,m.edited_at,u.id AS author_id,u.username,u.display_name
    FROM messages m JOIN users u ON u.id = m.author_id
    WHERE m.channel_id = ? AND m.created_at < ? ORDER BY m.created_at DESC LIMIT 60
  `).all(channelId, before).reverse();
  res.json({ messages });
});

app.get('/api/livekit/token', requireAuth, async (req: AuthRequest, res) => {
  const channelId = String(req.query.channelId ?? '');
  const channel: any = channelAccess(req.user!.id, channelId);
  if (!channel || channel.type !== 'screen') return res.status(403).json({ error: 'Canal de tela inválido.' });
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) return res.status(503).json({ error: 'Servidor de mídia indisponível.' });
  const token = new AccessToken(apiKey, apiSecret, { identity: req.user!.id, name: req.user!.display_name, ttl: '2h' });
  token.addGrant({ roomJoin: true, room: `screen-${channel.id}`, canPublish: true, canSubscribe: true, canPublishData: false });
  res.json({ token: await token.toJwt(), url: livekitUrl, room: `screen-${channel.id}` });
});

const io = new Server(httpServer, {
  cors: { origin: publicUrl, credentials: true },
  maxHttpBufferSize: 24_000,
  pingInterval: 20_000,
  pingTimeout: 25_000,
});

const onlineUsers = new Map<string, number>();

io.use((socket, next) => {
  const user = userFromCookie(socket.handshake.headers.cookie);
  if (!user) return next(new Error('Não autenticado'));
  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  const user = socket.data.user;
  onlineUsers.set(user.id, (onlineUsers.get(user.id) ?? 0) + 1);
  db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(new Date().toISOString(), user.id);
  io.emit('presence:update', { userId: user.id, online: true });

  socket.on('channel:join', (channelId: string, ack?: Function) => {
    const channel = channelAccess(user.id, channelId);
    if (!channel) return ack?.({ ok: false, error: 'Acesso negado.' });
    for (const room of socket.rooms) if (room.startsWith('channel:')) socket.leave(room);
    socket.join(`channel:${channelId}`);
    ack?.({ ok: true });
  });

  socket.on('message:send', (payload: unknown, ack?: Function) => {
    const parsed = z.object({ channelId: z.string().min(1), content: z.string().trim().min(1).max(4000) }).safeParse(payload);
    if (!parsed.success) return ack?.({ ok: false, error: 'Mensagem inválida.' });
    const channel = channelAccess(user.id, parsed.data.channelId);
    if (!channel) return ack?.({ ok: false, error: 'Acesso negado.' });
    const message = {
      id: id(), channel_id: parsed.data.channelId, author_id: user.id,
      username: user.username, display_name: user.display_name,
      content: parsed.data.content, created_at: new Date().toISOString(), edited_at: null,
    };
    db.prepare('INSERT INTO messages (id,channel_id,author_id,content,created_at) VALUES (?,?,?,?,?)')
      .run(message.id, message.channel_id, message.author_id, message.content, message.created_at);
    io.to(`channel:${message.channel_id}`).emit('message:new', message);
    ack?.({ ok: true, id: message.id });
  });

  socket.on('typing', (payload: unknown) => {
    const parsed = z.object({ channelId: z.string(), active: z.boolean() }).safeParse(payload);
    if (!parsed.success || !channelAccess(user.id, parsed.data.channelId)) return;
    socket.to(`channel:${parsed.data.channelId}`).emit('typing', { userId: user.id, displayName: user.display_name, active: parsed.data.active });
  });

  socket.on('screen:status', (payload: unknown) => {
    const parsed = z.object({ channelId: z.string(), active: z.boolean() }).safeParse(payload);
    if (!parsed.success || !channelAccess(user.id, parsed.data.channelId)) return;
    io.to(`channel:${parsed.data.channelId}`).emit('screen:status', { userId: user.id, displayName: user.display_name, active: parsed.data.active });
  });

  socket.on('disconnect', () => {
    const count = (onlineUsers.get(user.id) ?? 1) - 1;
    if (count <= 0) {
      onlineUsers.delete(user.id);
      db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(new Date().toISOString(), user.id);
      io.emit('presence:update', { userId: user.id, online: false });
    } else onlineUsers.set(user.id, count);
  });
});

purgeExpiredSessions();
setInterval(purgeExpiredSessions, 6 * 60 * 60 * 1000).unref();

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const clientDir = join(__dirname, '../client');
app.use(express.static(clientDir, { maxAge: '1h', index: false }));
app.get('*splat', (_req, res) => res.sendFile(join(clientDir, 'index.html')));

httpServer.listen(port, '0.0.0.0', () => console.log(`TelaHub listening on ${port}`));
