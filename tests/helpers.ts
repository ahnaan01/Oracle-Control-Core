import { createApp } from '../src/api/app.js';
import { loadConfig } from '../src/config.js';
import type { Application } from '../src/api/app.js';
import type { User } from '../src/core/identity.js';
import { manifestSchema } from '../packages/integration-sdk/src/schema.js';

export const password = 'test-only-password-never-use-live';
export const manifest = manifestSchema.parse({ protocolVersion: '1.0', id: 'test-app', name: 'Test app', version: '1', runtime: 'external',
  eventsPublished: ['test-app.ready'], eventsConsumed: ['test-app.ready'],
  operations: [{ name: 'health', description: 'Cached health', kind: 'health', readOnly: true, permission: 'project:read' }] });
export async function setup(extra: NodeJS.ProcessEnv = {}) {
  const core = await createApp(loadConfig({ OCC_DB_PATH: ':memory:', ...extra }));
  await core.app.ready();
  return core;
}
export function seedUser(core: Application, passwordHash: string) {
  core.store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('admin-id', 'admin', passwordHash, JSON.stringify(['admin']));
  core.store.db.prepare('INSERT INTO identities VALUES(?,?,?)').run('telegram', '123', 'admin-id');
  core.store.db.prepare('INSERT INTO identities VALUES(?,?,?)').run('whatsapp', '123@s.whatsapp.net', 'admin-id');
  for (const platform of ['telegram', 'whatsapp']) core.store.db.prepare('INSERT INTO chats VALUES(?,?)').run(platform, 'allowed-group');
}
export async function login(core: Application) {
  const response = await core.app.inject({ method: 'POST', url: `${core.config.OCC_BASE_PATH}/api/v1/auth/login`,
    headers: { origin: core.config.OCC_PUBLIC_ORIGIN }, payload: { username: 'admin', password } });
  if (response.statusCode !== 200) throw new Error(`Login failed: ${response.body}`);
  return { cookie: response.cookies.find(c => c.name === 'occ_session')!.value,
    csrf: response.json().data.csrf as string };
}
export function credentials(core: Application, session: { cookie: string; csrf: string }) {
  return { cookie: `occ_session=${session.cookie}`, 'x-csrf-token': session.csrf, origin: core.config.OCC_PUBLIC_ORIGIN };
}
export function userRecord(core: Application) { return core.store.db.prepare('SELECT * FROM users WHERE id=?').get('admin-id') as unknown as User; }
