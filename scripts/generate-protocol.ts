import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { manifestSchema, metadataSchema, healthSchema, eventSchema, scopes } from '../packages/integration-sdk/src/schema.js';

const manifest = z.toJSONSchema(manifestSchema);
await writeFile('docs/manifest.schema.json', `${JSON.stringify(manifest, null, 2)}\n`);
const schema = (value: z.ZodType) => z.toJSONSchema(value);
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const success = { description: 'Successful OCC envelope', content: { 'application/json': { schema: ref('Envelope') } } };
const errors = Object.fromEntries([400, 401, 403, 404, 409, 413, 429, 500].map(code => [code, {
  description: 'Structured OCC error (no submitted values)', content: { 'application/json': { schema: ref('Error') } },
}]));
type Schema = Record<string, unknown>;
const parameters = (path: string) => [...path.matchAll(/\{([^}]+)\}/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
const paths: Record<string, unknown> = {};
function route(path: string, method: string, summary: string, auth: 'session' | 'token' | 'transport' | 'none', body?: Schema, status = 200) {
  const operations = (paths[path] ??= {}) as Record<string, unknown>;
  operations[method] = { summary, operationId: `${method}_${path.replace(/[^a-zA-Z0-9]+/g, '_')}`,
    parameters: [...parameters(path), ...(auth === 'session' && method !== 'get' ? [{ name: 'X-CSRF-Token', in: 'header', required: true, schema: { type: 'string' } },
      { name: 'Origin', in: 'header', required: true, schema: { type: 'string' } }] : [])],
    security: auth === 'none' ? [] : [{ [auth === 'session' ? 'Session' : auth === 'token' ? 'ProjectToken' : 'TransportToken']: [] }],
    ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } } : {}),
    responses: { [status]: success, ...errors } };
}
const object = (properties: Schema, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
route('/health', 'get', 'Minimal public liveness and database check', 'none');
route('/auth/login', 'post', 'Login; requires exact public Origin, rate limit 5/minute', 'none', object({ username: { type: 'string' }, password: { type: 'string', writeOnly: true } }, ['username', 'password']));
route('/auth/session', 'get', 'Session identity and CSRF token', 'session');
route('/auth/logout', 'post', 'Revoke browser session', 'session');
for (const item of ['system', 'containers', 'bots', 'activity', 'settings', 'projects']) route(`/${item}`, 'get', `Administrator ${item} data`, 'session');
route('/projects/{id}', 'get', 'Project metadata', 'session');
route('/projects', 'post', 'Administrator approves and registers a manifest; never executes it', 'session', object({ manifest: ref('Manifest'), metadata: ref('Metadata') }, ['manifest']), 201);
route('/projects/{id}/tokens', 'post', 'Issue a scoped project token, returned once', 'session', object({ scopes: { type: 'array', items: { enum: [...scopes] }, minItems: 1 }, expiresDays: { type: 'integer', minimum: 1, maximum: 90, default: 30 } }, ['scopes']), 201);
route('/tokens/{id}', 'delete', 'Revoke an integration token', 'session');
route('/projects/{id}/operations/{operation}/approve', 'post', 'Explicit approval of a declared cached read-only operation', 'session');
route('/settings', 'patch', 'Set bounded refresh preference', 'session', object({ pollingSeconds: { enum: [15, 30, 60] } }, ['pollingSeconds']));
route('/commands', 'post', 'Invoke the shared permission-checked command registry', 'session', object({ name: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } }, ['name']));
route('/integrations/me', 'get', 'Read own metadata; scope project:read', 'token');
route('/integrations/register', 'post', 'Confirm the exact administrator-approved manifest; scope project:read', 'token', ref('Manifest'));
route('/integrations/health', 'post', 'Push own health; scope health:write', 'token', ref('Health'));
route('/integrations/events', 'post', 'Publish declared namespaced event; scope events:write', 'token', ref('Event'));
route('/integrations/events', 'get', 'Poll up to 100 own subscribed events; scope events:read', 'token');
route('/integrations/operations', 'get', 'List own approved/pending operations; scope project:read', 'token');
route('/integrations/operations/{operation}/invoke', 'post', 'Invoke an approved cached read; scope operations:invoke', 'token', object({}));
route('/gateway/{platform}/commands', 'post', 'Isolated transport ingress; platform-specific bearer credential, live mode only', 'transport', object({
  senderId: { type: 'string' }, chatId: { type: 'string' }, group: { type: 'boolean' }, text: { type: 'string', maxLength: 512 },
  addressedTo: { type: 'string' }, directedElsewhere: { type: 'boolean' },
}, ['senderId', 'chatId', 'group', 'text']));
route('/gateway/{platform}/status', 'post', 'Ephemeral transport heartbeat, no conversation data', 'transport', object({ status: { enum: ['connected', 'disconnected', 'starting'] } }, ['status']));
const openapi = { openapi: '3.1.0', info: { title: 'OCC Integration Protocol', version: '1.0',
  description: 'All paths are relative to OCC_BASE_PATH/api/v1. Project tokens are limited to their own project. Session writes also require CSRF and exact Origin. No remote execution or arbitrary webhooks.' },
  servers: [{ url: '/sys/api/v1' }], paths,
  components: { securitySchemes: {
    Session: { type: 'apiKey', in: 'cookie', name: 'occ_session' },
    ProjectToken: { type: 'http', scheme: 'bearer' }, TransportToken: { type: 'http', scheme: 'bearer' },
  }, schemas: { Manifest: manifest, Metadata: schema(metadataSchema), Health: schema(healthSchema), Event: schema(eventSchema),
    Envelope: object({ protocolVersion: { const: '1.0' }, requestId: { type: 'string' }, timestamp: { type: 'string', format: 'date-time' }, data: {} }, ['protocolVersion', 'requestId', 'timestamp', 'data']),
    Error: object({ protocolVersion: { const: '1.0' }, requestId: { type: 'string' }, timestamp: { type: 'string', format: 'date-time' }, error: object({ code: { type: 'string' }, message: { type: 'string' } }, ['code', 'message']) }, ['protocolVersion', 'requestId', 'timestamp', 'error']),
  } } };
await writeFile('docs/openapi.json', `${JSON.stringify(openapi, null, 2)}\n`);
