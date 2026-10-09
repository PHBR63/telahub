import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { Server } from 'socket.io';
import { AccessToken } from 'livekit-server-sdk';
import { z } from 'zod';
import sharp from 'sharp';
import { db, publicUser, isCommunityMember, channelAccess } from './db.js';
import {
  createSession, destroySession, hashPassword, id, inviteCode, purgeExpiredSessions,
  recoveryCode, requireAuth, sameOrigin, sha256, userFromCookie, verifyPassword,
  type AuthRequest,
} from './security.js';
import { emailDeliveryConfigured, sendPasswordResetEmail } from './mailer.js';

const app = express();
const httpServer = createServer(app);
const onlineUsers = new Map<string, number>();
type ActiveScreen = { userId:string; displayName:string; active:true; audioMode:'window'|'system'|'none'; surface:'browser'|'window'|'monitor'|'unknown'; hasAudio:boolean; socketId:string };
const activeScreens = new Map<string, Map<string, ActiveScreen>>();
type ActiveCamera = { userId:string; displayName:string; active:true; socketId:string };
const activeCameras = new Map<string, Map<string, ActiveCamera>>();
type MediaKind = 'screen'|'camera';
type MediaReservation = { userId:string; socketId:string; kind:MediaKind; expiresAt:number };
const mediaReservations = new Map<string, Map<string, MediaReservation>>();
const socketsByUser = new Map<string, Set<any>>();
const socketEventWindows = new Map<string, Map<string, { startedAt:number; count:number }>>();
const maxActiveScreenStreams = Math.max(4, Number(process.env.MAX_ACTIVE_SCREEN_STREAMS ?? 24));
const maxActiveCameraStreams = Math.max(8, Number(process.env.MAX_ACTIVE_CAMERA_STREAMS ?? 16));
let io: Server;
const publicUrl = process.env.PUBLIC_APP_URL ?? 'https://localhost';
const livekitUrl = process.env.LIVEKIT_PUBLIC_URL ?? 'wss://localhost';
const port = Number(process.env.PORT ?? 3000);
const databasePath = process.env.DATABASE_PATH ?? './data/telahub.db';
const uploadsDir = process.env.UPLOADS_PATH ?? join(dirname(databasePath), 'uploads');
const maxIconBytes = 2 * 1024 * 1024;
let metricsCpuSample = process.cpuUsage();
let metricsCpuAt = process.hrtime.bigint();
let metricsNetworkSample = readNetworkBytes();
let metricsNetworkAt = process.hrtime.bigint();
function readNetworkBytes() {
  try {
    return readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2).reduce((total, line) => {
      const fields = line.trim().split(/[:\s]+/);
      if (fields.length < 10 || fields[0] === 'lo') return total;
      return { rx: total.rx + Number(fields[1] || 0), tx: total.tx + Number(fields[9] || 0) };
    }, { rx: 0, tx: 0 });
  } catch { return { rx: 0, tx: 0 }; }
}
function collectRuntimeMetrics() {
  const now = process.hrtime.bigint();
  const usage = process.cpuUsage();
  const elapsedMicros = Math.max(1, Number(now - metricsCpuAt) / 1000);
  const cpuMicros = Math.max(0, (usage.user + usage.system) - (metricsCpuSample.user + metricsCpuSample.system));
  metricsCpuSample = usage;
  metricsCpuAt = now;
  const cpuPercent = Math.min(100, Math.round((cpuMicros / elapsedMicros) * 1000) / 10);
  const networkNow = readNetworkBytes();
  const networkElapsedSeconds = Math.max(0.001, Number(now - metricsNetworkAt) / 1_000_000_000);
  const network = { downMbps: Math.round(((networkNow.rx - metricsNetworkSample.rx) * 8 / networkElapsedSeconds / 1_000_000) * 100) / 100, upMbps: Math.round(((networkNow.tx - metricsNetworkSample.tx) * 8 / networkElapsedSeconds / 1_000_000) * 100) / 100 };
  metricsNetworkSample = networkNow;
  metricsNetworkAt = now;
  const memoryTotal = totalmem();
  const memoryFree = freemem();
  const memoryUsed = Math.max(0, memoryTotal - memoryFree);
  return {
    capturedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    cpuPercent,
    cpuCores: cpus().length,
    load1: Math.round(loadavg()[0] * 100) / 100,
    memoryUsedMb: Math.round(memoryUsed / 1024 / 1024),
    memoryTotalMb: Math.round(memoryTotal / 1024 / 1024),
    memoryPercent: Math.round((memoryUsed / Math.max(1, memoryTotal)) * 1000) / 10,
    processRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    network,
  };
}
const acceptedImageTypes = new Set(['image/png','image/jpeg','image/webp']);
mkdirSync(uploadsDir, { recursive: true });

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
app.use('/uploads', express.static(uploadsDir, { immutable: true, maxAge: '1y', fallthrough: false }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 180, standardHeaders: true, legacyHeaders: false });

