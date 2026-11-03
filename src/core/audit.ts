import { randomUUID } from 'node:crypto';
import type { Store } from '../database/store.js';
import type { Actor } from './identity.js';

export class Audit {
  constructor(private store: Store) {}
  record(action: string, outcome: string, requestId: string, actor?: Actor) {
    this.store.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(
      randomUUID(), actor?.userId ?? null, action, actor?.platform ?? null, actor?.chatId ?? null,
      outcome, requestId, new Date().toISOString(),
    );
  }
  recent() { return this.store.db.prepare('SELECT * FROM audit ORDER BY rowid DESC LIMIT 100').all(); }
}
