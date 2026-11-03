import { beforeAll, beforeEach, afterEach, expect, it } from 'vitest';
import { setup, seedUser, login, credentials, password, manifest } from './helpers.js';
import { hashPassword } from '../src/security/crypto.js';
import { manifestSchema, eventSchema } from '../packages/integration-sdk/src/schema.js';
import type { Application } from '../src/api/app.js';

let core: Application; let hash: string;
beforeAll(async () => { hash = await hashPassword(password); });
beforeEach(async () => { core = await setup(); seedUser(core, hash); });
afterEach(async () => { await core.app.close(); });
it('registers an administrator-approved manifest, issues hashed tokens and supports self-registration', async () => {
  const session = await login(core); const headers = credentials(core, session);
  const registered = await core.app.inject({ method: 'POST', url: '/sys/api/v1/projects', headers, payload: { manifest } });
  expect(registered.statusCode).toBe(201);
  const issued = await core.app.inject({ method: 'POST', url: '/sys/api/v1/projects/test-app/tokens', headers,
    payload: { scopes: ['project:read', 'health:write', 'events:write', 'events:read', 'operations:invoke'] } });
  expect(issued.statusCode).toBe(201);
  const { token, id } = issued.json().data;
  expect(core.store.db.prepare('SELECT token_hash FROM tokens WHERE id=?').get(id)?.token_hash).not.toBe(token);
  const auth = { authorization: `Bearer ${token}` };
  expect((await core.app.inject({ method: 'POST', url: '/sys/api/v1/integrations/register', headers: auth, payload: manifest })).json().data.registered).toBe(true);
  expect((await core.app.inject({ method: 'POST', url: '/sys/api/v1/integrations/health', headers: auth, payload: { status: 'healthy' } })).statusCode).toBe(200);
  expect(core.projects.get('test-app').health).toBe('healthy');
  expect((await core.app.inject({ url: '/sys/api/v1/projects', headers: auth })).statusCode).toBe(401);
  expect(JSON.stringify(core.audit.recent())).not.toContain(token);
  const updated = { ...manifest, eventsPublished: ['test-app.ready', 'test-app.new-capability'] };
  expect((await core.app.inject({ method: 'POST', url: '/sys/api/v1/integrations/register', headers: auth, payload: updated })).statusCode).toBe(403);
  await core.app.inject({ method: 'DELETE', url: `/sys/api/v1/tokens/${id}`, headers });
  expect((await core.app.inject({ url: '/sys/api/v1/integrations/me', headers: auth })).statusCode).toBe(403);
});
it('requires a valid project token, scope and expiry for every integration request', async () => {
  core.projects.register(manifest);
  const read = core.projects.issueToken('test-app', ['project:read'], 1).token;
  expect((await core.app.inject('/sys/api/v1/integrations/me')).statusCode).toBe(401);
  expect((await core.app.inject({ method: 'POST', url: '/sys/api/v1/integrations/health', headers: { authorization: `Bearer ${read}` }, payload: { status: 'healthy' } })).statusCode).toBe(403);
  core.store.db.prepare('UPDATE tokens SET expires=0').run();
  expect((await core.app.inject({ url: '/sys/api/v1/integrations/me', headers: { authorization: `Bearer ${read}` } })).statusCode).toBe(403);
});
it('prevents cross-project access, undeclared events and unapproved operations', async () => {
  core.projects.register(manifest);
  core.projects.register({ ...manifest, id: 'other-app', eventsPublished: [], eventsConsumed: [] });
  const token = core.projects.issueToken('test-app', ['project:read', 'health:write', 'events:write', 'operations:invoke'], 1).token;
  const headers = { authorization: `Bearer ${token}` };
  expect((await core.app.inject({ method: 'POST', url: '/sys/api/v1/integrations/health', headers, payload: { status: 'healthy', projectId: 'other-app' } })).statusCode).toBe(400);
  expect(core.projects.get('other-app').health).toBe('unknown');
  expect((await core.app.inject({ method: 'POST', url: '/sys/api/v1/integrations/events', headers, payload: { type: 'other-app.ready', payload: {}, idempotencyKey: 'key12345' } })).statusCode).toBe(403);
  expect((await core.app.inject({ method: 'POST', url: '/sys/api/v1/integrations/operations/health/invoke', headers, payload: {} })).statusCode).toBe(403);
  core.projects.approve('test-app', 'health');
  expect((await core.app.inject({ method: 'POST', url: '/sys/api/v1/integrations/operations/health/invoke', headers, payload: {} })).json().data.status).toBe('unknown');
});
it('persists metadata events idempotently, validates payloads and filters subscriptions', async () => {
  core.projects.register(manifest);
  const token = core.projects.issueToken('test-app', ['events:write', 'events:read'], 1).token;
  const headers = { authorization: `Bearer ${token}` };
  const payload = { type: 'test-app.ready', payload: { status: 'ready' }, idempotencyKey: 'test-key-1' };
  let calls = 0; core.events.bus.on('test-app.ready', () => calls++);
  const send = (body: unknown) => core.app.inject({ method: 'POST', url: '/sys/api/v1/integrations/events', headers, payload: body as object });
  const first = await send(payload); const second = await send(payload);
  expect(first.json().data.id).toBe(second.json().data.id); expect(second.json().data.duplicate).toBe(true);
  expect(calls).toBe(1);
  expect((await send({ ...payload, payload: { status: 'changed' } })).statusCode).toBe(409);
  expect((await send({ ...payload, payload: { chatBody: 'unrelated secret' } })).statusCode).toBe(400);
  const received = await core.app.inject({ url: '/sys/api/v1/integrations/events', headers });
  expect(received.json().data).toHaveLength(1);
  expect(JSON.stringify(core.store.db.prepare('SELECT * FROM events').all())).not.toContain('unrelated secret');
});
it('rejects invalid manifests, credentials, dangerous operations and cross-namespace declarations', () => {
  for (const raw of [ { ...manifest, protocolVersion: '2.0' }, { ...manifest, token: 'secret' },
    { ...manifest, healthEndpoint: 'https://user:secret@example.com/' }, { ...manifest, eventsPublished: ['other-app.ready'] },
    { ...manifest, operations: [{ name: 'shell', kind: 'shell', readOnly: false }] },
    { ...manifest, operations: [...manifest.operations, ...manifest.operations] } ]) expect(manifestSchema.safeParse(raw).success).toBe(false);
  expect(eventSchema.safeParse({ type: 'test-app.ready', payload: { body: 'chat' }, idempotencyKey: '12345678' }).success).toBe(false);
});
it('supports manual standalone and Compose registrations without any infrastructure calls', () => {
  core.projects.register({ ...manifest, runtime: 'docker' }, { containerId: 'operator-chosen-id', projectDirectory: '/custom/path' });
  core.projects.register({ ...manifest, id: 'compose-app', runtime: 'compose', eventsPublished: [], eventsConsumed: [] }, { composeProject: 'operator-project', configurationLocations: ['/different/compose.yml'] });
  expect(core.projects.list()).toHaveLength(2);
  expect(core.projects.get('compose-app').metadata.composeProject).toBe('operator-project');
  expect(() => core.projects.register(manifest)).toThrow('already registered');
});
