import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Store } from '../database/store.js';
import { forbidden } from './errors.js';

export const permissions = ['status:read', 'system:read', 'projects:read', 'containers:read', 'logs:read', 'admin'] as const;
export type Permission = typeof permissions[number];
export type Platform = 'telegram' | 'whatsapp' | 'dashboard' | 'ai';
export interface Actor { userId: string; permissions: Permission[]; platform: Platform; chatId?: string; group: boolean }
export interface User { id: string; username: string; password_hash: string; permissions: string }

export class IdentityService {
  constructor(private store: Store) {}
  user(id: string) { return this.store.db.prepare('SELECT * FROM users WHERE id=?').get(id) as unknown as User | undefined; }
  actor(userId: string, platform: Platform = 'dashboard'): Actor {
    const user = this.user(userId);
    if (!user) throw forbidden();
    return { userId, platform, permissions: JSON.parse(user.permissions), group: false };
  }
  resolve(platform: 'telegram' | 'whatsapp', sender: string, chat: string, group: boolean): Actor {
    const row = this.store.db.prepare('SELECT user_id FROM identities WHERE platform=? AND sender_id=?')
      .get(platform, sender) as { user_id: string } | undefined;
    if (!row) throw forbidden();
    if (group && !this.store.db.prepare('SELECT 1 FROM chats WHERE platform=? AND chat_id=?').get(platform, chat))
      throw forbidden();
    return { ...this.actor(row.user_id, platform), chatId: chat, group };
  }
  /** Explicit operator-maintained mapping; fail closed on unknown users or duplicate identities. */
  importFile(path: string) {
    const data = z.object({
      identities: z.array(z.object({ platform: z.enum(['telegram', 'whatsapp']), senderId: z.string().min(1), userId: z.string().min(1) }).strict()),
      groups: z.array(z.object({ platform: z.enum(['telegram', 'whatsapp']), chatId: z.string().min(1) }).strict()),
    }).strict().parse(JSON.parse(readFileSync(path, 'utf8')));
    const ids = new Set(data.identities.map(x => `${x.platform}:${x.senderId}`));
    if (ids.size !== data.identities.length || data.identities.some(x => !this.user(x.userId)))
      throw new Error('Identity mapping contains duplicates or unknown OCC user IDs');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db.exec('DELETE FROM identities; DELETE FROM chats;');
      for (const x of data.identities) this.store.db.prepare('INSERT INTO identities VALUES(?,?,?)').run(x.platform, x.senderId, x.userId);
      for (const x of data.groups) this.store.db.prepare('INSERT INTO chats VALUES(?,?)').run(x.platform, x.chatId);
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
}
export function requirePermission(actor: Actor, permission: Permission) {
  if (!actor.permissions.includes(permission) && !actor.permissions.includes('admin')) throw forbidden();
}
