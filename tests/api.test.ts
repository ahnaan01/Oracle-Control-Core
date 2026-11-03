import { beforeAll, beforeEach, afterEach, expect, it } from 'vitest';
import { hashPassword } from '../src/security/crypto.js';
import { setup, seedUser, login, credentials, password } from './helpers.js';
import type { Application } from '../src/api/app.js';

let hash: string; let core: Application;
beforeAll(async () => { hash = await hashPassword(password); });
beforeEach(async () => { core = await setup(); seedUser(core, hash); });
afterEach(async () => { await core.app.close(); });
it('exposes only minimal health without authentication', async () => {
  const health = await core.app.inject('/sys/api/v1/health');
  expect(health.statusCode).toBe(200); expect(health.json().data).toEqual({ status: 'ok' });
  for (const path of ['system', 'projects', 'containers', 'activity', 'bots', 'settings', 'openapi.json'])
    expect((await core.app.inject(`/sys/api/v1/${path}`)).statusCode).toBe(401);
});
it('hashes passwords, creates HttpOnly sessions, enforces CSRF and revokes logout', async () => {
  expect(hash).not.toContain(password);
  const response = await core.app.inject({ method: 'POST', url: '/sys/api/v1/auth/login',
    headers: { origin: 'http://localhost:3000' }, payload: { username: 'admin', password } });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies[0]!; const csrf = response.json().data.csrf;
  expect(cookie.httpOnly).toBe(true); expect(cookie.sameSite).toBe('Strict'); expect(cookie.path).toBe('/sys');
  const session = { cookie: cookie.value, csrf };
  const stored = core.store.db.prepare('SELECT token_hash FROM sessions').get();
  expect(stored?.token_hash).not.toBe(cookie.value);
  expect((await core.app.inject({ url: '/sys/api/v1/system', headers: credentials(core, session) })).statusCode).toBe(200);
  for (const headers of [ { cookie: `occ_session=${cookie.value}` }, { ...credentials(core, session), origin: 'https://evil.example' } ]) {
    expect((await core.app.inject({ method: 'PATCH', url: '/sys/api/v1/settings', headers, payload: { pollingSeconds: 30 } })).statusCode).toBe(403);
  }
  expect((await core.app.inject({ method: 'PATCH', url: '/sys/api/v1/settings', headers: credentials(core, session), payload: { pollingSeconds: 30 } })).statusCode).toBe(200);
  expect((await core.app.inject({ method: 'POST', url: '/sys/api/v1/auth/logout', headers: credentials(core, session) })).statusCode).toBe(200);
  expect((await core.app.inject({ url: '/sys/api/v1/projects', headers: credentials(core, session) })).statusCode).toBe(401);
});
it('rejects expired sessions and unauthenticated login origins', async () => {
  const session = await login(core);
  core.store.db.prepare('UPDATE sessions SET expires=0').run();
  expect((await core.app.inject({ url: '/sys/api/v1/system', headers: credentials(core, session) })).statusCode).toBe(401);
  expect((await core.app.inject({ method: 'POST', url: '/sys/api/v1/auth/login', payload: { username: 'admin', password } })).statusCode).toBe(403);
});
it('limits login attempts, body size and hides invalid request values', async () => {
  for (let i = 0; i < 5; i++) await core.app.inject({ method: 'POST', url: '/sys/api/v1/auth/login', headers: { origin: core.config.OCC_PUBLIC_ORIGIN }, payload: {} });
  expect((await core.app.inject({ method: 'POST', url: '/sys/api/v1/auth/login', headers: { origin: core.config.OCC_PUBLIC_ORIGIN }, payload: {} })).statusCode).toBe(429);
  expect((await core.app.inject({ method: 'POST', url: '/sys/api/v1/integrations/events', payload: { private: 'x'.repeat(40_000) } })).statusCode).toBe(413);
  expect(JSON.stringify(core.audit.recent())).not.toContain('xxxxxxxx');
});
it('serves dashboard assets and nested routes only under the base path', async () => {
  for (const url of ['/sys', '/sys/monitoring', '/sys/projects', '/sys/bots', '/sys/containers', '/sys/activity', '/sys/settings']) {
    const response = await core.app.inject(url); expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html'); expect(response.body).not.toContain('__OCC_BASE_PATH__');
    const asset = /src="(\/sys\/assets\/[^"]+)"/.exec(response.body)?.[1];
    expect(asset).toBeTruthy(); expect((await core.app.inject(asset!)).statusCode).toBe(200);
  }
  expect((await core.app.inject('/')).statusCode).toBe(404);
  expect((await core.app.inject('/sys/api/v1/not-a-route')).statusCode).toBe(404);
  expect((await core.app.inject('/sys/assets/missing.js')).statusCode).toBe(404);
  for (const url of ['/sys/assets/%2e%2e%2fpackage.json', '/sys/assets/..%2f..%2f.env', '/sys/assets/%252e%252e%252f.env']) {
    const result = await core.app.inject(url); expect(result.statusCode).toBe(404); expect(result.body).not.toContain('oracle-control-core');
  }
});
it('supports another base path without rebuilding the frontend', async () => {
  const custom = await setup({ OCC_BASE_PATH: '/control/occ' });
  try {
    expect((await custom.app.inject('/control/occ/monitoring')).body).toContain('/control/occ/assets/');
    expect((await custom.app.inject('/control/occ/config.js')).body).toContain('"basePath":"/control/occ"');
    expect((await custom.app.inject('/control/occ/api/v1/health')).statusCode).toBe(200);
    expect((await custom.app.inject('/sys')).statusCode).toBe(404);
  } finally { await custom.app.close(); }
});
it('sets security headers and rejects shell commands', async () => {
  const headers = (await core.app.inject('/sys')).headers;
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-content-type-options']).toBe('nosniff');
  const session = await login(core);
  const response = await core.app.inject({ method: 'POST', url: '/sys/api/v1/commands', headers: credentials(core, session), payload: { name: 'exec', args: ['rm', '-rf', '/'] } });
  expect(response.json().data.code).toBe('UNKNOWN_COMMAND');
  expect((await core.app.inject({ method: 'POST', url: '/sys/api/v1/exec', headers: credentials(core, session), payload: { command: 'id' } })).statusCode).toBe(404);
});
it('authenticates each isolated transport separately and reports observed status', async () => {
  const live = await setup({ OCC_MODE: 'live', OCC_TELEGRAM_GATEWAY_TOKEN: 't'.repeat(32), OCC_WHATSAPP_GATEWAY_TOKEN: 'w'.repeat(32) });
  try {
    seedUser(live, hash);
    const request = { method: 'POST' as const, url: '/sys/api/v1/gateway/telegram/commands', payload: { senderId: '123', chatId: 'private', group: false, text: '/status' } };
    expect((await live.app.inject({ ...request, headers: { authorization: `Bearer ${'w'.repeat(32)}` } })).statusCode).toBe(403);
    expect((await live.app.inject({ ...request, headers: { authorization: `Bearer ${'t'.repeat(32)}` } })).json().data.ok).toBe(true);
    expect((await live.app.inject({ method: 'POST', url: '/sys/api/v1/gateway/telegram/status', headers: { authorization: `Bearer ${'t'.repeat(32)}` }, payload: { status: 'connected' } })).statusCode).toBe(200);
    const session = await login(live);
    expect((await live.app.inject({ url: '/sys/api/v1/bots', headers: credentials(live, session) })).json().data[0].status).toBe('connected');
  } finally { await live.app.close(); }
});
