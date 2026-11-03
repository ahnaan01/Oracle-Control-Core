import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { createApp } from '../../src/api/app.js';
import { loadConfig } from '../../src/config.js';
import { OccClient, manifestSchema } from '../../packages/integration-sdk/src/index.js';
import { MockMessagingAdapter } from '../../src/adapters/gateway.js';

// Entire demo is disposable: in-memory DB, local HTTP only, mock transports and Docker.
const core = await createApp(loadConfig({ OCC_DB_PATH: ':memory:', OCC_DOCKER_MODE: 'mock' }));
try {
  const manifest = manifestSchema.parse(JSON.parse(await readFile('examples/sample-integration/manifest.json', 'utf8')));
  core.projects.register(manifest); // Explicit administrator provisioning, not anonymous registration.
  core.projects.approve(manifest.id, 'health');
  const { token } = core.projects.issueToken(manifest.id, manifest.requiredPermissions, 1);
  const address = await core.app.listen({ host: '127.0.0.1', port: 0 });
  const sdk = new OccClient(`${address}/sys/api/v1`, token);
  assert.equal((await sdk.register(manifest)).registered, true);
  assert.equal((await sdk.reportHealth('healthy')).status, 'healthy');
  const key = randomUUID();
  const published = await sdk.publish('sample-app.ready', { status: 'ready' }, key);
  assert.equal((await sdk.publish('sample-app.ready', { status: 'ready' }, key)).duplicate, true);
  assert.equal((await sdk.events())[0]?.id, published.id);
  assert.deepEqual(await sdk.invoke('health'), { status: 'healthy', lastCheck: core.projects.get(manifest.id).lastCheck });
  const userId = randomUUID();
  core.store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(userId, 'demo', 'disabled', JSON.stringify(['admin']));
  core.store.db.prepare('INSERT INTO identities VALUES(?,?,?)').run('telegram', '10001', userId);
  core.store.db.prepare('INSERT INTO identities VALUES(?,?,?)').run('whatsapp', '10001@s.whatsapp.net', userId);
  for (const platform of ['telegram', 'whatsapp'] as const) {
    const adapter = new MockMessagingAdapter(platform, core.dispatch);
    const message = { senderId: platform === 'telegram' ? '10001' : '10001@s.whatsapp.net', chatId: 'demo-private', group: false, text: '/status' };
    assert.equal((await adapter.receive(message))?.ok, true);
    assert.equal(await adapter.receive({ ...message, text: 'An ordinary private conversation' }), null);
  }
  console.log('PASS: local SDK registration, health, event idempotency, subscription, approved operation, and shared mock messaging. No external services contacted.');
} finally { await core.app.close(); }
