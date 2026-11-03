# OCC Integration Protocol 1.0

All endpoints are relative to `${OCC_BASE_PATH}/api/v1` (default `/sys/api/v1`).
Use HTTPS except for loopback or an isolated local Compose connection. No cloud or
messaging API keys are involved. Source schemas are in
`packages/integration-sdk/src/schema.ts`; generated
[manifest JSON Schema](manifest.schema.json) and [OpenAPI 3.1](openapi.json) describe
the wire format. Regenerate with `npm run docs:generate` after schema changes.
The authenticated `/openapi.json` route serves the specification with the actual
runtime prefix.

## Administrative provisioning and registration

1. Sign in using `POST /auth/login`, JSON `{ "username": "…", "password": "…" }`
   and the exact `Origin` matching `OCC_PUBLIC_ORIGIN`. Retain the HttpOnly session
   cookie and the returned `data.csrf` token securely.
2. Submit `POST /projects` with `{ "manifest": <v1 manifest>, "metadata": {} }`.
   Supply the session cookie, `Origin` and `X-CSRF-Token` for all session writes.
   The dashboard's Projects page supports this operation too.
3. Issue a separate credential with `POST /projects/<id>/tokens`, for example
   `{ "scopes": ["project:read", "health:write", "events:write", "events:read"],
   "expiresDays": 30 }`. The returned `data.token` is shown only once; save it
   in the integrated project's secret store. The database stores only its hash.
4. The project confirms registration by sending the same approved manifest to
   `POST /integrations/register`, with `Authorization: Bearer <its token>`.
   Anonymous registration is forbidden. This request cannot add capabilities.
5. Revoke a credential with administrator `DELETE /tokens/<token-id>`.

The sample manifest is `examples/sample-integration/manifest.json`. Minimal valid
manifest (defaults are filled by the schema):

```json
{
  "protocolVersion": "1.0",
  "id": "my-app",
  "name": "My application",
  "description": "A small service",
  "version": "1.0.0",
  "runtime": "external"
}
```

Project IDs are stable lowercase identifiers. Runtime is `docker`, `compose`,
`systemd`, `node` or `external`. Optional manifest fields include capabilities,
healthEndpoint, operations, eventsPublished, eventsConsumed, requiredPermissions,
configuration field **descriptions** and dashboard label/URL. Never include actual
secret values. HTTP(S) URL credentials are rejected, and declared URLs are only
metadata: OCC never probes or executes them automatically.

Operator-only registry metadata may contain projectDirectory, sourceDirectory,
configurationLocations, containerId, composeProject, systemdUnit and repositoryUrl.
These values identify independent existing resources and do not authorize reads,
deployment, filesystem access or Docker control.

## Project bearer API

Every project call uses its own bearer token. No project ID is accepted in a
request body; identity comes only from the authenticated token.

| Endpoint | Method | Required scope | Body / behavior |
| --- | --- | --- | --- |
| `/integrations/me` | GET | `project:read` | Own manifest, registry metadata and cached health |
| `/integrations/register` | POST | `project:read` | Exact approved v1 manifest |
| `/integrations/health` | POST | `health:write` | `{ "status": "healthy" }` |
| `/integrations/events` | POST | `events:write` | Declared namespaced event, below |
| `/integrations/events` | GET | `events:read` | Last 100 own subscribed events |
| `/integrations/operations` | GET | `project:read` | Declared operations plus approval state |
| `/integrations/operations/<name>/invoke` | POST | `operations:invoke` | `{}`; requires separate administrator approval |

Health values are `healthy`, `degraded`, `unhealthy`, `unknown`. Reports update
`lastCheck`. No report means `unknown`; health reports are not active probes.
Old timestamps remain visible and should not be mistaken for fresh verification.

Example event:

```json
{
  "type": "my-app.ready",
  "payload": { "status": "ready", "code": "startup.complete", "value": 1 },
  "idempotencyKey": "a-unique-job-event-id"
}
```

The type must be declared in the approved `eventsPublished` array and start with
`<project-id>.`. Subscriptions use `eventsConsumed` in the same namespace.
Payload keys are strictly limited to optional status (80 chars), code (identifier)
and finite numeric value. Put no private conversations or secrets in metadata.

Keys are 8–100 letters/digits/underscore/hyphen. Repeating an identical key/body
returns the same event ID and `duplicate:true`; a changed body returns 409. Retain
the same key when retrying an uncertain publish. After retention cleanup the key
may be accepted anew. Polling is best-effort (latest 100, no durable cursor); use
event IDs to deduplicate. There is no persisted outbound queue to retry, sign or
deliver webhooks. Cross-project events and webhooks are reserved for a later
explicit permission/approval design.

An operation declaration contains name, description, kind (`status` or `health`),
readOnly (`true`) and permission (`project:read`). An administrator must separately
POST `/projects/<id>/operations/<name>/approve`. Invocation returns cached registry
data only. An app cannot upload code, a shell command, a Docker action or an
arbitrary URL operation. Additional operation kinds need reviewed core executors.

## Envelope and errors

```json
{
  "protocolVersion": "1.0",
  "requestId": "server-generated-uuid",
  "timestamp": "2026-11-03T00:00:00.000Z",
  "data": { "status": "healthy" }
}
```

Failure envelopes replace `data` with `{ "error": { "code": "FORBIDDEN",
"message": "Not authorized" } }`. Validation never echoes submitted input.
Common HTTP statuses: 400 VALIDATION_ERROR/BAD_REQUEST, 401 UNAUTHENTICATED or
INVALID_CREDENTIALS, 403 FORBIDDEN, 404 NOT_FOUND, 409 CONFLICT, 413 BAD_REQUEST,
429 RATE_LIMITED and 500 INTERNAL_ERROR. Transport-disabled requests return 503.
All requests are bounded to 32 KiB and 120/minute/IP; login is 5/minute/IP.

## TypeScript and other languages

```ts
import { OccClient, manifestSchema } from './packages/integration-sdk/src/index.js';

const client = new OccClient(apiBaseUrl, securelyLoadedProjectToken);
await client.register(manifestSchema.parse(approvedManifest));
await client.reportHealth('healthy');
await client.publish('my-app.ready', { status: 'ready' }, stableEventId);
```

`OccClient` is a small fetch-based helper with five-second deadlines, no automatic
non-idempotent retries and structured `IntegrationError` values. It is source
code in this repository, not yet a separately published npm package. For Python,
Go or curl, send the JSON above with `Authorization: Bearer …` and
`Content-Type: application/json`. Do not put tokens into URLs, tracked scripts,
shell history or application logs. Retry timeouts/5xx with bounded backoff and
the **same event key**; do not retry permission/validation failures unchanged.

Run `npm run demo` for a complete credential-free local HTTP demonstration. It
provisions a disposable project, registers through the SDK, reports health,
publishes/replays an event, polls a subscription and invokes an approved read.
`examples/sample-integration/run.ts` can target an explicitly provisioned local
instance using `OCC_SAMPLE_API_URL` and `OCC_SAMPLE_TOKEN`; it is not run by default
and must not be pointed at the production Oracle server from Codex.
