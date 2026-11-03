# Oracle-Control-Core

A lightweight, modular personal server-management platform. OCC brings a project
registry, system monitoring, messaging commands and integration API into one
TypeScript backend, with an authenticated React dashboard under **`/sys`**.

This is the Phase 1.1 deployment-readiness implementation. It builds, tests and runs locally
without Telegram, WhatsApp, Oracle Cloud or AI API credentials. No production
server is contacted, and existing TelegramDL and Uptime Kuma installations remain
independent. AI inference and destructive administration are intentionally absent.

## Quick start

Use **Node.js 24 LTS** (Linux ARM64 or x64) and npm. Run from this directory:

```sh
npm ci
cp .env.example .env
chmod 600 .env
npm run admin
npm run dev
```

`admin` creates a local SQLite administrator and prints a generated password once.
There is no shared default password. Save that password privately. Sign in at
`http://localhost:3000/sys` (local use only). To supply your own password use the
`OCC_ADMIN_PASSWORD` environment variable securely; minimum 16 characters. The CLI
refuses to overwrite existing users. Do not put passwords on the command line.

```sh
npm run check   # lint, types, 40+ tests, build, isolated integration/messaging demo
npm run build
npm start      # compiled production server; still loopback-only by default
```

`npm run dev` builds the frontend before starting the backend watcher. Run
`npm run build:dashboard` after frontend edits. No live transport or Docker daemon
is started automatically. `npm run demo` starts only a disposable loopback server,
tests the SDK and mock transports, and removes its in-memory data on exit.

For a first Docker/ARM64 installation, follow
[the ordered first-deployment guide](docs/FIRST_DEPLOYMENT.md). `npm run setup --
config/setup.local.json` prepares private, non-overwriting configuration;
`npm run preflight` validates the actual data/configuration without printing
secrets. Docker setup uses the same compiled helpers and preserves existing
SQLite volumes and records. See the guide before starting optional collectors
or live workers.

## What works

- SQLite migrations, persistent users, explicit platform links, project registry,
  server-side sessions, hashed project tokens, task metadata and bounded audits.
- One shared router for Telegram, WhatsApp, the dashboard API and future AI tools:
  `/start`, `/help`, `/status`, `/health`, `/projects`, `/project <id>`,
  `/containers`, `/logs <id>`, `/system`, `/uptime`.
- Private and allowlisted group authorization. Groups default to status/help/
  health/uptime only. Ordinary WhatsApp messages are ignored without persistence.
- Dashboard pages for overview, monitoring, projects, bots, containers, activity
  and settings. Separate host collector, cgroup and OCC process observations;
  freshness/source/unavailable states are explicit.
- Per-project integration scopes, approved cached read-only operations, health
  reporting, namespaced metadata events, idempotency and polling subscriptions.
- TypeScript SDK, local sample application, JSON manifest schema and OpenAPI.
- Independent Compose deployment with an optional restricted Docker inventory
  sidecar and separate transport workers/session volume.

Raw application logs are deliberately unavailable: safe redaction requires a
project-specific log integration. Live transports have a mocked, bounded classified recovery policy but are **not
validated with real accounts**. There is no remote operation executor or webhook
delivery queue. See [the roadmap](docs/ROADMAP.md) for explicit limits.

## Identity and mock development

`npm run demo` links two fictitious sender identities to one in-memory OCC user and
exercises both mock adapters. It never opens messaging connections.

For a native Node deployment (Docker uses the generated `data/operator/identities.json`
described in FIRST_DEPLOYMENT.md), copy
`config/identities.example.json` to ignored `config/identities.json`. Replace the
example fields with exact sender IDs and the **internal OCC user ID** printed by
the admin CLI. Map Telegram's numeric `from.id` and Baileys' normalized exact JID
to the same OCC user ID to link them. WhatsApp LID and phone JID are distinct;
approve each explicitly if needed. Add allowed group IDs separately. Do not infer
identities from usernames or phone-number guesses. Set `OCC_IDENTITY_FILE` and
restart core to load the authoritative mapping atomically.

Live workers require `OCC_MODE=live`, their own transport bearer credential and
their own messaging credential/session. Core receives only the two transport
credentials, never the Telegram bot token or WhatsApp session. Details and pairing
limitations are in [deployment](docs/DEPLOYMENT.md).

## Configuration

