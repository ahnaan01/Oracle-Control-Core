import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../database/store.js';
import { manifestSchema, metadataSchema, type Manifest, type Scope } from '../../packages/integration-sdk/src/schema.js';
import { hashToken, randomToken } from '../security/crypto.js';
import { OccError, forbidden } from './errors.js';

interface Row { id: string; manifest: string; metadata: string; health: string; last_check: string | null; created_at: string }
export interface Project { id: string; manifest: Manifest; metadata: z.infer<typeof metadataSchema>; health: string; lastCheck: string | null; createdAt: string }
const unpack = (row: Row): Project => ({ id: row.id, manifest: JSON.parse(row.manifest), metadata: JSON.parse(row.metadata),
  health: row.health, lastCheck: row.last_check, createdAt: row.created_at });
export class Projects {
  constructor(private store: Store) {}
  list(): Project[] { return (this.store.db.prepare('SELECT * FROM projects ORDER BY id').all() as unknown as Row[]).map(unpack); }
  get(id: string): Project {
    const row = this.store.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as unknown as Row | undefined;
    if (!row) throw new OccError('NOT_FOUND', 'Project not found', 404);
    return unpack(row);
  }
  register(raw: unknown, rawMetadata: unknown = {}): Project {
    const manifest = manifestSchema.parse(raw); const metadata = metadataSchema.parse(rawMetadata);
    if (this.store.db.prepare('SELECT 1 FROM projects WHERE id=?').get(manifest.id))
      throw new OccError('CONFLICT', 'Project already registered', 409);
    this.store.db.prepare('INSERT INTO projects(id,manifest,metadata,created_at) VALUES(?,?,?,?)')
      .run(manifest.id, JSON.stringify(manifest), JSON.stringify(metadata), new Date().toISOString());
    return this.get(manifest.id);
  }
  report(id: string, status: string) {
    this.get(id);
    this.store.db.prepare('UPDATE projects SET health=?,last_check=? WHERE id=?').run(status, new Date().toISOString(), id);
    return this.get(id);
  }
  issueToken(projectId: string, scopes: Scope[], expiresDays: number) {
    this.get(projectId);
    const id = randomUUID(); const token = `occ_${randomToken()}`;
    this.store.db.prepare('INSERT INTO tokens(id,project_id,token_hash,scopes,expires) VALUES(?,?,?,?,?)')
      .run(id, projectId, hashToken(token), JSON.stringify(scopes), Date.now() + expiresDays * 86_400_000);
    return { id, token, projectId, scopes };
  }
  authenticate(token: string, scope: Scope) {
    const row = this.store.db.prepare('SELECT project_id,scopes FROM tokens WHERE token_hash=? AND revoked=0 AND expires>?')
      .get(hashToken(token), Date.now()) as { project_id: string; scopes: string } | undefined;
    if (!row || !(JSON.parse(row.scopes) as string[]).includes(scope)) throw forbidden();
    return row.project_id;
  }
  revoke(tokenId: string) { this.store.db.prepare('UPDATE tokens SET revoked=1 WHERE id=?').run(tokenId); }
  approve(projectId: string, operation: string) {
    if (!this.get(projectId).manifest.operations.some(op => op.name === operation))
      throw new OccError('NOT_FOUND', 'Operation not declared', 404);
    this.store.db.prepare('INSERT OR IGNORE INTO approvals VALUES(?,?)').run(projectId, operation);
  }
  operations(projectId: string) {
    return this.get(projectId).manifest.operations.map(op => ({ ...op, approved: !!this.store.db.prepare(
      'SELECT 1 FROM approvals WHERE project_id=? AND operation=?').get(projectId, op.name) }));
  }
  invoke(projectId: string, operation: string) {
    const op = this.operations(projectId).find(op => op.name === operation && op.approved);
    if (!op) throw forbidden();
    const project = this.get(projectId);
    // Only cached read-only operations in Phase 1. Never execute a manifest URL or shell command.
    return op.kind === 'health' ? { status: project.health, lastCheck: project.lastCheck } : { id: project.id, version: project.manifest.version, health: project.health };
  }
}
