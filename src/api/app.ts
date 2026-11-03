import Fastify, { LogController, type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config.js';
import { Store } from '../database/store.js';
import { IdentityService, requirePermission, type Actor, type User } from '../core/identity.js';
import { Projects } from '../core/projects.js';
import { Events } from '../core/events.js';
import { Audit } from '../core/audit.js';
import { CommandRouter } from '../core/commands.js';
import { createDispatch } from '../adapters/gateway.js';
import { SystemMonitor } from '../services/system.js';
import { DockerMonitor } from '../services/docker.js';
import { OccError, forbidden } from '../core/errors.js';
import { equal, randomToken, hashToken, verifyPassword } from '../security/crypto.js';
import { manifestSchema, metadataSchema, scopes, healthSchema, eventSchema } from '../../packages/integration-sdk/src/schema.js';
import { workerStateSchema, type WorkerState } from '../adapters/recovery.js';

export async function createApp(config: Config, store = new Store(config.OCC_DB_PATH)) {
  const app = Fastify({ logger: { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'password', 'token', 'text'] },
    logController: new LogController({ disableRequestLogging: true }), trustProxy: config.OCC_TRUST_PROXY, bodyLimit: 32 * 1024, requestTimeout: 15000,
    genReqId: () => randomUUID() });
  const identities = new IdentityService(store); const audit = new Audit(store);
  const projects = new Projects(store); const events = new Events(store, projects);
  const system = new SystemMonitor(config); const docker = new DockerMonitor(config);
  const router = new CommandRouter(store, audit, projects, system, docker);
  const dispatch = createDispatch(router, identities, audit);
  const transports = new Map<string, WorkerState & { observedAt: number }>();
  store.db.prepare("UPDATE tasks SET status='failed' WHERE status='running'").run();
  if (config.OCC_IDENTITY_FILE) identities.importFile(config.OCC_IDENTITY_FILE);
  store.cleanup(config.OCC_RETENTION_DAYS);
  const timer = setInterval(() => store.cleanup(config.OCC_RETENTION_DAYS), 60_000).unref();
  const actors = new WeakMap<FastifyRequest, Actor>();
  const sessions = new WeakMap<FastifyRequest, { csrf: string; token_hash: string }>();
  const prefix = `${config.OCC_BASE_PATH}/api/v1`;
  const envelope = (request: FastifyRequest, data: unknown) => ({ protocolVersion: '1.0', requestId: request.id, timestamp: new Date().toISOString(), data });
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"],
    upgradeInsecureRequests: config.OCC_SECURE_COOKIES ? [] : null,
  } }, hsts: config.OCC_SECURE_COOKIES });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  app.addHook('onSend', async (_req, reply) => { reply.header('cache-control', 'no-store'); });
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status = error instanceof OccError ? error.status : error instanceof z.ZodError ? 400 : error.statusCode ?? 500;
    const code = error instanceof OccError ? error.code : error instanceof z.ZodError ? 'VALIDATION_ERROR' : status === 429 ? 'RATE_LIMITED' : status < 500 ? 'BAD_REQUEST' : 'INTERNAL_ERROR';
    const message = error instanceof OccError ? error.message : status < 500 ? 'Request rejected' : 'Unexpected server error';
    // Avoid echoing validation input, tokens, URLs or raw exceptions back to clients or logs.
    if (status >= 500) app.log.error({ requestId: request.id, code }, 'Request failed');
    audit.record('api.request', code, request.id, actors.get(request));
    reply.status(status).send({ protocolVersion: '1.0', requestId: request.id, timestamp: new Date().toISOString(), error: { code, message } });
  });
  async function sessionAuth(request: FastifyRequest, _reply: FastifyReply) {
    const token = request.cookies.occ_session;
    if (!token) throw new OccError('UNAUTHENTICATED', 'Login required', 401);
    const row = store.db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires>?').get(hashToken(token), Date.now()) as
      { user_id: string; csrf: string; token_hash: string } | undefined;
    if (!row) throw new OccError('UNAUTHENTICATED', 'Session expired', 401);
    const actor = identities.actor(row.user_id);
    actors.set(request, actor); sessions.set(request, row);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (request.headers.origin !== new URL(config.OCC_PUBLIC_ORIGIN).origin ||
        typeof request.headers['x-csrf-token'] !== 'string' || !equal(request.headers['x-csrf-token'], row.csrf)) throw forbidden();
    }
  }
  async function admin(request: FastifyRequest, reply: FastifyReply) {
    await sessionAuth(request, reply); requirePermission(actors.get(request)!, 'admin');
  }
  const params = (request: FastifyRequest) => z.object({ id: z.string().min(1).max(100) }).passthrough().parse(request.params);
  function integration(request: FastifyRequest, scope: typeof scopes[number]) {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) throw new OccError('UNAUTHENTICATED', 'Bearer token required', 401);
    const projectId = projects.authenticate(authorization.slice(7), scope);
    // Integration identities cannot supply a user or target another project.
    return projectId;
  }
  app.get(`${prefix}/health`, async request => {
    store.db.prepare('SELECT 1').get();
    return envelope(request, { status: 'ok' });
  });
  app.post(`${prefix}/auth/login`, { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (request.headers.origin !== new URL(config.OCC_PUBLIC_ORIGIN).origin) throw forbidden();
    const body = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(256) }).strict().parse(request.body);
    const user = store.db.prepare('SELECT * FROM users WHERE username=?').get(body.username) as unknown as User | undefined;
    if (!await verifyPassword(body.password, user?.password_hash)) {
      audit.record('auth.login', 'denied', request.id);
      throw new OccError('INVALID_CREDENTIALS', 'Invalid username or password', 401);
    }
    // Replace any existing browser session to prevent fixation, never accept a caller-provided ID.
    if (request.cookies.occ_session) store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(request.cookies.occ_session));
    const token = randomToken(); const csrf = randomToken(); const expires = Date.now() + 8 * 60 * 60 * 1000;
    store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hashToken(token), user!.id, csrf, expires);
    reply.setCookie('occ_session', token, { path: config.OCC_BASE_PATH, httpOnly: true,
      secure: config.OCC_SECURE_COOKIES, sameSite: 'strict', maxAge: 8 * 60 * 60 });
    audit.record('auth.login', 'completed', request.id, identities.actor(user!.id));
    return envelope(request, { csrf, user: { id: user!.id, username: user!.username } });
  });
  app.get(`${prefix}/auth/session`, { preHandler: sessionAuth }, async request => {
    const actor = actors.get(request)!;
    return envelope(request, { csrf: sessions.get(request)!.csrf, user: { id: actor.userId, username: identities.user(actor.userId)!.username } });
  });
  app.post(`${prefix}/auth/logout`, { preHandler: sessionAuth }, async (request, reply) => {
    store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sessions.get(request)!.token_hash);
    reply.clearCookie('occ_session', { path: config.OCC_BASE_PATH }); return envelope(request, { loggedOut: true });
  });
  app.get(`${prefix}/system`, { preHandler: admin }, async request => envelope(request, await system.snapshot()));
  app.get(`${prefix}/containers`, { preHandler: admin }, async request => envelope(request, await docker.list()));
  app.get(`${prefix}/projects`, { preHandler: admin }, async request => envelope(request, projects.list()));
  app.get(`${prefix}/projects/:id`, { preHandler: admin }, async request => envelope(request, projects.get(params(request).id)));
  app.post(`${prefix}/projects`, { preHandler: admin }, async (request, reply) => {
    const body = z.object({ manifest: manifestSchema, metadata: metadataSchema.optional() }).strict().parse(request.body);
    const project = projects.register(body.manifest, body.metadata);
    audit.record('project.register', 'completed', request.id, actors.get(request));
    return reply.status(201).send(envelope(request, project));
  });
  app.post(`${prefix}/projects/:id/tokens`, { preHandler: admin }, async (request, reply) => {
    const body = z.object({ scopes: z.array(z.enum(scopes)).min(1).max(5), expiresDays: z.number().int().min(1).max(90).default(30) }).strict().parse(request.body);
    const result = projects.issueToken(params(request).id, body.scopes, body.expiresDays);
    audit.record('integration.token.issue', 'completed', request.id, actors.get(request));
    return reply.status(201).send(envelope(request, result));
  });
  app.delete(`${prefix}/tokens/:id`, { preHandler: admin }, async request => {
    projects.revoke(params(request).id); audit.record('integration.token.revoke', 'completed', request.id, actors.get(request));
    return envelope(request, { revoked: true });
  });
  app.post(`${prefix}/projects/:id/operations/:operation/approve`, { preHandler: admin }, async request => {
    const { id, operation } = z.object({ id: z.string(), operation: z.string() }).parse(request.params);
    projects.approve(id, operation); audit.record('integration.operation.approve', 'completed', request.id, actors.get(request));
    return envelope(request, { approved: true });
  });
  app.get(`${prefix}/activity`, { preHandler: admin }, async request => envelope(request, audit.recent()));
  app.get(`${prefix}/bots`, { preHandler: admin }, async request => envelope(request, ['telegram', 'whatsapp'].map(platform => {
    const observed = transports.get(platform);
    const fresh = !!observed && Date.now() - observed.observedAt < 45_000;
    return { platform, mode: config.OCC_MODE, status: config.OCC_MODE === 'mock' ? 'mock — no external connections'
      : fresh ? observed!.status : 'unobserved — inspect isolated worker', fresh, observedAt: observed ? new Date(observed.observedAt).toISOString() : null,
      reason: observed?.reason ?? null, attempt: observed?.attempt ?? 0, nextRetryAt: fresh ? observed!.nextRetryAt : null };
  })));
  app.get(`${prefix}/settings`, { preHandler: admin }, async request => envelope(request, {
    mode: config.OCC_MODE, basePath: config.OCC_BASE_PATH, retentionDays: config.OCC_RETENTION_DAYS,
    docker: config.OCC_DOCKER_MODE, ai: 'disabled', execution: 'read-only',
    pollingSeconds: Number((store.db.prepare('SELECT value FROM settings WHERE key=?').get('pollingSeconds') as { value: string } | undefined)?.value ?? 15),
  }));
  app.patch(`${prefix}/settings`, { preHandler: admin }, async request => {
    const body = z.object({ pollingSeconds: z.union([z.literal(15), z.literal(30), z.literal(60)]) }).strict().parse(request.body);
    store.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('pollingSeconds', String(body.pollingSeconds));
    audit.record('settings.update', 'completed', request.id, actors.get(request)); return envelope(request, body);
  });
  app.post(`${prefix}/commands`, { preHandler: admin }, async request => {
    const body = z.object({ name: z.string().max(50), args: z.array(z.string().max(100)).max(10).default([]) }).strict().parse(request.body);
    return envelope(request, await router.execute(body.name, body.args, actors.get(request)!, request.id));
  });
  function transportAuth(request: FastifyRequest) {
    const { platform } = z.object({ platform: z.enum(['telegram', 'whatsapp']) }).parse(request.params);
    const token = platform === 'telegram' ? config.OCC_TELEGRAM_GATEWAY_TOKEN : config.OCC_WHATSAPP_GATEWAY_TOKEN;
    if (!token) throw new OccError('TRANSPORT_DISABLED', 'Transport is disabled', 503);
    if (!equal(request.headers.authorization ?? '', `Bearer ${token}`)) throw forbidden();
    if (config.OCC_MODE !== 'live') throw new OccError('TRANSPORT_DISABLED', 'Live gateway disabled in mock mode', 503);
    return platform;
  }
  app.post(`${prefix}/gateway/:platform/status`, async request => {
    const platform = transportAuth(request);
    const state = workerStateSchema.parse(request.body);
    transports.set(platform, { ...state, observedAt: Date.now() });
    return envelope(request, { accepted: true });
  });
  app.get(`${prefix}/gateway/:platform/catalog`, async request => {
    transportAuth(request); return envelope(request, router.catalog());
  });
  app.post(`${prefix}/gateway/:platform/commands`, async request => {
    const platform = transportAuth(request);
    const body = z.object({ senderId: z.string().min(1).max(100), chatId: z.string().min(1).max(100), group: z.boolean(),
      text: z.string().max(512), addressedTo: z.string().max(100).optional(), directedElsewhere: z.boolean().optional() }).strict().parse(request.body);
    return envelope(request, await dispatch(platform, body));
  });
  app.get(`${prefix}/integrations/me`, async request => envelope(request, projects.get(integration(request, 'project:read'))));
  app.post(`${prefix}/integrations/register`, async request => {
    const id = integration(request, 'project:read'); const manifest = manifestSchema.parse(request.body);
    // Admin-approved manifest is the capability ceiling; self-registration cannot widen it.
    if (manifest.id !== id || JSON.stringify(manifest) !== JSON.stringify(projects.get(id).manifest)) throw forbidden();
    audit.record('integration.register', id, request.id); return envelope(request, { registered: true, projectId: id });
  });
  app.post(`${prefix}/integrations/health`, async request => {
    const id = integration(request, 'health:write'); const body = healthSchema.parse(request.body);
    const result = projects.report(id, body.status); audit.record('integration.health', id, request.id);
    return envelope(request, { id: result.id, status: result.health, lastCheck: result.lastCheck });
  });
  app.post(`${prefix}/integrations/events`, async request => {
    const id = integration(request, 'events:write'); const event = eventSchema.parse(request.body);
    const result = events.publish(id, event); audit.record('integration.event', id, request.id);
    return envelope(request, result);
  });
  app.get(`${prefix}/integrations/events`, async request => envelope(request, events.subscribed(integration(request, 'events:read'))));
  app.get(`${prefix}/integrations/operations`, async request => envelope(request, projects.operations(integration(request, 'project:read'))));
  app.post(`${prefix}/integrations/operations/:operation/invoke`, async request => {
    const id = integration(request, 'operations:invoke'); const { operation } = z.object({ operation: z.string() }).parse(request.params);
    z.object({}).strict().parse(request.body ?? {});
    const result = projects.invoke(id, operation); audit.record('integration.operation', id, request.id);
    return envelope(request, result);
  });
  const openapiPath = resolve('docs/openapi.json');
  app.get(`${prefix}/openapi.json`, { preHandler: admin }, async () => ({ ...JSON.parse(await readFile(openapiPath, 'utf8')), servers: [{ url: prefix }] }));
  const dashboard = resolve('dashboard/dist');
  app.get(`${config.OCC_BASE_PATH}/config.js`, async (_request, reply) => reply.type('application/javascript').send(
    `window.OCC_CONFIG=${JSON.stringify({ basePath: config.OCC_BASE_PATH })};`));
  if (existsSync(dashboard)) {
    // Serve only exact filenames emitted by our build. No general filesystem route,
    // directory listings, caller-controlled paths or encoded separator normalization.
    const assets = new Set((await readdir(resolve(dashboard, 'assets'))).filter(name => /^[a-zA-Z0-9_-]+\.(js|css|svg|woff2)$/.test(name)));
    app.get(`${config.OCC_BASE_PATH}/assets/:filename`, async (request, reply) => {
      const { filename } = z.object({ filename: z.string() }).parse(request.params);
      if (!assets.has(filename)) throw new OccError('NOT_FOUND', 'Asset not found', 404);
      const type = filename.endsWith('.css') ? 'text/css' : filename.endsWith('.js') ? 'application/javascript' : filename.endsWith('.svg') ? 'image/svg+xml' : 'font/woff2';
      return reply.type(type).send(await readFile(resolve(dashboard, 'assets', filename)));
    });
    const index = async (_request: FastifyRequest, reply: FastifyReply) => reply.type('text/html').send(
      (await readFile(resolve(dashboard, 'index.html'), 'utf8')).replaceAll('/__OCC_BASE_PATH__', config.OCC_BASE_PATH));
    app.get(config.OCC_BASE_PATH, index);
    app.get(`${config.OCC_BASE_PATH}/*`, async (request, reply) => {
      const path = request.url.split('?')[0]!;
      if (path.startsWith(`${config.OCC_BASE_PATH}/api/`) || path.startsWith(`${config.OCC_BASE_PATH}/assets/`))
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      return index(request, reply);
    });
  }
  app.setNotFoundHandler((request, reply) => reply.status(404).send({ protocolVersion: '1.0', requestId: request.id,
    timestamp: new Date().toISOString(), error: { code: 'NOT_FOUND', message: 'Not found' } }));
  app.addHook('onClose', async () => { clearInterval(timer); store.close(); });
  return { app, store, identities, audit, projects, events, router, dispatch, config };
}
export type Application = Awaited<ReturnType<typeof createApp>>;