const credentialsSchema = z.object({
  email: z.string().email().max(160).transform((v) => v.trim().toLowerCase()),
  password: z.string().min(8).max(128),
});
const registerSchema = credentialsSchema.extend({
  username: z.string().trim().min(3).max(24).regex(/^[\p{L}\p{M}\p{N}_.-]+$/u).transform((v) => v.normalize("NFC")),
  displayName: z.string().trim().min(2).max(40),
});
const iconIds = ['user','users','sparkles','gamepad','code','rocket','crown','shield','palette','music','coffee','cat','star'] as const;
const iconColors = ['#766cff','#4ed4c6','#f08b5d','#f05d77','#4d8df7','#b56cff','#e2b84b','#5bbf6a'] as const;
const profileAppearanceSchema = z.object({ avatarIcon: z.enum(iconIds), avatarColor: z.enum(iconColors) });
const communityIdentitySchema = z.object({
  name: z.string().trim().min(2).max(50).optional(),
  icon: z.enum(iconIds).optional(),
  iconColor: z.enum(iconColors).optional(),
}).refine((value) => Object.keys(value).length > 0);
const communityNameSchema = z.object({ name: z.string().trim().min(2).max(50) });
const channelNameSchema = z.string().trim().min(2).max(40).regex(/^[a-zA-Z0-9_\-À-ÿ ]+$/);
const roleSchema = z.object({ role: z.enum(['admin', 'member']) });

function communityMembership(userId: string, communityId: string): { role: 'owner'|'admin'|'member' } | undefined {
  return db.prepare('SELECT role FROM community_members WHERE community_id = ? AND user_id = ?').get(communityId, userId) as any;
}
function isCommunityAdmin(userId: string, communityId: string): boolean {
  const membership = communityMembership(userId, communityId);
  return Boolean(membership && ['owner', 'admin'].includes(membership.role));
}
function notifyCommunityChanged(communityId: string) {
  io?.emit('community:updated', { communityId });
}
function notifyProfileChanged(user: ReturnType<typeof publicUser>) {
  for (const client of io.sockets.sockets.values()) if (client.data.user?.id === user.id) Object.assign(client.data.user, user);
  const { email: _email, last_seen: _lastSeen, ...broadcastUser } = user;
  io.emit('profile:updated', { user: broadcastUser });
}
function disconnectUserSockets(userId: string) {
  for (const socket of socketsByUser.get(userId) ?? []) socket.disconnect(true);
}
function notifyPresence(userId: string, online: boolean) {
  for (const client of io?.sockets.sockets.values() ?? []) {
    if (client.data.user?.id === userId || db.prepare('SELECT 1 FROM community_members target JOIN community_members viewer ON viewer.community_id = target.community_id WHERE target.user_id = ? AND viewer.user_id = ? LIMIT 1').get(userId, client.data.user?.id)) {
      client.emit('presence:update', { userId, online });
    }
  }
}
function allowSocketEvent(socketId: string, key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const windows = socketEventWindows.get(socketId) ?? new Map<string, { startedAt:number; count:number }>();
  const current = windows.get(key);
  if (!current || now - current.startedAt >= windowMs) windows.set(key, { startedAt: now, count: 1 });
  else if (current.count >= limit) return false;
  else current.count += 1;
  socketEventWindows.set(socketId, windows);
  return true;
}
function mediaMap(kind: MediaKind) { return kind === 'screen' ? activeScreens : activeCameras; }
function reservationCount(channelId: string, kind: MediaKind, exceptUserId?: string): number {
  const now = Date.now();
  const reservations = mediaReservations.get(channelId);
  if (!reservations) return 0;
  for (const [userId, reservation] of reservations) if (reservation.expiresAt <= now) reservations.delete(userId);
  return Array.from(reservations.values()).filter((reservation) => reservation.kind === kind && reservation.userId !== exceptUserId).length;
}
function releaseMedia(channelId: string, userId: string, kind: MediaKind, socketId?: string) {
  const reservations = mediaReservations.get(channelId);
  const reservation = reservations?.get(userId);
  if (reservation && (!socketId || reservation.socketId === socketId) && reservation.kind === kind) {
    reservations!.delete(userId);
    if (!reservations!.size) mediaReservations.delete(channelId);
  }
  const active = mediaMap(kind).get(channelId);
  const current = active?.get(userId);
  if (current && (!socketId || current.socketId === socketId)) {
    active!.delete(userId);
    if (!active!.size) mediaMap(kind).delete(channelId);
  }
}
function removeStoredImage(url: string | null | undefined) {
  if (!url || !/^\/uploads\/[a-z0-9-]+\.webp$/.test(url)) return;
  void unlink(join(uploadsDir, basename(url))).catch(() => undefined);
}
async function storeIconImage(body: unknown, ownerPrefix: string): Promise<string> {
  if (!Buffer.isBuffer(body) || body.length === 0) throw new Error('EMPTY_IMAGE');
  if (body.length > maxIconBytes) throw new Error('IMAGE_TOO_LARGE');
  const filename = `${ownerPrefix}-${id()}.webp`;
  const target = join(uploadsDir, filename);
  const image = sharp(body, { failOn: 'error', limitInputPixels: 20_000_000 });
  const metadata = await image.metadata();
  if (!metadata.format || !['png','jpeg','webp'].includes(metadata.format)) throw new Error('INVALID_IMAGE');
  await image.rotate()
    .resize(512, 512, { fit: 'cover', position: 'centre', withoutEnlargement: false })
    .webp({ quality: 84, effort: 4 })
    .toFile(target);
  return `/uploads/${filename}`;
}
const iconUpload = express.raw({ type: (req) => acceptedImageTypes.has(String(req.headers['content-type'] ?? '').split(';')[0]), limit: '2mb' });

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'telahub', time: new Date().toISOString() }));

