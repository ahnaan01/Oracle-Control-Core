import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/database/store.js';
import { SystemMonitor, parseNetwork } from '../src/services/system.js';
import { DockerMonitor, parseContainers } from '../src/services/docker.js';
import { loadConfig } from '../src/config.js';
import { resolveProjectPath } from '../src/services/files.js';
import { IdentityService } from '../src/core/identity.js';
import { OccClient } from '../packages/integration-sdk/src/index.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMonitorServer } from '../src/services/docker/monitor-worker.js';
afterEach(() => vi.unstubAllGlobals());
it('parses Linux network counters and rejects malformed lines', () => {
  const text = 'header\nheader\n eth0: 10 1 0 0 0 0 0 0 20 1 0 0 0 0 0 0\n bad: x\n';
  expect(parseNetwork(text)).toEqual([{ interface: 'eth0', receivedBytes: 10, transmittedBytes: 20 }]);
});
it('collects real runtime metrics and reuses a bounded sampling cache', async () => {
  const monitor = new SystemMonitor(); const metrics = await monitor.snapshot();
  expect(metrics.memory.totalBytes).toBeGreaterThan(0); expect(metrics.uptimeSeconds).toBeGreaterThan(0);
  expect(metrics.os).toBe(process.platform); expect(metrics.architecture).toBe(process.arch);
  expect(metrics.scope).toContain('runtime'); expect(await monitor.snapshot()).toBe(metrics);
});
it('identifies standalone, Compose and health labels without exposing arbitrary labels', () => {
  const common = { Image: 'example/app', State: 'running', Status: 'Up (healthy)' };
  const parsed = parseContainers([{ ...common, Id: 'a', Names: ['/standalone'], Labels: { SECRET: 'must-not-leak' } },
    { ...common, Id: 'b', Names: ['/composed'], Labels: { 'com.docker.compose.project': 'downloads', 'com.docker.compose.service': 'dl' } }]);
  expect(parsed[0]?.composeProject).toBeNull(); expect(parsed[1]?.composeProject).toBe('downloads');
  expect(parsed[1]?.health).toBe('healthy'); expect(JSON.stringify(parsed)).not.toContain('must-not-leak');
});
it('never calls Docker by default and clearly labels mock data', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect((await new DockerMonitor(loadConfig({})).list()).available).toBe(false); expect(fetch).not.toHaveBeenCalled();
  const mock = await new DockerMonitor(loadConfig({ OCC_DOCKER_MODE: 'mock' })).list();
  expect(mock.mode).toBe('mock'); expect(mock.containers).toHaveLength(2); expect(fetch).not.toHaveBeenCalled();
  expect(() => loadConfig({ OCC_MODE: 'live', OCC_DOCKER_MODE: 'mock' })).toThrow();
});
it('reports monitor errors as unavailable rather than inventing container data', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('private network detail'));
  vi.stubGlobal('fetch', fetch);
  const result = await new DockerMonitor(loadConfig({ OCC_DOCKER_MODE: 'proxy', OCC_DOCKER_PROXY_URL: 'http://docker-monitor:2375' })).list();
  expect(result.available).toBe(false); expect(result.containers).toEqual([]); expect(result.reason).not.toContain('private');
});
it('restricts the Docker sidecar to one exact inventory route', async () => {
  const server = createMonitorServer();
  for (const [method, url] of [['POST', '/containers'], ['GET', '/containers/json'], ['POST', '/containers/abc/restart'], ['GET', '/containers?path=/info']]) {
    let status = 200;
    const body = await new Promise<string>(resolve => server.emit('request', { method, url } as IncomingMessage, {
      setHeader: () => {}, writeHead: (code: number) => { status = code; }, end: (text: string) => resolve(text),
    } as unknown as ServerResponse));
    expect(status).toBe(404); expect(body).toContain('NOT_FOUND');
  }
});
it('rejects unsafe public origins and SDK destinations', () => {
  expect(() => loadConfig({ OCC_PUBLIC_ORIGIN: 'http://public.example' })).toThrow();
  expect(() => loadConfig({ OCC_BASE_PATH: '/sys/../admin' })).toThrow();
  expect(() => loadConfig({ OCC_PUBLIC_ORIGIN: 'https://public.example', OCC_SECURE_COOKIES: 'true' })).not.toThrow();
  expect(() => loadConfig({ OCC_TELEGRAM_GATEWAY_TOKEN: '', OCC_WHATSAPP_GATEWAY_TOKEN: '' })).not.toThrow();
  expect(() => loadConfig({ OCC_TELEGRAM_GATEWAY_TOKEN: 'a'.repeat(32), OCC_WHATSAPP_GATEWAY_TOKEN: 'a'.repeat(32) })).toThrow();
  expect(() => new OccClient('http://public.example/sys/api/v1', 'test')).toThrow();
});
it('blocks path traversal, absolute paths and symlink escapes', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'occ-path-')); const root = join(temp, 'project');
  try {
    await mkdir(root); await writeFile(join(root, 'allowed.txt'), 'safe'); await writeFile(join(temp, 'outside.txt'), 'outside');
    await symlink(join(temp, 'outside.txt'), join(root, 'escape'));
    expect(await resolveProjectPath(root, 'allowed.txt')).toBe(join(root, 'allowed.txt'));
    await expect(resolveProjectPath(root, '../outside.txt')).rejects.toThrow();
    await expect(resolveProjectPath(root, 'escape')).rejects.toThrow();
    await expect(resolveProjectPath(root, '/etc/passwd')).rejects.toThrow();
  } finally { await rm(temp, { recursive: true }); }
});
it('retains SQLite data across migration reruns and cleans only expired operational records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'occ-db-')); const file = join(directory, 'occ.sqlite');
  try {
    let store = new Store(file);
    store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('u', 'user', 'hash', '["admin"]');
    store.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run('old', 'u', 'test', null, null, 'ok', 'id', '2000-01-01T00:00:00.000Z');
    store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('expired', 'u', 'csrf', 0);
    store.close(); store = new Store(file);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n).toBe(1);
    store.cleanup(30); expect(store.db.prepare('SELECT COUNT(*) AS n FROM audit').get()?.n).toBe(0);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.n).toBe(0);
    expect((await stat(file)).mode & 0o777).toBe(0o600); store.close();
  } finally { await rm(directory, { recursive: true }); }
});
it('imports explicit platform links atomically and never merges identities heuristically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'occ-identities-')); const path = join(directory, 'identities.json');
  const store = new Store(':memory:'); const identities = new IdentityService(store);
  try {
    store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('internal-id', 'admin', 'hash', '["admin"]');
    const data = { identities: [{ platform: 'telegram', senderId: '123', userId: 'internal-id' }, { platform: 'whatsapp', senderId: 'exact@lid', userId: 'internal-id' }], groups: [{ platform: 'whatsapp', chatId: 'group@g.us' }] };
    await writeFile(path, JSON.stringify(data)); identities.importFile(path);
    expect(identities.resolve('telegram', '123', '123', false).userId).toBe(identities.resolve('whatsapp', 'exact@lid', 'group@g.us', true).userId);
    expect(() => identities.resolve('whatsapp', '123@s.whatsapp.net', 'private', false)).toThrow();
    await writeFile(path, JSON.stringify({ ...data, identities: [{ platform: 'telegram', senderId: '123', userId: 'missing' }] }));
    expect(() => identities.importFile(path)).toThrow();
    expect(identities.resolve('telegram', '123', '123', false).userId).toBe('internal-id');
  } finally { store.close(); await rm(directory, { recursive: true }); }
});
