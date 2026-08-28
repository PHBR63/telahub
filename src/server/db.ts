import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const databasePath = process.env.DATABASE_PATH ?? './data/telahub.db';
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  avatar_icon TEXT NOT NULL DEFAULT 'user',
  avatar_color TEXT NOT NULL DEFAULT '#766cff',
  avatar_image TEXT,
  password_hash TEXT NOT NULL,
  recovery_code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS communities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  icon TEXT NOT NULL DEFAULT 'users',
  icon_color TEXT NOT NULL DEFAULT '#766cff',
  icon_image TEXT,
  invite_code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS community_members (
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (community_id, user_id)
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('text','screen')),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(community_id, name)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT
);
CREATE TABLE IF NOT EXISTS screen_sessions (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_members_user ON community_members(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
`);

function ensureColumn(table: 'users'|'communities', column: string, definition: string) {
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('users', 'avatar_icon', "TEXT NOT NULL DEFAULT 'user'");
ensureColumn('users', 'avatar_color', "TEXT NOT NULL DEFAULT '#766cff'");
ensureColumn('users', 'avatar_image', 'TEXT');
ensureColumn('communities', 'icon', "TEXT NOT NULL DEFAULT 'users'");
ensureColumn('communities', 'icon_color', "TEXT NOT NULL DEFAULT '#766cff'");
ensureColumn('communities', 'icon_image', 'TEXT');

export type User = {
  id: string;
  email: string;
  username: string;
  display_name: string;
  avatar_icon: string;
  avatar_color: string;
  avatar_image: string | null;
  created_at: string;
  last_seen: string;
};

export function publicUser(row: any): User {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    display_name: row.display_name,
    avatar_icon: row.avatar_icon ?? 'user',
    avatar_color: row.avatar_color ?? '#766cff',
    avatar_image: row.avatar_image ?? null,
    created_at: row.created_at,
    last_seen: row.last_seen,
  };
}

export function isCommunityMember(userId: string, communityId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?').get(communityId, userId));
}

export function channelAccess(userId: string, channelId: string): any {
  return db.prepare(`
    SELECT c.*, cm.role
    FROM channels c
    JOIN community_members cm ON cm.community_id = c.community_id
    WHERE c.id = ? AND cm.user_id = ?
  `).get(channelId, userId);
}
