import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { db, publicUser, type User } from './db.js';

const SESSION_DAYS = 30;
const COOKIE_NAME = 'telahub_session';

export function id(): string {
  return randomBytes(16).toString('hex');
}

export function inviteCode(): string {
  return randomBytes(4).toString('hex').toUpperCase();
}

export function recoveryCode(): string {
  return randomBytes(8).toString('hex').toUpperCase();
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [saltHex, hashHex] = stored.split(':');
    const candidate = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
    const expected = Buffer.from(hashHex, 'hex');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

function cookies(header = ''): Record<string, string> {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((pair) => pair.length === 2));
}

export function createSession(res: Response, userId: string): void {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, now.toISOString(), expires.toISOString());
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}

export function destroySession(req: Request, res: Response): void {
  const token = cookies(req.headers.cookie)[COOKIE_NAME];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=0`);
}

export function userFromCookie(cookieHeader?: string): User | null {
  const token = cookies(cookieHeader)[COOKIE_NAME];
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.* FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(sha256(token), new Date().toISOString());
  return row ? publicUser(row) : null;
}

export type AuthRequest = Request & { user?: User };

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const user = userFromCookie(req.headers.cookie);
  if (!user) {
    res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    return;
  }
  req.user = user;
  next();
}

export function sameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const expected = process.env.PUBLIC_APP_URL;
  let expectedOrigin = '';
  try { expectedOrigin = expected ? new URL(expected).origin : ''; } catch { expectedOrigin = ''; }
  const origin = req.headers.origin || (req.headers.referer ? (() => { try { return new URL(req.headers.referer).origin; } catch { return ''; } })() : '');
  if (!expectedOrigin || origin !== expectedOrigin) {
    res.status(403).json({ error: 'Origem não autorizada.' });
    return;
  }
  next();
}

export function purgeExpiredSessions(): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
}
