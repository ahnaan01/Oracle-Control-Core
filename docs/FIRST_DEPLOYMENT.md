# First deployment: OCC 0.1.1 on Ubuntu ARM64

**Run these steps yourself on the server and your workstation. Codex must not
connect to, inspect or modify the production Oracle server.** This is an independent
OCC deployment, not a migration of Uptime Kuma or TelegramDL. Do not stop, move,
rename or reconfigure either existing application. No Oracle API key is required.

Use a non-root operator account with appropriate Docker permission. Keep a second
administrator session available. Do not paste credentials, pairing output, `.env`
or private session files into chat, Git or public logs.

## 1. Inspect the existing server without modifying it

On the server, record the actual OS/architecture and existing applications:

```sh
uname -m
cat /etc/os-release
docker ps --no-trunc --format 'table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker compose ls
```

Expect an ARM64/aarch64 host, but verify it. These are inspection commands only.
Do not run Docker prune, broad stop/down commands, existing Compose files or
OCC's setup inside an existing application's directory.

## 2. Identify ports, containers and Compose projects

```sh
ss -ltn
docker ps --format '{{.ID}} {{.Names}} {{.Label "com.docker.compose.project"}} {{.Label "com.docker.compose.service"}}'
```

Save Kuma's actual container ID and image version. Save TelegramDL's actual
Compose project and optionally its relevant container IDs and configuration
paths. An empty Compose label means standalone; do not infer a Compose file or
project for Kuma. Choose an unused loopback port for OCC (3300 is an example,
not a fact about your server). Record existing listening ports before proceeding.

## 3. Verify storage and resource headroom

```sh
free -h
df -h
docker stats --no-stream
docker system df
```

Confirm headroom on the actual filesystem holding OCC/volumes. The target is
2 OCPUs, ~11 GiB usable RAM and 200 GB storage; existing Kuma/TelegramDL remain
independent. Default OCC caps are 384 MiB core, 128 MiB per collector, 192 MiB
Telegram and 384 MiB WhatsApp; optional components are not started initially.
Total CPU caps are 1.7 cores, not measured continuous demand. Leave headroom for
existing applications, builds, SQLite backups and Docker image layers. Do not
delete existing data or Docker resources to make room without a separate plan.

## 4. Create an independent OCC directory and image

Choose a new directory owned by the non-root operator. Clone this repository
there and use a reviewed release/commit. Never clone over an existing app.

```sh
git clone https://github.com/ahnaan01/Oracle-Control-Core.git
cd Oracle-Control-Core
docker build --build-arg OCC_UID="$(id -u)" --build-arg OCC_GID="$(id -g)" -t occ:local .
```

Official Node 24 images support ARM64; a successful build alone is not runtime
validation. CI has a native ARM64 build and deployment/isolation smoke job; review
the run for the exact commit you will deploy. This guide does not claim CI or
production checks ran unless their actual results were observed.

The image and Compose use a non-root numeric UID/GID matching the operator so
private bind-mounted credential files remain readable without world/group access.
For an existing OCC installation, retain its original data-volume UID/GID and
review permissions explicitly; do not silently chown valued volumes. The SQLite
schema remains Phase 1 `user_version=1`, with no destructive migration.

## 5. Configure environment, credentials and identity mappings

Copy `config/setup.example.json` to ignored `config/setup.local.json`. Set username,
basePath, bindPort and optional publicOrigin. Start with dockerMode `disabled`,
hostMonitoring `false` and both transports disabled. Keep the initial origin
`http://localhost:<chosen-port>` for the private SSH-tunnel test. Only loopback
HTTP is permitted. Set real Telegram numeric IDs / normalized WhatsApp JIDs and
authorized groups now if known, or leave the arrays empty until later.

Never put tokens or passwords in this answers JSON. For an upgrade, set `adminId`
to the existing OCC user ID; a new deployment generates a UUID. Configure both
platforms with the same ID deliberately; no phone/display-name inference occurs.

With Node 24 installed, run `npm ci && npm run setup -- config/setup.local.json`.
Alternatively use the built image without installing Node on the host:

```sh
docker run --rm --network none --user "$(id -u):$(id -g)" \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --mount "type=bind,src=$PWD,dst=/work" --workdir /work \
  occ:local node /app/dist/src/operator/setup-cli.js config/setup.local.json
```

