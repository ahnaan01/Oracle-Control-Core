# Oracle Control Core: instructions for future Codex tasks

## Architecture

OCC is a Node.js 24 LTS / strict TypeScript modular monolith. Fastify owns the
versioned REST API, server-side session authentication and dashboard delivery.
React/Vite is served under `OCC_BASE_PATH` (default `/sys`). SQLite (`node:sqlite`)
is the sole database; `src/database/store.ts` applies numbered `user_version`
migrations. No Redis, external database, or AI framework is required.

- `src/core/`: identities, explicit permissions, shared command registry, projects,
  scoped integration tokens, events, audit and task metadata.
- `src/adapters/`: thin transports calling the same core dispatcher. Telegram
  (grammY) and WhatsApp (Baileys) workers run separately from the core; only the
  WhatsApp worker may mount its authentication volume.
- `src/services/`: real OS metrics, optional restricted Docker inventory, and
  future path-policy helpers. Host collector, cgroup v2 and OCC process metrics
  are separate. No shell or Docker write operations.
- `src/operator/`: non-overwriting private setup, read-only preflight and
  metadata-only existing-application registration helpers.
- `src/api/app.ts`: application factory, authentication and API boundary. Business
  rules belong in core/services, never in separate platform implementations.
- `packages/integration-sdk/`: protocol schemas and fetch-based TypeScript SDK.
- `dashboard/`, `examples/`, `agent/`, `docs/`, `docker/`, `tests/`: UI, local
  examples, future AI tool contract, specifications, deployment, verification.

## Development rules

Use the existing checkout. Cloud tasks are already isolated: do not create Git
worktrees unless the user requests one. Inspect `git status` and preserve user
changes. Use Node 24, `npm ci`, and the committed lockfile. No real Telegram,
WhatsApp, Oracle Cloud or AI credentials may be required for build, tests or demo.
Default to mock messaging, disabled Docker, and a local disposable database.
Production monitoring must use real observations or explicit unavailable states;
mock fixtures must always be visibly labeled. Do not invent container names,
paths, ports, user identities or current service health.

Add each command once in `CommandRouter`. Validate inputs with Zod and check the
OCC actor's permissions before execution, including future AI tool calls. Keep
protocol schemas, generated JSON Schema, OpenAPI and documentation consistent.
Use additive SQLite migrations for schema changes; never erase an existing DB to
make an upgrade succeed. Keep the system resource-conscious and buildable.

## Security requirements

- Never connect to or modify the user's production Oracle server from Codex.
  Never stop, move or reconfigure existing TelegramDL or Uptime Kuma deployments.
  Docker checks here must explicitly select the managed machine's local socket.
- Do not enable AI inference, arbitrary shell commands, destructive filesystem
  operations, Docker writes, deployment endpoints or unrestricted root access.
- Verify the real individual sender AND any authorized group. Group access alone
  grants nothing. Groups may use only non-sensitive status/help/health/uptime.
- Ignore ordinary WhatsApp conversations before dispatch. Never persist their
  contents, log updates, forward them to AI/n8n, or expose session storage to core.
  Do not merge identities by display name or phone-number guesses.
- Retain parameterized SQL, scrypt password hashes, hashed high-entropy tokens,
  HttpOnly/SameSite session cookies, expiry, exact-Origin and CSRF checks, rate and
  body-size limits, TLS verification, and restrictive CSP. No secrets in source,
  manifests, URLs, event payloads, audit data or logs. Never log raw error objects
  from messaging SDKs. Credentials belong in ignored local config or secure
  deployment settings. API token secrets are returned once and are revocable.
- Do not mount the Docker socket in core. The optional monitor has a literal
  read-only inventory request and no caller-controlled daemon paths or methods.
  A read-only socket mount alone does NOT restrict Docker API privileges.
- Keep each collector on its own internal network shared only with core, with
  a distinct file-backed token. Messaging uses gateway/egress only. Core must
  never mount host procfs, host root or WhatsApp sessions. Host collection uses
  individual read-only counter files and a selected empty filesystem directory.
- Worker recovery must stay bounded/classified. Never loop pairing after auth
  failure, auto-merge JIDs/LIDs, duplicate listeners/sessions, or delete session
  credentials to force recovery. Preserve the exclusive session lock and require
  operator inspection after a crash. No chat bodies in health or audit metadata.
- No arbitrary project URL requests: manifest URLs are metadata, avoiding SSRF.
  Any future file tool must resolve real paths, prevent symlink/traversal escapes,
  enforce per-project authorization, and address filesystem race conditions.
- Do not expose a public preview, deploy or open external ports from Codex.

## Commands and validation

From the repository root:

```sh
npm ci
npm run check          # lint, strict types, Vitest, production build, local HTTP demo
npm run docs:generate  # after protocol schema changes; review resulting diff
npm run admin         # explicit local admin bootstrap, generated password shown once
npm run dev           # builds dashboard and starts backend on loopback
```

Individual checks: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`,
`npm run demo`. The demo uses loopback HTTP and a disposable in-memory DB; it
requires local socket/listen permission in restrictive sandboxes. `npm test`
builds dashboard assets and uses Fastify injection and mocked external services.
`npm run test:browser` additionally uses locally installed Chromium (configure
`OCC_CHROMIUM_PATH`) and disposable local accounts; it blocks non-loopback traffic.
`npm run setup -- config/setup.local.json` creates new private operator config
only; `npm run preflight` checks actual data/config read-only without printing
secrets. Use the actual persistent volume when bootstrapping administrators.
Tests must cover authorization failures, privacy, scope isolation, CSRF, base-path
assets, persistence and any changed behavior, not merely happy paths.

For deployment changes validate `docker compose config --quiet`, build the image,
and run its local health check when Docker is available. ARM64 has a dedicated CI
job. Report architecture/container/browser checks as unrun when unavailable;
never claim production or live transport validation from mock test results.
The disposable deployment smoke is `python3 scripts/container-smoke.py <image>
[arm64|amd64]`; it verifies real collector observations and network denial by
DNS/IP, standalone/Compose discovery, SQLite restart and private session storage.
It must remove only its UUID project/probes, never global or existing resources.

Read `docs/SECURITY.md`, `docs/INTEGRATION_PROTOCOL.md`, `docs/DEPLOYMENT.md` and
`docs/ROADMAP.md` before extending the respective boundaries. Read the ordered
`docs/FIRST_DEPLOYMENT.md` for operator-only first deployment and recovery.
