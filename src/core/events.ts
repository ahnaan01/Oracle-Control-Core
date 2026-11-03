import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Store } from '../database/store.js';
import type { Projects } from './projects.js';
import { eventSchema } from '../../packages/integration-sdk/src/schema.js';
import { forbidden, OccError } from './errors.js';

export class Events {
  readonly bus = new EventEmitter();
  constructor(private store: Store, private projects: Projects) {}
  publish(projectId: string, raw: unknown) {
    const event = eventSchema.parse(raw);
    if (!this.projects.get(projectId).manifest.eventsPublished.includes(event.type)) throw forbidden();
    const existing = this.store.db.prepare('SELECT * FROM events WHERE project_id=? AND idempotency_key=?')
      .get(projectId, event.idempotencyKey);
    if (existing) {
      if (existing.type !== event.type || existing.payload !== JSON.stringify(event.payload))
        throw new OccError('CONFLICT', 'Idempotency key reused with different data', 409);
      return { id: existing.id as string, duplicate: true };
    }
    const id = randomUUID();
    this.store.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)').run(
      id, projectId, event.type, JSON.stringify(event.payload), event.idempotencyKey, new Date().toISOString());
    // Listener failures must not roll back accepted events or trigger duplicate deliveries.
    for (const listener of this.bus.listeners(event.type)) {
      try { listener({ id, projectId, ...event }); } catch { /* consumers must handle their own retry */ }
    }
    return { id, duplicate: false };
  }
  subscribed(projectId: string) {
    const permitted = this.projects.get(projectId).manifest.eventsConsumed;
    return this.store.db.prepare('SELECT id,type,payload,created_at FROM events WHERE project_id=? ORDER BY rowid DESC LIMIT 100')
      .all(projectId).filter(e => permitted.includes(e.type as string)).map(e => ({ ...e, payload: JSON.parse(e.payload as string) }));
  }
}
