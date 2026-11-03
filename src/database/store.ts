import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

/** Parameterized SQL only. Never persist incoming conversation bodies. */
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 1) throw new Error('Database is newer than this application');
    if (version < 1) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
        permissions TEXT NOT NULL);
      CREATE TABLE identities(platform TEXT NOT NULL, sender_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
        PRIMARY KEY(platform,sender_id));
      CREATE TABLE chats(platform TEXT NOT NULL, chat_id TEXT NOT NULL, PRIMARY KEY(platform,chat_id));
      CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE projects(id TEXT PRIMARY KEY, manifest TEXT NOT NULL, metadata TEXT NOT NULL,
        health TEXT NOT NULL DEFAULT 'unknown', last_check TEXT, created_at TEXT NOT NULL);
      CREATE TABLE tokens(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        token_hash TEXT UNIQUE NOT NULL, scopes TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE approvals(project_id TEXT NOT NULL REFERENCES projects(id), operation TEXT NOT NULL,
        PRIMARY KEY(project_id,operation));
      CREATE TABLE tasks(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, command TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE audit(id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, platform TEXT,
        chat_id TEXT, outcome TEXT NOT NULL, request_id TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE events(id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), type TEXT NOT NULL,
        payload TEXT NOT NULL, idempotency_key TEXT, created_at TEXT NOT NULL,
        UNIQUE(project_id,idempotency_key));
      CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1;
      COMMIT;
    `);
  }
  cleanup(days: number, now = Date.now()) {
    const cutoff = new Date(now - days * 86_400_000).toISOString();
    this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(now);
    for (const table of ['audit', 'events', 'tasks'])
      this.db.prepare(`DELETE FROM ${table} WHERE created_at < ?`).run(cutoff);
    this.db.prepare('DELETE FROM tokens WHERE expires <= ? OR revoked = 1').run(now);
    // Count caps bound storage even under sustained valid traffic between cleanup runs.
    for (const table of ['audit', 'events', 'tasks'])
      this.db.exec(`DELETE FROM ${table} WHERE rowid NOT IN (SELECT rowid FROM ${table} ORDER BY rowid DESC LIMIT 10000)`);
  }
  close() { this.db.close(); }
}