No environment variables are required for local mock startup; `.env.example`
documents defaults. No administrator exists until explicit bootstrap.

| Variable | Default / purpose |
| --- | --- |
| `OCC_MODE` | `mock`; live adapters must be explicitly enabled |
| `OCC_HOST`, `OCC_PORT` | `127.0.0.1`, `3000` |
| `OCC_BASE_PATH` | `/sys`; supports nested prefixes, no trailing slash |
| `OCC_PUBLIC_ORIGIN` | `http://localhost:3000`; exact browser origin for CSRF |
| `OCC_SECURE_COOKIES` | `false` locally; required `true` for public HTTPS |
| `OCC_TRUST_PROXY` | `false`; only enable behind a trusted, isolated proxy |
| `OCC_DB_PATH` | `./data/occ.sqlite` (WAL; keep side files with DB) |
| `OCC_RETENTION_DAYS` | `30`; audit/events/tasks also capped at 10,000 each |
| `OCC_DOCKER_MODE` | `disabled`; opt-in `mock` or restricted `proxy` |
| `OCC_DOCKER_PROXY_URL` | Required only in proxy mode; fixed `/containers` path |
| `OCC_HOST_MONITOR_MODE` | `disabled`; `collector` requires URL + private token |
| `OCC_HOST_MONITOR_URL` | Isolated host collector, fixed `/metrics` path |
| `OCC_HOST_MONITOR_TOKEN`, `OCC_DOCKER_MONITOR_TOKEN` | Separate collector credentials; `*_FILE` supported |
| `OCC_TELEGRAM_ENABLED`, `OCC_WHATSAPP_ENABLED` | `false`; used by deployment preflight for live mappings |
| `OCC_BOOTSTRAP_ADMIN_ID`, `OCC_BOOTSTRAP_ADMIN_USERNAME` | Explicit local bootstrap identity from setup |
| `OCC_IDENTITY_FILE` | Optional explicit sender/group mapping JSON |
| `OCC_ADMIN_PASSWORD` | Optional local bootstrap input; no default password |
| `OCC_TELEGRAM_GATEWAY_TOKEN` | Optional unique 32+ character core↔Telegram secret |
| `OCC_WHATSAPP_GATEWAY_TOKEN` | Optional different 32+ character core↔WhatsApp secret |
| `OCC_CORE_URL` | Live workers only: complete `/sys/api/v1` URL |
| `OCC_TELEGRAM_TOKEN` | Live Telegram worker only; separate OCC bot |
| `OCC_WHATSAPP_SESSION_DIR` | WhatsApp worker only; default `./sessions/whatsapp` |
| `OCC_WHATSAPP_PAIR_PHONE` | Explicit isolated pairing only; never core |
| `OCC_WHATSAPP_COMMAND_NAME` | WhatsApp `/command@occ` target; default `occ` |

To change the dashboard prefix, set `OCC_BASE_PATH=/control/occ` and restart. The
same frontend build, nested routes, assets, API requests and cookie path adapt.
Root `/` remains available for other applications. The public origin contains no
path. HTTPS public access requires secure cookies; direct HTTP public origins are
rejected. No cloud credentials, SSH target, or Oracle API endpoint is configured.

## Integrating an application

An administrator submits an approved v1 manifest to `POST /sys/api/v1/projects`,
then issues a scoped token via `POST /projects/:id/tokens` (session + CSRF).
The application uses its bearer token with `/integrations/register`,
`/integrations/health`, `/integrations/events` and approved read-only operations.
It cannot choose another project's identity or grant itself capabilities.
Use the SDK in `packages/integration-sdk/src/index.ts`, the working example in
`examples/sample-integration/`, or the documented HTTP endpoints in any language.

## Documentation

- [First deployment, in order](docs/FIRST_DEPLOYMENT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Integration protocol and HTTP examples](docs/INTEGRATION_PROTOCOL.md)
- [Security and privacy](docs/SECURITY.md)
- [Local and Docker deployment, ARM64 and HTTPS](docs/DEPLOYMENT.md)
- [Milestones and future AI plan](docs/ROADMAP.md)
- [OpenAPI](docs/openapi.json) · [Manifest JSON Schema](docs/manifest.schema.json)
- [Future Codex task instructions](AGENTS.md)

Never deploy to or connect to the production Oracle server from Codex Cloud.
