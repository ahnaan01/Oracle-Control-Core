# Local development and safe deployment guide

These are operator instructions for a future deployment. Codex must not connect
to or modify the production Oracle server, deploy automatically, publish a
preview, or expose external ports. No steps here require live credentials for
local build/test. Existing Uptime Kuma and TelegramDL must remain untouched and
outside the OCC Compose project.

## Local development

Use Node 24 LTS and npm. From the checkout root:

```sh
npm ci
cp .env.example .env
npm run admin
npm run dev
```

Open the local `/sys` dashboard using the generated local password. The Node
watcher reloads backend code; rebuild UI assets after frontend changes.
`npm run check` performs lint, strict type checking, tests, build and a disposable
loopback integration demo. None of these require Docker or messaging accounts.
Mock container fixtures are opt-in with `OCC_DOCKER_MODE=mock` and visibly labeled;
they cannot be enabled with live mode. OS metrics are always real observations.

Optional real browser validation: `npm run test:browser` uses an installed Chromium
at `/usr/bin/chromium` (override with `OCC_CHROMIUM_PATH`). It checks login, project
registration, all pages, settings, mobile overflow and logout at `/sys` and a
nested alternative prefix. It blocks all external browser requests and uses an
in-memory DB. A disposable screenshot is written to `/tmp/occ-dashboard.png`.

## Docker / ARM64

The official `node:24-bookworm-slim` image supports Linux ARM64 and AMD64.
Node's bundled SQLite needs no native addon. Baileys has a public Git dependency,
so the builder includes Git and CA certificates; no Git or compiler is installed
in the runtime stage. Package-lock pins dependency resolutions, including the Git
commit. Do not disable TLS or package integrity checks to resolve build failures.

On a **development machine**, prepare a local image and isolated mock stack:

```sh
docker compose config --quiet
docker compose build core
docker compose up -d core
docker compose exec core node dist/src/admin.js
```

Core defaults to loopback `127.0.0.1:3300`. Choose a free `OCC_BIND_PORT` rather than
reusing existing service ports. Compose interpolation reads `.env`; if you copied
the local Node example, change `OCC_PUBLIC_ORIGIN` from `http://localhost:3000` to
`http://localhost:3300` (or your chosen port) for correct Origin/CSRF behavior.
Do not set a fixed container name. The project is named `occ`; if that name is
already in use, choose a different project name consistently with `-p`.

The SQLite named volume persists users and registry state; the separate WhatsApp
volume is mounted **only** by its worker. Do not use `down -v` on a valued install.
Core uses a read-only root filesystem, non-root user, dropped capabilities,
no-new-privileges, PID/memory/CPU limits, a small tmpfs, restart policy, init and a
local health check. Only the core service is enabled by default. Internal networking
prevents core from making arbitrary Internet requests. Resources are budgets,
not measurements: adjust after observing your own 2 OCPU / ~11 GiB host.

For a native ARM64 development machine use normal `docker build`; for a configured
cross-builder: `docker buildx build --platform linux/arm64 --load -t occ:arm64 .`.
Cross-build requires a suitable builder/emulation; do not claim it ran merely
because the Dockerfile uses a multi-architecture base image. CI includes a native
`ubuntu-24.04-arm` build and health smoke.

Managed Codex cloud builds additionally need its public proxy CA (not a secret
credential) mounted for npm/Git TLS trust:

```sh
docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" -t occ:local .
```

The optional BuildKit mount is not copied to image layers. Keep the inherited
proxy configuration. Ordinary non-proxied operator builds need no secret mount.

## Later operator installation on Oracle Ubuntu ARM64

Before doing anything, the operator should inventory actual container names,
Compose projects, ports, storage paths and available resources. Do not guess
installation details. Build/deploy OCC as its own directory and Compose project
using an unused loopback port. Do not stop, move, rename, import or reconfigure
Kuma or TelegramDL. The existing TelegramDL bot token is never an OCC credential.

Use the independent core startup above only after reviewing configuration and
backups. Start in mock/disabled-monitor mode. Verify the local health endpoint,
login, project registration and audit records before considering any optional
integration. The code never requires an Oracle Cloud API key or SSH target.

### Monitoring existing Docker resources

Default: no socket access, Docker explicitly unavailable, manual registry entries
still work. For discovery, the operator may opt into the restricted sidecar:

1. Determine the actual Docker socket GID locally on the deployment machine:
   `stat -c %g /var/run/docker.sock`.
2. Set `OCC_DOCKER_GID` to that group and `OCC_DOCKER_MODE=proxy`.
3. Start only OCC's monitoring profile with
   `docker compose --profile monitoring up -d core docker-monitor`.
4. Verify the dashboard's selected inventory. The sidecar exposes no host port;
   it performs only `GET /containers/json?all=true` and strips all but selected
   fields/Compose labels. Standalone containers work without Compose metadata.
5. Register chosen applications through the dashboard/API using known metadata.
   Discovery is read-only and never migrates or changes an existing deployment.