This explicit setup command writes only new private `.env` and `data/operator/*`
files. It refuses existing target files, never modifies an existing DB, prints
the internal administrator ID, and generates separate high-entropy gateway and
collector credentials. It creates an empty private Telegram-token file; fill it
only when enabling that worker. Keep secrets 0600 and directories 0700.

Compose mounts only each service's required individual files under `/run/secrets`.
Core never receives the Telegram bot token or WhatsApp session. Do not use a shared
env_file containing every credential for every service. Do not print `docker
inspect` environment output or dump process environments to debug credentials.

Bootstrap the administrator **inside the actual persistent SQLite volume**:

```sh
docker compose run --rm --no-deps core node dist/src/admin.js
docker compose run --rm --no-deps core node dist/src/operator/preflight-cli.js
docker compose config --quiet
```

The admin CLI uses the setup-selected username/ID, generates a strong password
shown once and refuses existing accounts. Store that password privately. A
supplied `OCC_ADMIN_PASSWORD` must be securely passed to this one-off CLI, not
saved in Compose/Git or made part of a normal core environment. If an account
already exists, retain it and use its actual ID in `data/operator/identities.json`.

Preflight is read-only: it checks schema compatibility, administrator presence,
mapping formats/user references, private paths, origin, credentials and the port
in its own network namespace. Host port conflicts must also be checked with `ss`
on the server; an isolated one-off container cannot inspect host port ownership.
Fix errors before proceeding. Disabled collectors produce explicit warnings.

## 6. Start only core in safe/mock mode

Confirm `.env` has `OCC_MODE=mock`, Docker disabled, host collector disabled and
no live transport profile enabled. The Compose project defaults to `occ`; if this
name already exists, choose a distinct `docker compose -p <new-name>` and use it
consistently for every subsequent OCC command. Never reuse an existing app's name.

```sh
docker compose up -d --no-build core
docker compose ps
docker compose exec core node dist/src/operator/preflight-cli.js --skip-port
```

Only the selected OCC core starts. Its listener is published to **127.0.0.1 only**.
There are no fixed container names. Named volumes `occ-data` and `occ-whatsapp`
remain independent; never use `down -v` on a valued installation.

## 7. Verify `/sys` through a local SSH tunnel

On your workstation, create your own SSH tunnel using the real operator/host and
chosen port (substitute the placeholders; do not give the target to Codex):

```sh
ssh -N -L <local-port>:127.0.0.1:<chosen-server-port> <operator>@<server>
```

Use the same local port as configured in `OCC_PUBLIC_ORIGIN`, or change the origin
to match the exact browser origin. Open the local `/sys`, sign in, and verify all
pages, nested refresh, project registration and sign-out, including mobile.
Health is `/sys/api/v1/health`. Expect host data unavailable initially; process
metrics are real and container/cgroup metrics are separate. Do not interpret
runtime OS compatibility fields as confirmed host totals.

## 8. Enable read-only host/Docker monitoring

Docker: set `OCC_DOCKER_GID` in private `.env` to the actual output of
`stat -c %g /var/run/docker.sock`. Set `OCC_DOCKER_MODE=proxy`, then:

```sh
docker compose --profile monitoring up -d --no-build core docker-monitor
```

Host: use `OCC_HOST_MONITOR_MODE=collector`, and verify `OCC_HOST_DISK_PATH` points
to an empty/non-sensitive directory on the desired host filesystem. The default
`config/host-disk` is on the checkout's filesystem. It is not the entire host root.

```sh
docker compose --profile host-monitoring up -d --no-build core host-monitor
docker compose exec core node dist/src/operator/preflight-cli.js --skip-port --probe-collectors
```

The isolated host collector mounts only `/proc/stat`, `/proc/meminfo`,
`/proc/uptime`, `/proc/loadavg`, `/proc/net/dev` and the selected disk directory,
all read-only. Core gets none of these mounts. It reports CPU tick deltas,
MemAvailable, selected-filesystem stats and cumulative network counters; missing
fields remain unavailable. Fresh host readings must identify the collector source.

Docker's socket is mounted **only** in docker-monitor, never core or either worker.
The sidecar's only upstream operation is literal `GET /containers/json?all=true`.
No writes/logs/inspect/arbitrary paths are exposed. A `:ro` socket still has daemon
authority at the OS level: keep this small process trusted and patched.