app.get('/api/ops/metrics', requireAuth, (req: AuthRequest, res) => {
  const requestedCommunityId = typeof req.query.communityId === 'string' ? req.query.communityId : '';
  if (requestedCommunityId && !isCommunityAdmin(req.user!.id, requestedCommunityId)) return res.status(403).json({ error: 'Somente proprietários e administradores podem consultar a saúde da comunidade.' });
  const communityIds = requestedCommunityId
    ? [requestedCommunityId]
    : (db.prepare("SELECT community_id FROM community_members WHERE user_id = ? AND role IN ('owner','admin')").all(req.user!.id) as { community_id: string }[]).map((row) => row.community_id);
  if (!communityIds.length) return res.status(403).json({ error: 'Acesso administrativo necessário.' });
  const channelIds = (db.prepare(`SELECT id FROM channels WHERE community_id IN (${communityIds.map(() => '?').join(',')})`).all(...communityIds) as { id: string }[]).map((row) => row.id);
  const activeRoomEntries = channelIds.flatMap((channelId) => Array.from(activeScreens.get(channelId)?.values() ?? []).map((screen) => ({ channelId, userId: screen.userId, hasAudio: screen.hasAudio })));
  const activeCameraEntries = channelIds.flatMap((channelId) => Array.from(activeCameras.get(channelId)?.values() ?? []).map((camera) => ({ channelId, userId: camera.userId })));
  const runtime = collectRuntimeMetrics();
  const socketClients = io?.engine?.clientsCount ?? 0;
  const onlineCount = onlineUsers.size;
  const reasons: string[] = [];
  if (runtime.memoryPercent >= 80) reasons.push('memória do host acima de 80%');
  if (runtime.load1 >= Math.max(1, runtime.cpuCores * 0.8)) reasons.push('carga de CPU elevada');
  if (activeRoomEntries.length >= 10) reasons.push('dez ou mais streams de tela ativas');
  if (activeCameraEntries.length >= 10) reasons.push('dez ou mais câmeras publicadas');
  if (runtime.network.upMbps >= 80) reasons.push('saída de rede acima de 80 Mbps');
  const status = reasons.some((reason) => reason.includes('acima') || reason.includes('elevada')) ? 'critical' : reasons.length ? 'watch' : 'ok';
  res.json({
    ok: true,
    scope: { communityIds, channelCount: channelIds.length },
    runtime,
    realtime: { socketClients, onlineUsers: onlineCount, activeScreenStreams: activeRoomEntries.length, activeScreenAudioStreams: activeRoomEntries.filter((screen) => screen.hasAudio).length, activeCameraStreams: activeCameraEntries.length, maxActiveScreenStreams, maxActiveCameraStreams },
    capacity: { status, reasons, recommendedViewerVideoLimit: 8, recommendedViewerCameraLimit: 8, recommendedFocusedQuality: '720p' },
  });
});

app.post('/api/auth/register', authLimiter, (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) { const field = String(parsed.error.issues[0]?.path[0] ?? ''); const error = field === 'username' ? 'Nome de usuário inválido: use de 3 a 24 caracteres, com letras, números, ponto, hífen ou sublinhado.' : field === 'email' ? 'Informe um e-mail válido.' : field === 'password' ? 'A senha deve ter entre 8 e 128 caracteres.' : field === 'displayName' ? 'Nome de exibição deve ter entre 2 e 40 caracteres.' : 'Confira os dados informados.'; return res.status(400).json({ error }); }
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
    res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)) });
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
  disconnectUserSockets((req as AuthRequest).user!.id);
  res.status(204).end();
});

app.get('/api/auth/me', requireAuth, (req: AuthRequest, res) => res.json({ user: req.user }));

app.patch('/api/users/me', requireAuth, writeLimiter, (req: AuthRequest, res) => {
  const parsed = profileAppearanceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Ícone ou cor de perfil inválidos.' });
  db.prepare('UPDATE users SET avatar_icon = ?, avatar_color = ? WHERE id = ?')
    .run(parsed.data.avatarIcon, parsed.data.avatarColor, req.user!.id);
  const updated = publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id));
  notifyProfileChanged(updated);
  res.json({ user: updated });
});

app.put('/api/users/me/avatar', requireAuth, writeLimiter, iconUpload, async (req: AuthRequest, res) => {
  if (!acceptedImageTypes.has(String(req.headers['content-type'] ?? '').split(';')[0])) return res.status(415).json({ error: 'Envie uma imagem PNG, JPG ou WebP.' });
  try {
    const current: any = db.prepare('SELECT avatar_image FROM users WHERE id = ?').get(req.user!.id);
    const nextImage = await storeIconImage(req.body, `profile-${req.user!.id}`);
    db.prepare('UPDATE users SET avatar_image = ? WHERE id = ?').run(nextImage, req.user!.id);
    removeStoredImage(current?.avatar_image);
    const updated = publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id));
    notifyProfileChanged(updated);
    res.json({ user: updated });
  } catch (error: any) {
    if (error?.message === 'IMAGE_TOO_LARGE') return res.status(413).json({ error: 'A imagem deve ter no máximo 2 MB.' });
    res.status(400).json({ error: 'Não foi possível processar esta imagem.' });
  }
});

