import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostCollector, parseMeminfo } from '../src/services/host/collector.js';
import { CgroupMonitor, parseCgroup } from '../src/services/cgroup.js';
import { SystemMonitor } from '../src/services/system.js';
import { loadConfig } from '../src/config.js';
import { setup, seedUser } from './helpers.js';
import { metricView } from '../dashboard/src/metrics.js';
import { monitorServer } from '../src/services/monitor-server.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const token = 'test-monitor-credential-1234567890';
it('parses MemAvailable rather than confusing free memory with usable memory', () => {
  expect(parseMeminfo('MemTotal: 100 kB\nMemAvailable: 40 kB\nMemFree: 10 kB\n')).toEqual({ totalBytes: 102400, availableBytes: 40960, usedBytes: 61440 });
  expect(() => parseMeminfo('MemTotal: 100 kB')).toThrow();
});
it('collects only fixed host counter files and a selected filesystem with CPU deltas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'occ-host-'));
  try {
    for (const [name, text] of Object.entries({ stat: 'cpu  10 0 10 80 0 0 0 0\ncpu0 10 0 10 80\n', meminfo: 'MemTotal: 100 kB\nMemAvailable: 40 kB\n', uptime: '120.5 500', loadavg: '0.1 0.2 0.3 1/20 5', netdev: 'header\nheader\n eth0: 10 0 0 0 0 0 0 0 20 0 0 0 0 0 0 0\n' })) await writeFile(join(root, name), text);
    const disk = vi.fn().mockResolvedValue({ blocks: 100, bavail: 20, bfree: 25, bsize: 1024 }) as unknown as typeof statfs;
    const collector = new HostCollector(root, undefined, disk);
    const first = await collector.snapshot();
    expect(first.scope).toBe('host'); expect(first.cpu.usagePercent).toBeNull();
    expect(first.disk?.usedBytes).toBe(76800); expect(first.memory.availableBytes).toBe(40960);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 6000);
    await writeFile(join(root, 'stat'), 'cpu  30 0 10 160 0 0 0 0\ncpu0 30 0 10 160\n');
    expect((await collector.snapshot()).cpu.usagePercent).toBeCloseTo(20);
  } finally { await rm(root, { recursive: true }); }
});
it('separates bounded cgroup counters from host totals and handles unlimited limits', async () => {
  expect(parseCgroup('25', '100', '50000 100000', 'usage_usec 123')).toEqual({ memory: { usedBytes: 25, totalBytes: 100, availableBytes: 75 }, cpu: { cores: 0.5, usageUsec: 123 } });
  expect(parseCgroup('25', 'max', 'max 100000', 'usage_usec 123').memory.totalBytes).toBeNull();
  const missing = vi.fn().mockRejectedValue(new Error('missing'));
  expect((await new CgroupMonitor(missing).snapshot()).available).toBe(false);
});
function hostData(at = new Date().toISOString()) { return { protocolVersion: '1.0', scope: 'host', source: 'isolated-procfs-collector', sampledAt: at,
  cpu: { cores: 2, usagePercent: 10, load: [0, 0, 0] }, memory: { totalBytes: 100, availableBytes: 60, usedBytes: 40 }, disk: null, network: null, uptimeSeconds: 123 }; }
it('requires fresh authenticated collector data and labels disabled/stale collectors unavailable', async () => {
  expect(() => loadConfig({ OCC_HOST_MONITOR_URL: 'http://public.example:2376' })).toThrow('require HTTPS');
  const http = vi.fn().mockResolvedValue(new Response(JSON.stringify(hostData()))); vi.stubGlobal('fetch', http);
  const config = loadConfig({ OCC_HOST_MONITOR_MODE: 'collector', OCC_HOST_MONITOR_URL: 'http://host-monitor:2376', OCC_HOST_MONITOR_TOKEN: token });
  const metrics = await new SystemMonitor(config).snapshot();
  expect(metrics.host.available).toBe(true); expect(metrics.process.scope).toBe('occ-process'); expect(metrics.scope).toContain('not confirmed');
  expect(http.mock.calls[0]?.[1].headers.authorization).toBe(`Bearer ${token}`);
  expect(metricView(metrics).source).toContain('Host'); expect(metricView(metrics).memory?.totalBytes).toBe(100);
  http.mockResolvedValue(new Response(JSON.stringify(hostData('2000-01-01T00:00:00.000Z'))));
  const stale = await new SystemMonitor(config).snapshot(); expect(stale.host.available).toBe(false); expect(stale.host.metrics).toBeNull();
  http.mockRejectedValue(new Error('private connection error'));
  expect((await new SystemMonitor(config).snapshot()).host.reason).not.toContain('private');
  expect((await new SystemMonitor().snapshot()).host.reason).toBe('Host collector disabled');
});
it('keeps groups minimal, private status scoped and low-permission status non-sensitive', async () => {
  const core = await setup(); seedUser(core, 'disabled');
  try {
    const group = await core.dispatch('telegram', { senderId: '123', chatId: 'allowed-group', group: true, text: '/status' });
    expect(group?.data).toEqual({ status: 'ok', version: '0.1.1' });
    const privateStatus = await core.dispatch('telegram', { senderId: '123', chatId: 'private', group: false, text: '/status' });
    expect(privateStatus?.data).toMatchObject({ projects: 0, docker: { available: false }, host: { available: false }, process: { scope: 'occ-process' } });
    core.store.db.prepare('UPDATE users SET permissions=?').run('["status:read"]');
    const limited = await core.router.execute('status', [], core.identities.actor('admin-id'));
    expect(limited.data).not.toHaveProperty('host'); expect(limited.data).not.toHaveProperty('docker'); expect(limited.data).not.toHaveProperty('projects');
  } finally { await core.app.close(); }
});
it('rejects unauthenticated collector requests without reading host/Docker data', async () => {
  const collect = vi.fn().mockResolvedValue({}); const server = monitorServer(token, '/metrics', collect);
  const request = (authorization?: string) => new Promise<number>(resolve => {
    let status = 200;
    server.emit('request', { method: 'GET', url: '/metrics', headers: { authorization } } as IncomingMessage,
      { setHeader() {}, writeHead(code: number) { status = code; }, end() { resolve(status); } } as unknown as ServerResponse);
  });
  expect(await request()).toBe(401); expect(collect).not.toHaveBeenCalled();
  expect(await request(`Bearer ${token}`)).toBe(200); expect(collect).toHaveBeenCalledOnce();
});