Each collector has its own authenticated, internal network shared only with core:
`docker-observe` or `host-observe`. Messaging uses `gateway` and an egress network;
it cannot resolve or connect to collectors by DNS or IP. There are no collector
host ports, whole-host filesystem mounts, host PID mode or privileged containers.
Do not attach integrations, future AI tools or unrelated apps to collector networks.

## 9. Register existing applications without modifying them

Create ignored operator JSON using the actual resource values recorded in step 2:

```json
{
  "id": "uptime-kuma",
  "name": "Uptime Kuma",
  "version": "ACTUAL_INSTALLED_VERSION",
  "runtime": "docker",
  "containerId": "ACTUAL_HEX_CONTAINER_ID"
}
```

For TelegramDL use id `telegramdl`, runtime `compose`, actual name/version and
`composeProject`. Optionally include actual projectDirectory and
configurationLocations. Paths and ports are never guessed or actively inspected.
Container IDs must be actual 12–64 character hex IDs; placeholders are rejected.

`npm run registration -- config/<name>.local.json` produces a validated
`{manifest,metadata}` bundle without network calls. Without host Node, run the
compiled helper in a network-disabled one-off image with the same operator-file
mount pattern as setup. Paste the bundle into the dashboard's Projects form.
This records metadata only. It does not change either app, create an integration
credential for it, issue commands, move it into OCC Compose or probe an endpoint.
Health stays unknown until an authorized integration actually reports it.

## 10. Enable Telegram only after identity configuration

Set `data/operator/identities.json` to real numeric Telegram sender IDs referencing
the actual OCC administrator UUID. Add exact negative group IDs separately. A
group allowlist never authorizes an unknown sender. Preserve any WhatsApp entries
when editing. Use a **new, separate OCC bot**, never TelegramDL's token.

Put the bot token into private `data/operator/telegram-token` using a secure editor.
Set core `.env` to `OCC_MODE=live`, `OCC_TELEGRAM_ENABLED=true`, and restart only
OCC core so it reloads the mapping. Validate core, then the worker:

```sh
docker compose up -d --no-build core
docker compose exec core node dist/src/operator/preflight-cli.js --skip-port
docker compose --profile telegram run --rm --no-deps telegram node dist/src/operator/preflight-cli.js --role telegram
docker compose --profile telegram up -d --no-build telegram
```

The shared registry sends useful scoped `/status` data in authorized private
chats. Groups receive minimal status/help/health/uptime only. `/system`, projects,
containers and logs remain private and permission-checked. Telegram's bounded
polling supervisor handles transient failures; auth/conflicting polling requires
operator inspection. Never run two polling workers for the same bot.

## 11. Enable Baileys only after explicit pairing

Add exact normalized `digits@s.whatsapp.net` or `digits@lid` sender identities to
the same OCC user, and approved `...@g.us` groups separately. LID and phone JID are
not implicitly interchangeable: if the platform changes the observed identity,
commands fail closed until the operator explicitly adds the new mapping. Group
identity comes from the actual participant, never the chat ID or a guessed phone.

Set `OCC_WHATSAPP_ENABLED=true`; restart core and run core preflight. Initialize/
check the separate session volume using a one-off worker **preflight command**:

```sh
docker compose --profile whatsapp run --rm --no-deps whatsapp node dist/src/operator/preflight-cli.js --role whatsapp
```

An unpaired session error is expected. Stop only OCC's WhatsApp service if one is
running. On a private terminal, securely set `OCC_WHATSAPP_PAIR_PHONE` (digits with
country code, no `+`) in your shell, then run:

```sh
docker compose --profile whatsapp run --rm --no-deps -e OCC_WHATSAPP_PAIR_PHONE whatsapp
```

Complete device linking on the phone using the one-time code. The application
requests pairing at most once in that process; it never silently loops pairing on
auth failure. Wait for the dashboard to observe connected, then stop the one-off
worker gracefully, unset the pairing variable, and start the normal worker:

```sh
docker compose --profile whatsapp up -d --no-build whatsapp
```

Only that worker mounts the 0700 session volume. Session files are 0600. One
exclusive lock prevents duplicate workers. Network interruptions/restart-required
closures allow at most six classified reconnects per 15 minutes with bounded
exponential delay and jitter. Auth failure, logout, invalid session or replacement
stops reconnecting and reports unhealthy/operator-required while remaining
observable. Container startup failures restart at most three times; an unhealthy
terminal state does not automatically restart or pair itself.