A socket mount labeled `:ro` alone is **not** an authorization boundary. The
monitor process has effective daemon authority and must remain isolated and
trusted. Never give core, messaging, AI or untrusted containers its socket/network.
If that risk is unacceptable, omit the sidecar and use manual registry entries.
Host system metrics from inside Docker are a runtime view, not a privileged host
agent; no host filesystem mount is needed or assumed.

### Live messaging (optional, operator only)

Do not enable live messaging to run tests. Real service access, identity verification
and pairing are separate operator validation steps. Never reuse TelegramDL's bot.

1. Bootstrap the administrator first. Obtain its internal OCC user ID from the CLI.
   Copy the identity sample into ignored `config/identities.json`, map exact
   Telegram user IDs / normalized Baileys JIDs to that ID, and add group IDs
   separately. Unknown IDs fail closed. No phone/name inference or auto-linking.
2. Supply two **different** randomly generated 32+ character transport credentials
   securely: `OCC_TELEGRAM_GATEWAY_TOKEN`, `OCC_WHATSAPP_GATEWAY_TOKEN`. Core gets
   these ingress credentials. Each worker receives only its own credential.
3. Mount the explicit identities file in core only. For example, an operator-local
   Compose override (not a credential file in Git):

   ```yaml
   services:
     core:
       environment:
         OCC_IDENTITY_FILE: /app/config/identities.json
       volumes:
         - ./config/identities.json:/app/config/identities.json:ro
   ```

4. Set core `OCC_MODE=live`, Docker to disabled/proxy (never mock), then enable only
   the required profile service(s). Telegram needs its separate bot token in the
   Telegram worker only. For shell use `npm run telegram` / `npm run whatsapp` with
   `OCC_CORE_URL` pointing to the local core `/sys/api/v1`. Ordinary core startup
   never launches these workers. Compose worker commands use compiled JS.
5. Pair WhatsApp only in the isolated worker with a protected terminal. Its session
   volume is `occ-whatsapp`; neither core nor future AI mounts it. The sample
   worker supports explicit `OCC_WHATSAPP_PAIR_PHONE` (digits, country code, no +)
   and prints a one-time linking code to that operator terminal. For Compose,
   stop only OCC's WhatsApp worker first, then run an interactive one-off worker:
   `docker compose --profile messaging run --rm -e OCC_WHATSAPP_PAIR_PHONE whatsapp`.
   The variable must be securely set in the operator's shell. Complete linking
   on the phone, stop the one-off worker, unset the pairing variable and start
   the normal WhatsApp service. Do not run two workers against one auth volume.
6. Test authorized private commands and an explicitly approved group. Only
   status/help/health/uptime are group-safe. Verify an unknown sender is rejected
   and normal messages generate no OCC activity. Session files must remain 0600
   inside a 0700 worker directory. Do not log or share pairing output.

No live account or pairing has been tested in Codex. WhatsApp's protocol can
change; the worker reports disconnection and stops rather than repeatedly
pairing. Use a dedicated test account, review Baileys/platform terms, and validate
the installed transport version before relying on it. Heartbeats report observed
connection state and become unobserved after 65 seconds without a report.

## Reverse proxy, temporary HTTPS and custom domain

Do not expose Node's administrative listener directly on a public address. For
local testing, an operator-created SSH tunnel to the selected loopback port
allows local HTTP access without opening a public application port. Codex must
not create that tunnel to production. `OCC_PUBLIC_ORIGIN` must match the exact
browser origin, including local port.

For a temporary public **HTTPS** test, an operator may run an HTTPS reverse proxy
or outbound tunnel on their own development/deployment machine, targeting OCC's
loopback port. Do not start a tunnel or publish a URL from Codex. Configure:

```dotenv
OCC_PUBLIC_ORIGIN=https://your-temporary-https-host.example
OCC_BASE_PATH=/sys
OCC_SECURE_COOKIES=true
OCC_TRUST_PROXY=true
```

Allow core access only from that trusted proxy and preserve `/sys` in forwarded
paths. Preserve Host and forwarded scheme/IP headers; do not strip the prefix.
`docker/Caddyfile.example` shows a custom-domain proxy. It uses `handle`, not
`handle_path`, to preserve subpaths. Existing routes at `/` can remain independent.
For a temporary managed tunnel, the HTTPS edge terminates TLS; no certificate
for a bare public IP is assumed. Keep administrative login enabled and protect
the tunnel account/access policy. When changing to a custom domain, update origin
and proxy configuration; no business logic or frontend rebuild is required.

## Backup, upgrades and shutdown

Protect SQLite and WhatsApp session backups separately. Stop **only OCC core**
for a simple consistent SQLite volume copy, preserving DB/WAL/SHM together; never
copy only a live WAL database file. A more advanced backup can use SQLite's backup
API. Do not change existing application containers for OCC backups or upgrades.
Stop the WhatsApp worker separately before copying its private session volume.

Build and validate a new OCC image before restarting its services. Preserve named
volumes, apply additive migrations, and inspect health and auth locally. SIGTERM
closes core's listener/database and stops its retention timer; workers handle their
own shutdown. No migration rollback or automated deployment/rollback executor is
provided yet. Restore a protected consistent backup for a DB downgrade rather
than pointing an older application at a newer schema.