app.delete('/api/users/me/avatar', requireAuth, writeLimiter, (req: AuthRequest, res) => {
  const current: any = db.prepare('SELECT avatar_image FROM users WHERE id = ?').get(req.user!.id);
  db.prepare('UPDATE users SET avatar_image = NULL WHERE id = ?').run(req.user!.id);
  removeStoredImage(current?.avatar_image);
  const updated = publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id));
  notifyProfileChanged(updated);
  res.json({ user: updated });
});

app.post('/api/auth/recover', authLimiter, (req, res) => {
  const parsed = z.object({ email: z.string().email(), recoveryCode: z.string().min(8).max(32), newPassword: z.string().min(8).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados de recuperação inválidos.' });
  const row: any = db.prepare('SELECT * FROM users WHERE email = ?').get(parsed.data.email.trim().toLowerCase());
  if (!row || row.recovery_code_hash !== sha256(parsed.data.recoveryCode.trim().toUpperCase())) return res.status(401).json({ error: 'Código de recuperação inválido.' });
  const nextRecovery = recoveryCode();
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, recovery_code_hash = ? WHERE id = ?').run(hashPassword(parsed.data.newPassword), sha256(nextRecovery), row.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
  })();
  disconnectUserSockets(row.id);
  res.json({ ok: true, recoveryCode: nextRecovery });
});