## 12. Verify authorization, privacy and health boundaries

Test both adapters with an authorized private `/status` and `/system`; inspect
scope/source and unavailable fields. Confirm minimal `/status` in an approved
group. Test an unknown sender in that group, a linked sender in an unapproved
group, and a sensitive group command: all must be denied. Test `/status@another`
and unknown commands: ignored. Ordinary WhatsApp text must produce no OCC command,
audit body, AI forwarding or integration event. No AI inference exists.

Check Bots for fresh heartbeat, reason, retry count and next retry time; a missing
heartbeat after 45 seconds becomes unobserved. A container health check succeeds
only while connected with a recent successful core heartbeat. Check unavailable
collectors by stopping **only the selected OCC collector** and observing explicit
unavailable states. Restore it and verify recovery. Never test by stopping Kuma,
TelegramDL or removing any existing Docker resource.

## 13. Optional temporary public HTTPS access

Do this only after local checks pass. Use an operator-controlled HTTPS proxy or
tunnel targeting the chosen loopback port. Do not expose public HTTP or bind core
to a public host port. Set exact `OCC_PUBLIC_ORIGIN=https://...`,
`OCC_SECURE_COOKIES=true`, and trusted proxy handling only if core is reachable
solely through that trusted proxy. Preserve `/sys` in forwarded paths. Review
`docker/Caddyfile.example`; it uses `handle`, not prefix-stripping `handle_path`.

Keep login and CSRF protections enabled. No bare-IP certificate is assumed. Test
nested routes, static assets and sign-out at `/sys` and optionally a nested prefix
such as `/control/occ`. Change origin/base path/proxy configuration for the final
domain; no frontend rebuild or business logic changes are needed. Codex does not
start this tunnel, publish a URL or perform deployment steps.

## 14. Rollback and recovery

- Keep the previous reviewed OCC image/tag and protected backups. Stop only OCC
  core for a simple consistent copy of its SQLite volume, including DB/WAL/SHM.
  Back up WhatsApp separately while only its worker is stopped. Treat that backup
  as account authentication material. Never store it in Git or AI project context.
- No schema change is required for 0.1.1, so Phase 1 SQLite records remain valid.
  Review future migrations before downgrades; do not reset a DB to fix an upgrade.
- If rollout fails, stop only OCC services, retain volumes/configuration, select
  the previous image, restore only a verified consistent OCC backup if necessary,
  and repeat private readiness checks. Do not use `down -v`, broad Docker removal,
  prune or commands naming existing unrelated applications.
- For network/retry exhaustion, inspect connectivity and then restart only the
  affected OCC worker. For auth/logout/replacement, stop the worker, revoke/repair
  the relevant account/session deliberately, then perform explicit pairing only
  if required. Do not delete credentials to force a reconnect.
- Graceful WhatsApp shutdown releases its lock. After a crash/SIGKILL a stale lock
  remains intentionally. Confirm **all** OCC WhatsApp workers and one-off pairing
  containers using that volume are stopped. Preserve a private session backup.
  Only then remove the exact `/app/sessions/whatsapp/.occ-worker.lock` inside that
  specific OCC volume via an explicit operator maintenance action. Never use
  wildcard deletion, remove `creds.json` or clear the session directory as a
  shortcut. Start exactly one worker and check its classified state.
- Retain the recorded pre-deployment application inventory and confirm Kuma and
  TelegramDL still run independently. They require no rollback because OCC never
  modified their deployments.

## Development and CI evidence

`npm run check`, `npm run test:browser`, and the credential-free
`python3 scripts/container-smoke.py <built-image> [arm64|amd64]` validate different
layers. The smoke creates a UUID Compose project, temporary credentials/volumes,
one owned standalone test container and a worker-like probe; it verifies actual
collector observations, standalone/Compose discovery, SQLite restart persistence,
non-root permissions, health, RSS, and collector denial by DNS **and IP** from the
gateway+egress networks. It removes only those disposable resources. CI executes
it on `ubuntu-24.04-arm`. Configuration is not proof of a passing CI run, and
neither local/CI validation establishes that the production server was tested.
