import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, stat, chmod, mkdir, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { prepareSetup } from '../src/operator/setup.js';
import { preflight } from '../src/operator/preflight.js';
import { Store } from '../src/database/store.js';
import { readSecret } from '../src/security/secrets.js';
import { existingRegistration } from '../src/operator/registration.js';

let root: string; let env: NodeJS.ProcessEnv; let adminId: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'occ-operator-'));
  const result = await prepareSetup({ telegramIds: ['123456'], whatsappJids: ['987654@lid'], groups: [{ platform: 'telegram', chatId: '-1001234' }] }, root);
  adminId = result.adminId;
  env = parse(await readFile(join(root, '.env')));
  for (const [key, value] of Object.entries(env)) if (key.endsWith('_FILE') && value?.startsWith('./')) env[key] = join(root, value);
  env.OCC_IDENTITY_FILE = join(root, 'data/operator/identities.json'); env.OCC_DB_PATH = join(root, 'data/occ.sqlite');
  const store = new Store(env.OCC_DB_PATH!); store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(adminId, 'admin', 'disabled-test-hash', '["admin"]'); store.close();
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { recursive: true }); });
it('generates private, separate credentials and refuses to overwrite existing operator state', async () => {
  expect((await stat(join(root, '.env'))).mode & 0o777).toBe(0o600);
  const telegram = readSecret(env, 'OCC_TELEGRAM_GATEWAY_TOKEN'); const whatsapp = readSecret(env, 'OCC_WHATSAPP_GATEWAY_TOKEN');
  expect(telegram).toHaveLength(43); expect(telegram).not.toBe(whatsapp);
  const original = await readFile(join(root, '.env'), 'utf8');
  expect(original).not.toContain(telegram);
  await expect(prepareSetup({}, root)).rejects.toThrow('refusing to overwrite');
  expect(await readFile(join(root, '.env'), 'utf8')).toBe(original);
});
it('rejects a symlinked configuration parent before writing any credentials', async () => {
  const alternate = join(root, 'alternate'); const outside = join(root, 'outside');
  await mkdir(alternate); await mkdir(outside); await symlink(outside, join(alternate, 'data'));
  await expect(prepareSetup({}, alternate)).rejects.toThrow('private real directories');
  expect(await readdir(outside)).toEqual([]);
});
it('validates an existing persistent Phase 1 database without modifying its version or records', async () => {
  const result = await preflight(env, { portCheck: async () => 'free' });
  expect(result.ok).toBe(true); expect(result.checks.find(c => c.id === 'administrator')?.level).toBe('pass');
  const store = new Store(env.OCC_DB_PATH!);
  expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n).toBe(1); store.close();
  expect(JSON.stringify(result)).not.toContain(readSecret(env, 'OCC_TELEGRAM_GATEWAY_TOKEN'));
});
it('detects unsafe permissions, invalid identities, unknown users and local port conflicts', async () => {
  await chmod(env.OCC_IDENTITY_FILE!, 0o644);
  expect((await preflight(env, { portCheck: async () => 'busy' })).ok).toBe(false);
  await chmod(env.OCC_IDENTITY_FILE!, 0o600);
  for (const senderId of ['REPLACE_WITH_ID', 'some-name@s.whatsapp.net']) {
    await writeFile(env.OCC_IDENTITY_FILE!, JSON.stringify({ identities: [{ platform: 'whatsapp', senderId, userId: adminId }], groups: [] }));
    expect((await preflight(env, { skipPort: true })).checks.find(c => c.id === 'identities')?.level).toBe('error');
  }
  await writeFile(env.OCC_IDENTITY_FILE!, JSON.stringify({ identities: [{ platform: 'telegram', senderId: '123', userId: 'unknown' }], groups: [] }));
  expect((await preflight(env, { skipPort: true })).ok).toBe(false);
});
it('detects missing bootstrap/volume and live transport credentials without leaking secrets', async () => {
  const missing = { ...env, OCC_DB_PATH: join(root, 'missing/occ.sqlite') };
  expect((await preflight(missing, { skipPort: true })).checks.find(c => c.id === 'administrator')?.level).toBe('error');
  const live: NodeJS.ProcessEnv = { ...env, OCC_MODE: 'live', OCC_TELEGRAM_ENABLED: 'true' };
  delete live.OCC_TELEGRAM_GATEWAY_TOKEN_FILE;
  expect((await preflight(live, { skipPort: true })).checks.find(c => c.id === 'telegram-gateway')?.level).toBe('error');
  const worker = await preflight({ OCC_MODE: 'live', OCC_CORE_URL: 'http://core:3000/sys/api/v1' }, { role: 'telegram' });
  expect(worker.ok).toBe(false); expect(worker.checks.find(c => c.id === 'telegram-credential')?.level).toBe('error');
  const unsafe = await preflight({ ...env, OCC_PUBLIC_ORIGIN: 'http://public.example' }, { skipPort: true }); expect(unsafe.ok).toBe(false);
  const badUrl = await preflight({ ...env, OCC_MODE: 'live', OCC_CORE_URL: 'http://public.example/sys/api/v1' }, { role: 'telegram' });
  expect(badUrl.checks.find(c => c.id === 'core-url')?.level).toBe('error');
});
it('reports an unreachable Docker collector as a deployment error when probes are requested', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('sensitive error')));
  const result = await preflight({ ...env, OCC_DOCKER_MODE: 'proxy' }, { skipPort: true, probeCollectors: true });
  expect(result.checks.find(c => c.id === 'docker-collector')?.level).toBe('error'); expect(JSON.stringify(result)).not.toContain('sensitive');
});
it('prepares metadata-only registrations from actual operator-supplied resource values', () => {
  const standalone = existingRegistration({ id: 'uptime-kuma', name: 'My monitoring', version: 'operator-version', runtime: 'docker', containerId: 'abcdef123456' });
  expect(standalone.metadata.containerId).toBe('abcdef123456'); expect(standalone.manifest.runtime).toBe('docker');
  const compose = existingRegistration({ id: 'telegramdl', name: 'My downloads', version: 'operator-version', runtime: 'compose', composeProject: 'operator-supplied-project', projectDirectory: '/operator/supplied/path' });
  expect(compose.metadata.composeProject).toBe('operator-supplied-project'); expect(compose.manifest.operations).toEqual([]);
  expect(() => existingRegistration({ id: 'telegramdl', name: 'DL', version: '1', runtime: 'compose' })).toThrow();
});
