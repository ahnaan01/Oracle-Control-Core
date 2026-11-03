# Deployment reference (Phase 1.1)

For an initial server installation, follow **[FIRST_DEPLOYMENT.md](FIRST_DEPLOYMENT.md)**
in order. It covers existing application inspection, resources, private setup,
core-only startup, an operator-created SSH tunnel, collectors, registration,
live messaging, HTTPS and recovery. Codex must never execute those production
steps or contact the Oracle server. Kuma and TelegramDL remain independent.

## Local development

Node 24 LTS and `npm ci` are sufficient. Copy `.env.example` to `.env`, set its mode
to 0600, run `npm run admin`, then `npm run dev`. No external credentials are
required. `npm run check` runs lint, strict types, tests, build and a disposable
loopback demo. `npm run test:browser` uses installed Chromium (`OCC_CHROMIUM_PATH`)
with all external browser requests blocked. It tests login, nested routing,
registration, preferences, mobile layout and logout at two prefixes.

Mock messaging and disabled Docker/host collectors are defaults. Container mocks
are explicitly labeled and rejected in live mode. System observations are real
or explicitly unavailable; host, cgroup and process scopes are never conflated.

## Private setup and preflight

`npm run setup -- config/setup.local.json` reads operator answers based on
`config/setup.example.json`. It generates an internal administrator UUID (or uses
an explicit existing one), mappings and distinct credential files. Existing target
files/DBs are never overwritten. It writes `.env`/files 0600 and new directories
0700. Passwords and real messaging credentials are not accepted in the answers.

Bootstrap the account in the actual selected SQLite volume using the admin CLI.
Use the compiled helper inside the image when the host does not have Node. See
FIRST_DEPLOYMENT.md for both paths. Do not create a host-local admin DB and assume
it is the same as the Compose named volume.

`npm run preflight` checks configuration without displaying values. The compiled
entry is `node dist/src/operator/preflight-cli.js`. Roles are core (default),
telegram, whatsapp and docker-monitor. Core inspects DB v1 read-only, administrator
presence, identity formats/references, permissions, origin, enabled transport
credentials, and a local listen port. Workers inspect only their own credentials
and session material. Use `--skip-port` for checks inside an already running core,
and `--probe-collectors` to check authenticated collector observations from core's
network. A port test checks only the current namespace; inspect the actual host
binding with `ss` before deployment. Warnings for disabled collectors are expected.

Never dump `.env`, process environments, session files or raw SDK exceptions.
Never loosen file permissions merely to make a non-root container read secrets;
use the matching configured UID/GID and inspect the mount.

## Compose and data compatibility

Compose requires the private files produced by setup before first startup. Build
with `OCC_UID`/`OCC_GID` matching the non-root operator. Keep existing volume IDs
and ownership during an upgrade; setup does not migrate, erase or chown them.
SQLite remains `user_version=1`; users, projects, tokens and histories are retained.

Only core starts by default. Docker binds to `127.0.0.1:${OCC_BIND_PORT:-3300}`;
choose an unused port and a unique independent project name if `occ` is taken.
Do not set container_name or import existing apps. Named SQLite and WhatsApp
volumes remain separate. A healthy live worker needs a recent connected heartbeat;
a terminal authentication state is unhealthy but does not trigger automatic pairing.

Optional profiles are `monitoring` (Docker), `host-monitoring`, `telegram` and
`whatsapp`. Enable each explicitly in the order in FIRST_DEPLOYMENT.md. Collectors
have no published port; their separate internal networks attach only core and
that collector. Workers use gateway/egress networks only. The only Docker-socket
mount is the monitor; only fixed inventory GETs are implemented. The host collector
mounts individual read-only counter files plus a selected non-sensitive disk
directory. There is no unrestricted host root, host PID mode or privileged runtime.

Both live transports use the same core-provided command catalog and dispatcher.
Unknown/ordinary conversations never reach it. WhatsApp uses exact primary sender
JIDs, including group participants; LID changes require explicit mapping updates.
Classified transient failures allow at most six reconnects in 15 minutes; auth,
invalid session, replacement and unknown protocol failures require the operator.
Pairing is explicit and one-shot per process. Follow the guide for stale lock
recovery; never delete credentials or run a second session as a reconnect shortcut.

## ARM64, resource limits and image validation

The multi-stage official Node 24 image supports Linux ARM64 and AMD64; SQLite is
bundled in Node. The builder includes Git/CA trust for the pinned public Baileys
Git dependency. The runtime has no compiler/Git. Containers are non-root,
read-only-rootfs, capability-dropped, no-new-privileges, resource/PID limited and
have bounded shutdown time. A 384 MiB core budget is tested as a ceiling, not a
promise of continuous use. Observe your actual 2 OCPU / ~11 GiB host before enabling
optional services. cgroup v1 is reported unavailable rather than guessed.

`python3 scripts/container-smoke.py occ:local amd64` tests a locally built image;
use `arm64` only on a native/suitable builder. The script always selects the local
managed daemon, creates unique disposable resources, and removes only its own
project/volumes/probes. Do not substitute a valued production Compose project.
Native ARM64 GitHub CI builds the image and runs the same real isolation,
persistence and monitoring smoke on `ubuntu-24.04-arm`. Report observed results,
not just the workflow definition, before claiming ARM64 validation.

For a managed-cloud build, preserve the existing proxy and supply its public CA:

```sh
docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" -t occ:local .
```

The CA is an optional BuildKit secret mount used by npm/Git, not copied into
layers. Do not disable TLS or expected integrity checks. Ordinary operator builds
without that proxy need no CA mount.

## HTTPS, prefix routing and backups

Use `OCC_PUBLIC_ORIGIN` for the exact browser origin (no path),
`OCC_BASE_PATH=/sys` (or a nested prefix), secure cookies for public HTTPS, and
trusted proxy handling only behind a trusted isolated edge. Preserve the prefix
with Caddy `handle`, not `handle_path`. See `docker/Caddyfile.example`. Temporary
HTTPS tunnels are operator-run only, targeting loopback. No public HTTP admin
listener or bare-IP certificate is assumed. Root `/` stays free for other apps.

Back up SQLite consistently with core stopped (or the SQLite backup API), retaining
DB/WAL/SHM together. Back up WhatsApp separately with its worker stopped. Do not
store either backup in Git/AI context. Retain prior OCC image/configuration for
rollback. Never run broad Docker prune/removal, erase volumes or stop unrelated
applications to repair OCC. See the ordered recovery section of FIRST_DEPLOYMENT.md.