app.post('/api/auth/request-password-reset', authLimiter, async (req, res) => {
  const parsed = z.object({ email: z.string().email().max(160).transform((value) => value.trim().toLowerCase()) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Informe um e-mail válido.' });
  if (!emailDeliveryConfigured()) return res.status(503).json({ error: 'A recuperação por e-mail ainda não está configurada no servidor.' });

  const row: any = db.prepare('SELECT id, email FROM users WHERE email = ?').get(parsed.data.email);
  const genericResponse = { ok: true, message: 'Se o e-mail estiver cadastrado, enviaremos um link de recuperação. Verifique também a pasta de spam.' };
  if (!row) return res.status(202).json(genericResponse);

  const token = id();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ? OR expires_at <= ?').run(row.id, now.toISOString());
    db.prepare('INSERT INTO password_reset_tokens (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(sha256(token), row.id, now.toISOString(), expiresAt);
  })();
  try {
    await sendPasswordResetEmail(row.email, token);
  } catch (error) {
    db.prepare('DELETE FROM password_reset_tokens WHERE token_hash = ?').run(sha256(token));
    console.error('Password reset email failed', error);
  }
  res.status(202).json(genericResponse);
});

app.post('/api/auth/reset-password', authLimiter, (req, res) => {
  const parsed = z.object({ token: z.string().min(16).max(128), newPassword: z.string().min(8).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Link ou senha inválidos.' });
  const now = new Date().toISOString();
  const tokenHash = sha256(parsed.data.token);
  const reset: any = db.prepare('SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').get(tokenHash, now);
  if (!reset) return res.status(401).json({ error: 'Este link é inválido, expirou ou já foi usado.' });
  const changed = db.transaction(() => {
    const result = db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').run(now, tokenHash, now);
    if (result.changes !== 1) return false;
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(parsed.data.newPassword), reset.user_id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(reset.user_id);
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ? AND token_hash != ?').run(reset.user_id, tokenHash);
    return true;
  })();
  if (!changed) return res.status(401).json({ error: 'Este link é inválido, expirou ou já foi usado.' });
  disconnectUserSockets(reset.user_id);
  res.json({ ok: true });
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
  const members: any[] = db.prepare(`
    SELECT u.id,u.username,u.display_name,u.avatar_icon,u.avatar_color,u.avatar_image,u.last_seen,cm.role
    FROM community_members cm JOIN users u ON u.id = cm.user_id
    WHERE cm.community_id = ? ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,u.display_name
  `).all(communityId) as any[];
  res.json({ members: members.map((member) => ({ ...member, online: onlineUsers.has(member.id) })) });
});

app.patch('/api/communities/:communityId', requireAuth, writeLimiter, (req: AuthRequest, res) => {
  const communityId = String(req.params.communityId);
  if (!isCommunityAdmin(req.user!.id, communityId)) return res.status(403).json({ error: 'Somente administradores podem alterar a comunidade.' });
  const parsed = communityIdentitySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Nome, ícone ou cor da comunidade inválidos.' });
  const current: any = db.prepare('SELECT name,icon,icon_color FROM communities WHERE id = ?').get(communityId);
  if (!current) return res.status(404).json({ error: 'Comunidade não encontrada.' });
  const next = { name: parsed.data.name ?? current.name, icon: parsed.data.icon ?? current.icon, iconColor: parsed.data.iconColor ?? current.icon_color };
  db.prepare('UPDATE communities SET name = ?, icon = ?, icon_color = ? WHERE id = ?').run(next.name, next.icon, next.iconColor, communityId);
  notifyCommunityChanged(communityId);
  res.json({ ok: true, ...next });
});

app.put('/api/communities/:communityId/icon-image', requireAuth, writeLimiter, iconUpload, async (req: AuthRequest, res) => {
  const communityId = String(req.params.communityId);
  if (!isCommunityAdmin(req.user!.id, communityId)) return res.status(403).json({ error: 'Somente administradores podem alterar a imagem da comunidade.' });
  if (!acceptedImageTypes.has(String(req.headers['content-type'] ?? '').split(';')[0])) return res.status(415).json({ error: 'Envie uma imagem PNG, JPG ou WebP.' });
  try {
    const current: any = db.prepare('SELECT icon_image FROM communities WHERE id = ?').get(communityId);
    if (!current) return res.status(404).json({ error: 'Comunidade não encontrada.' });
    const nextImage = await storeIconImage(req.body, `community-${communityId}`);
    db.prepare('UPDATE communities SET icon_image = ? WHERE id = ?').run(nextImage, communityId);
    removeStoredImage(current.icon_image);
    notifyCommunityChanged(communityId);
    res.json({ ok: true, iconImage: nextImage });
  } catch (error: any) {
    if (error?.message === 'IMAGE_TOO_LARGE') return res.status(413).json({ error: 'A imagem deve ter no máximo 2 MB.' });
    res.status(400).json({ error: 'Não foi possível processar esta imagem.' });
  }
});

app.delete('/api/communities/:communityId/icon-image', requireAuth, writeLimiter, (req: AuthRequest, res) => {
  const communityId = String(req.params.communityId);
  if (!isCommunityAdmin(req.user!.id, communityId)) return res.status(403).json({ error: 'Somente administradores podem remover a imagem da comunidade.' });
  const current: any = db.prepare('SELECT icon_image FROM communities WHERE id = ?').get(communityId);
  if (!current) return res.status(404).json({ error: 'Comunidade não encontrada.' });
  db.prepare('UPDATE communities SET icon_image = NULL WHERE id = ?').run(communityId);
  removeStoredImage(current.icon_image);
  notifyCommunityChanged(communityId);
  res.json({ ok: true });
});

app.post('/api/communities/:communityId/invite/rotate', requireAuth, writeLimiter, (req: AuthRequest, res) => {
  const communityId = String(req.params.communityId);
  if (!isCommunityAdmin(req.user!.id, communityId)) return res.status(403).json({ error: 'Somente administradores podem gerar um novo convite.' });
  let next = inviteCode();
  while (db.prepare('SELECT 1 FROM communities WHERE invite_code = ?').get(next)) next = inviteCode();
  db.prepare('UPDATE communities SET invite_code = ? WHERE id = ?').run(next, communityId);
  notifyCommunityChanged(communityId);
  res.json({ ok: true, inviteCode: next });
});

app.patch('/api/communities/:communityId/members/:userId', requireAuth, writeLimiter, (req: AuthRequest, res) => {
  const communityId = String(req.params.communityId);
  const targetUserId = String(req.params.userId);
  const requester = communityMembership(req.user!.id, communityId);
  const target = communityMembership(targetUserId, communityId);
  if (!requester || requester.role !== 'owner') return res.status(403).json({ error: 'Somente o proprietário pode alterar funções.' });
  if (!target) return res.status(404).json({ error: 'Membro não encontrado.' });
  if (target.role === 'owner' || targetUserId === req.user!.id) return res.status(400).json({ error: 'A função do proprietário não pode ser alterada.' });
  const parsed = roleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Função inválida.' });
  db.prepare('UPDATE community_members SET role = ? WHERE community_id = ? AND user_id = ?').run(parsed.data.role, communityId, targetUserId);
  notifyCommunityChanged(communityId);
  res.json({ ok: true });
});

app.delete('/api/communities/:communityId/members/:userId', requireAuth, writeLimiter, (req: AuthRequest, res) => {
  const communityId = String(req.params.communityId);
  const targetUserId = String(req.params.userId);
  const requester = communityMembership(req.user!.id, communityId);
  const target = communityMembership(targetUserId, communityId);
  if (!requester || !target) return res.status(404).json({ error: 'Membro não encontrado.' });
  if (target.role === 'owner') return res.status(400).json({ error: 'O proprietário não pode sair ou ser removido.' });
  const removingSelf = targetUserId === req.user!.id;
  const allowed = removingSelf || requester.role === 'owner' || (requester.role === 'admin' && target.role === 'member');
  if (!allowed) return res.status(403).json({ error: 'Você não pode remover este membro.' });
  db.prepare('DELETE FROM community_members WHERE community_id = ? AND user_id = ?').run(communityId, targetUserId);
  disconnectUserSockets(targetUserId);
  notifyCommunityChanged(communityId);
  res.status(204).end();
});

app.post('/api/communities/:communityId/channels', requireAuth, writeLimiter, (req: AuthRequest, res) => {
  const communityId = String(req.params.communityId);
  if (!isCommunityAdmin(req.user!.id, communityId)) return res.status(403).json({ error: 'Somente administradores podem criar canais.' });
  const parsed = z.object({ name: channelNameSchema, type: z.enum(['text', 'screen']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Nome ou tipo de canal inválido.' });
  const channelId = id();
  const position: any = db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS next FROM channels WHERE community_id = ?').get(communityId);
  try {
    db.prepare('INSERT INTO channels (id,community_id,name,type,position,created_at) VALUES (?,?,?,?,?,?)')
      .run(channelId, communityId, parsed.data.name.toLowerCase().replace(/\s+/g, '-'), parsed.data.type, position.next, new Date().toISOString());
    notifyCommunityChanged(communityId);
    res.status(201).json({ ok: true, id: channelId });
  } catch {
    res.status(409).json({ error: 'Já existe um canal com esse nome.' });
  }
});

app.patch('/api/channels/:channelId', requireAuth, writeLimiter, (req: AuthRequest, res) => {
  const channelId = String(req.params.channelId);
  const channel: any = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) return res.status(404).json({ error: 'Canal não encontrado.' });
  if (!isCommunityAdmin(req.user!.id, channel.community_id)) return res.status(403).json({ error: 'Somente administradores podem editar canais.' });
  const parsed = z.object({ name: channelNameSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Nome do canal inválido.' });
  try {
    const name = parsed.data.name.toLowerCase().replace(/\s+/g, '-');
    db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(name, channelId);
    notifyCommunityChanged(channel.community_id);
    res.json({ ok: true, name });
  } catch {
    res.status(409).json({ error: 'Já existe um canal com esse nome.' });
  }
});

app.delete('/api/channels/:channelId', requireAuth, writeLimiter, (req: AuthRequest, res) => {
  const channelId = String(req.params.channelId);
  const channel: any = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) return res.status(404).json({ error: 'Canal não encontrado.' });
  if (!isCommunityAdmin(req.user!.id, channel.community_id)) return res.status(403).json({ error: 'Somente administradores podem excluir canais.' });
  const count: any = db.prepare('SELECT COUNT(*) AS total FROM channels WHERE community_id = ?').get(channel.community_id);
  if (count.total <= 1) return res.status(400).json({ error: 'A comunidade precisa manter ao menos um canal.' });
  db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
  notifyCommunityChanged(channel.community_id);
  res.status(204).end();
});

app.patch('/api/communities/:communityId/channels/order', requireAuth, writeLimiter, (req: AuthRequest, res) => {
  const communityId = String(req.params.communityId);
  if (!isCommunityAdmin(req.user!.id, communityId)) return res.status(403).json({ error: 'Somente administradores podem reordenar canais.' });
  const parsed = z.object({ channelIds: z.array(z.string().min(1)).min(1).max(200) }).safeParse(req.body);
  if (!parsed.success || new Set(parsed.data.channelIds).size !== parsed.data.channelIds.length) return res.status(400).json({ error: 'Ordem de canais inválida.' });
  const existing: any = db.prepare('SELECT COUNT(*) AS total FROM channels WHERE community_id = ?').get(communityId);
  if (existing.total !== parsed.data.channelIds.length) return res.status(400).json({ error: 'A lista deve incluir todos os canais.' });
  const belongs: any = db.prepare(`SELECT COUNT(*) AS total FROM channels WHERE community_id = ? AND id IN (${parsed.data.channelIds.map(()=>'?').join(',')})`).get(communityId, ...parsed.data.channelIds);
  if (belongs.total !== parsed.data.channelIds.length) return res.status(400).json({ error: 'A lista contém canais inválidos.' });
  const update = db.prepare('UPDATE channels SET position = ? WHERE id = ? AND community_id = ?');
  db.transaction(() => parsed.data.channelIds.forEach((channelId, position) => update.run(position, channelId, communityId)))();
  notifyCommunityChanged(communityId);
  res.json({ ok: true });
});

app.delete('/api/communities/:communityId', requireAuth, writeLimiter, (req: AuthRequest, res) => {
  const communityId = String(req.params.communityId);
  const community: any = db.prepare('SELECT * FROM communities WHERE id = ?').get(communityId);
  if (!community) return res.status(404).json({ error: 'Comunidade não encontrada.' });
  if (community.owner_id !== req.user!.id) return res.status(403).json({ error: 'Somente o proprietário pode excluir a comunidade.' });
  const parsed = z.object({ confirmation: z.string() }).safeParse(req.body);
  if (!parsed.success || parsed.data.confirmation !== community.name) return res.status(400).json({ error: 'Digite o nome exato da comunidade para confirmar.' });
  db.prepare('DELETE FROM communities WHERE id = ?').run(communityId);
  removeStoredImage(community.icon_image);
  notifyCommunityChanged(communityId);
  res.status(204).end();
});

app.get('/api/channels/:channelId/messages', requireAuth, (req: AuthRequest, res) => {
  const channelId = String(req.params.channelId);
  if (!channelAccess(req.user!.id, channelId)) return res.status(403).json({ error: 'Acesso negado.' });
  const before = typeof req.query.before === 'string' ? req.query.before : '9999-12-31T23:59:59.999Z';
  const messages = db.prepare(`
    SELECT m.id,m.channel_id,m.content,m.created_at,m.edited_at,u.id AS author_id,u.username,u.display_name,u.avatar_icon,u.avatar_color,u.avatar_image
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

io = new Server(httpServer, {
  cors: { origin: publicUrl, credentials: true },
  maxHttpBufferSize: 24_000,
  pingInterval: 20_000,
  pingTimeout: 25_000,
});

io.use((socket, next) => {
  const user = userFromCookie(socket.handshake.headers.cookie);
  if (!user) return next(new Error('Não autenticado'));
  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  const user = socket.data.user;
  const userSockets = socketsByUser.get(user.id) ?? new Set<any>();
  userSockets.add(socket);
  socketsByUser.set(user.id, userSockets);
  onlineUsers.set(user.id, (onlineUsers.get(user.id) ?? 0) + 1);
  db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(new Date().toISOString(), user.id);
  notifyPresence(user.id, true);

  socket.on('channel:join', (channelId: string, ack?: Function) => {
    if (!allowSocketEvent(socket.id, 'join', 30, 60_000)) return ack?.({ ok: false, error: 'Muitas mudanças de canal. Aguarde um instante.' });
    const channel = channelAccess(user.id, channelId);
    if (!channel) return ack?.({ ok: false, error: 'Acesso negado.' });
    for (const room of socket.rooms) if (room.startsWith('channel:')) socket.leave(room);
    socket.join(`channel:${channelId}`);
    for (const screen of activeScreens.get(channelId)?.values() ?? []) { const { socketId: _socketId, ...publicScreen } = screen; socket.emit('screen:status', publicScreen); }
    for (const camera of activeCameras.get(channelId)?.values() ?? []) { const { socketId: _socketId, ...publicCamera } = camera; socket.emit('camera:status', publicCamera); }
    ack?.({ ok: true });
  });

  socket.on('media:reserve', (payload: unknown, ack?: Function) => {
    if (!allowSocketEvent(socket.id, 'media-reserve', 12, 60_000)) return ack?.({ ok: false, error: 'Muitas tentativas de mídia. Aguarde um instante.' });
    const parsed = z.object({ channelId: z.string().min(1), kind: z.enum(['screen','camera']) }).safeParse(payload);
    if (!parsed.success) return ack?.({ ok: false, error: 'Reserva de mídia inválida.' });
    const channel = channelAccess(user.id, parsed.data.channelId);
    if (!channel || channel.type !== 'screen') return ack?.({ ok: false, error: 'Sala de mídia inválida.' });
    const kind = parsed.data.kind;
    const existing = mediaReservations.get(channel.id)?.get(user.id);
    if (existing?.socketId === socket.id && existing.kind === kind && existing.expiresAt > Date.now()) return ack?.({ ok: true });
    const active = mediaMap(kind).get(channel.id)?.get(user.id);
    if (active?.socketId === socket.id) return ack?.({ ok: true });
    const limit = kind === 'screen' ? maxActiveScreenStreams : maxActiveCameraStreams;
    if (reservationCount(channel.id, kind, user.id) + (mediaMap(kind).get(channel.id)?.has(user.id) ? 1 : 0) >= limit) {
      return ack?.({ ok: false, error: kind === 'screen' ? 'A sala atingiu o limite operacional de compartilhamentos de tela.' : 'A sala atingiu o limite operacional de câmeras.' });
    }
    const reservations = mediaReservations.get(channel.id) ?? new Map<string, MediaReservation>();
    reservations.set(user.id, { userId: user.id, socketId: socket.id, kind, expiresAt: Date.now() + 60_000 });
    mediaReservations.set(channel.id, reservations);
    ack?.({ ok: true });
  });

  socket.on('media:release', (payload: unknown, ack?: Function) => {
    const parsed = z.object({ channelId: z.string().min(1), kind: z.enum(['screen','camera']) }).safeParse(payload);
    if (!parsed.success || !channelAccess(user.id, parsed.data.channelId)) return ack?.({ ok: false });
    releaseMedia(parsed.data.channelId, user.id, parsed.data.kind, socket.id);
    ack?.({ ok: true });
  });

  socket.on('message:send', (payload: unknown, ack?: Function) => {
    if (!allowSocketEvent(socket.id, 'message', 30, 10_000)) return ack?.({ ok: false, error: 'Você está enviando mensagens rápido demais.' });
    const parsed = z.object({ channelId: z.string().min(1), content: z.string().trim().min(1).max(4000) }).safeParse(payload);
    if (!parsed.success) return ack?.({ ok: false, error: 'Mensagem inválida.' });
    const channel = channelAccess(user.id, parsed.data.channelId);
    if (!channel) return ack?.({ ok: false, error: 'Acesso negado.' });
    const message = {
      id: id(), channel_id: parsed.data.channelId, author_id: user.id,
      username: user.username, display_name: user.display_name,
      avatar_icon: user.avatar_icon, avatar_color: user.avatar_color, avatar_image: user.avatar_image,
      content: parsed.data.content, created_at: new Date().toISOString(), edited_at: null,
    };
    db.prepare('INSERT INTO messages (id,channel_id,author_id,content,created_at) VALUES (?,?,?,?,?)')
      .run(message.id, message.channel_id, message.author_id, message.content, message.created_at);
    io.to(`channel:${message.channel_id}`).emit('message:new', message);
    ack?.({ ok: true, id: message.id });
  });

  socket.on('typing', (payload: unknown) => {
    if (!allowSocketEvent(socket.id, 'typing', 30, 10_000)) return;
    const parsed = z.object({ channelId: z.string(), active: z.boolean() }).safeParse(payload);
    if (!parsed.success || !channelAccess(user.id, parsed.data.channelId)) return;
    socket.to(`channel:${parsed.data.channelId}`).emit('typing', { userId: user.id, displayName: user.display_name, active: parsed.data.active });
  });

  socket.on('camera:status', (payload: unknown) => {
    if (!allowSocketEvent(socket.id, 'camera-status', 20, 10_000)) return;
    const parsed = z.object({ channelId: z.string(), active: z.boolean() }).safeParse(payload);
    if (!parsed.success || !channelAccess(user.id, parsed.data.channelId)) return;
    const cameras = activeCameras.get(parsed.data.channelId) ?? new Map<string, ActiveCamera>();
    if (parsed.data.active) { const reservation=mediaReservations.get(parsed.data.channelId)?.get(user.id); const alreadyActive=cameras.has(user.id); if(!alreadyActive&&(!reservation||reservation.kind!=='camera')){socket.emit('capacity:warning',{kind:'camera',limit:maxActiveCameraStreams,message:'Reserve a câmera antes de publicar.'});return;} if(!alreadyActive&&cameras.size>=maxActiveCameraStreams){socket.emit('capacity:warning',{kind:'camera',limit:maxActiveCameraStreams,message:'Esta sala atingiu o limite operacional de câmeras.'});return;} cameras.set(user.id, { userId:user.id, displayName:user.display_name, active:true, socketId:socket.id }); activeCameras.set(parsed.data.channelId, cameras); }
    else { releaseMedia(parsed.data.channelId, user.id, 'camera', socket.id); }
    io.to(`channel:${parsed.data.channelId}`).emit('camera:status', { userId:user.id, displayName:user.display_name, active:parsed.data.active });
  });

  socket.on('screen:status', (payload: unknown) => {
    if (!allowSocketEvent(socket.id, 'screen-status', 20, 10_000)) return;
    const parsed = z.object({ channelId: z.string(), active: z.boolean(), audioMode: z.enum(['window','system','none']).optional(), surface: z.enum(['browser','window','monitor','unknown']).optional(), hasAudio: z.boolean().optional() }).safeParse(payload);
    if (!parsed.success || !channelAccess(user.id, parsed.data.channelId)) return;
    const screens = activeScreens.get(parsed.data.channelId) ?? new Map<string, ActiveScreen>();
    if (parsed.data.active && parsed.data.audioMode && parsed.data.surface && typeof parsed.data.hasAudio === 'boolean') {
      const alreadyActive = screens.has(user.id);
      const reservation=mediaReservations.get(parsed.data.channelId)?.get(user.id);
      if (!alreadyActive && (!reservation || reservation.kind!=='screen')) { socket.emit('capacity:warning', { kind:'screen', limit:maxActiveScreenStreams, message:'Reserve o compartilhamento antes de publicar.' }); return; }
      if (!alreadyActive && screens.size >= maxActiveScreenStreams) { socket.emit('capacity:warning', { kind:'screen', limit:maxActiveScreenStreams, message:'Esta sala atingiu o limite operacional de compartilhamentos de tela.' }); return; }
      screens.set(user.id, { userId:user.id, displayName:user.display_name, active:true, audioMode:parsed.data.audioMode, surface:parsed.data.surface, hasAudio:parsed.data.hasAudio, socketId:socket.id });
      activeScreens.set(parsed.data.channelId, screens);
    } else {
      releaseMedia(parsed.data.channelId, user.id, 'screen', socket.id);
    }
    io.to(`channel:${parsed.data.channelId}`).emit('screen:status', { userId: user.id, displayName: user.display_name, active: parsed.data.active, audioMode: parsed.data.audioMode, surface: parsed.data.surface, hasAudio: parsed.data.hasAudio });
  });

  socket.on('disconnect', () => {
    for (const [channelId, screens] of activeScreens) { const current=screens.get(user.id); if(current?.socketId===socket.id){releaseMedia(channelId,user.id,'screen',socket.id);io.to(`channel:${channelId}`).emit('screen:status',{userId:user.id,displayName:user.display_name,active:false});} }
    for (const [channelId, cameras] of activeCameras) { const current=cameras.get(user.id); if(current?.socketId===socket.id){releaseMedia(channelId,user.id,'camera',socket.id);io.to(`channel:${channelId}`).emit('camera:status',{userId:user.id,displayName:user.display_name,active:false});} }
    for (const [channelId, reservations] of mediaReservations) { for (const [reservedUserId, reservation] of reservations) if (reservedUserId===user.id && reservation.socketId===socket.id) reservations.delete(reservedUserId); if (!reservations.size) mediaReservations.delete(channelId); }
    const connectedSockets = socketsByUser.get(user.id); connectedSockets?.delete(socket); if (connectedSockets && !connectedSockets.size) socketsByUser.delete(user.id);
    socketEventWindows.delete(socket.id);
    const count = (onlineUsers.get(user.id) ?? 1) - 1;
    if (count <= 0) {
      onlineUsers.delete(user.id);
      db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(new Date().toISOString(), user.id);
      notifyPresence(user.id, false);
    } else onlineUsers.set(user.id, count);
  });
});

purgeExpiredSessions();
setInterval(purgeExpiredSessions, 6 * 60 * 60 * 1000).unref();
db.prepare('DELETE FROM password_reset_tokens WHERE expires_at <= ? OR used_at IS NOT NULL').run(new Date().toISOString());
setInterval(() => db.prepare('DELETE FROM password_reset_tokens WHERE expires_at <= ? OR used_at IS NOT NULL').run(new Date().toISOString()), 60 * 60 * 1000).unref();

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const clientDir = join(__dirname, '../client');
app.use(express.static(clientDir, { maxAge: '1h', index: false }));
app.get('*splat', (_req, res) => res.sendFile(join(clientDir, 'index.html')));

httpServer.listen(port, '0.0.0.0', () => console.log(`TelaHub listening on ${port}`));
