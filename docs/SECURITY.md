# Security and privacy model

## Default posture

Development needs no live credentials. Messaging is mocked, Docker is disabled,
the bind address is loopback, and all administrative APIs require authentication.
No Oracle address, SSH client, cloud SDK, deployment target or automatic service
probe is configured. Never connect to the production Oracle server from Codex.

No unrestricted execution, Docker writes, shell endpoint, source-code mutation,
AI inference, file editing or deletion is implemented. `/logs` returns an explicit
unavailable result rather than exposing arbitrary application logs. Project URLs
and path metadata are not fetched/read, preventing an integration manifest from
turning core into an SSRF proxy or filesystem browser.

## Browser authentication

- Local bootstrap creates an administrator with a random password shown once, or
  a supplied 16–256 character password. No default credentials are shipped.
- Passwords use asynchronous scrypt (N=65536, r=8, p=1), 16-byte random salts and
  64-byte hashes. Invalid-user login still runs the same KDF. Login is limited to
  five requests per minute per IP; all API traffic is bounded to 120/minute/IP.
- Sessions are server-side, with 256-bit opaque identifiers stored as SHA-256
  hashes. Cookies are HttpOnly, SameSite=Strict, scoped to the configured prefix,
  Secure under HTTPS, and expire after eight hours. Login replaces a prior browser
  session; logout revokes the DB record.
- Login requires the exact `OCC_PUBLIC_ORIGIN`. All authenticated state changes
  require both that Origin and a per-session CSRF token. CSRF tokens stay in UI
  memory; no authentication secrets are stored in localStorage or frontend code.
- Security headers include CSP (`self` scripts and styles, no inline scripts,
  frames or objects), nosniff and conditional HSTS. No CORS access is granted.
  Built assets are served by exact generated filenames, not generic filesystem
  traversal or directory listing.
- Public HTTP origins are rejected. Enable trusted proxy handling only when core
  is reachable solely through your trusted proxy; otherwise forwarded IP headers
  could defeat IP limits. The HTTPS edge is an operator responsibility.

## Identity and messaging

Allowlisting a group does not authorize a sender. The exact individual platform
identity must link to an OCC user, and that user must hold the command permission.
Default group-safe operations are help/start, status, health and uptime; projects,
system data, containers and log availability are private-only. An authorized user
may use private chats without separately allowlisting that private chat.

Identity links are explicit in an operator-controlled JSON file. Unknown OCC
users, duplicate mappings or invalid mappings fail startup; there are no implicit
username/name/phone guesses. Both platforms may deliberately map to the same user
for a common task and audit history. A compromised linked messaging account can
exercise that user's permitted read operations; revoke the link and restart core.

Telegram trusts grammY's `from.id` (not group membership or display names), rejects
bot senders and channels, and supports `/command@botname`. WhatsApp trusts Baileys'
sender JID, considers the actual group participant, accepts only recognized slash-commands, ignores history sync/from-self/status broadcasts, and ignores commands
directed elsewhere. Unknown commands, ordinary conversations and unapproved
targets are never persisted as commands or forwarded to an AI/n8n subsystem.

Live transport credentials are platform-specific: a WhatsApp worker credential
cannot authenticate as Telegram. They authorize transport ingress only, not
dashboard APIs or integration APIs. A compromised worker can impersonate allowlisted
senders **on its own platform**, so isolate workers and protect their credentials.
Use TLS between machines; the sample Compose HTTP transport is isolated locally.

Baileys session material lives only in its own worker/volume, with process umask
077 and a 0700 directory. Never mount it in core or AI tools. The worker disables
Baileys logging and full history sync; no application conversation archive is
maintained. Baileys inherently processes encrypted transport/session metadata;
protect backups as authentication material. Pair only on an operator-controlled
terminal and never publish a pairing code or QR image. Live account behavior and
pairing require operator validation; mocks do not verify the WhatsApp service.

## Integration security

Project tokens have 256 random bits, hashed storage, expiry (1–90 days), explicit
scopes and revocation. Only a browser administrator may register projects, issue
tokens or approve operations. Bearer identities are pinned to one project; request
bodies cannot select another project, override permissions or widen a manifest.
Registration is confirmation of the administrator-approved manifest, not
anonymous self-enrollment. No token grants dashboard or host-management access.

Strict Zod schemas bound manifests/events. Event names and subscriptions must use
the project's namespace; only own declared events are accessible. Payloads contain
allowlisted scalar status/code/value metadata, not arbitrary bodies. The sender
must not put credentials or private text in free-text description/status fields.
All requests have a 32 KiB limit. Events need an idempotency key; replaying identical
data returns the original ID without another bus notification, while changing the
data returns CONFLICT. Idempotency lasts only while the record is retained.

There are no outbound webhooks yet; signing, replay protection, delivery cursors,
bounded exponential retries and explicit outbound destination policies must land
together before that feature is enabled. Never silently turn manifest endpoints
into callable remote operations.

## Storage, auditing and logs

SQLite files are 0600 and new data directories are 0700; process umask is 077.
Keep the DB, WAL and SHM files in a protected volume. SQLite metadata is not
encrypted at rest; use encrypted host storage/backups where necessary. Core does
not read Baileys auth files or persist raw integration token values.

Audits record internal user, platform, chat ID when authorized, registry-controlled
action, outcome, request ID and timestamp. Command arguments, replies, login
passwords, tokens, SDK exception objects and raw chats are excluded. Rejected
unknown identities are recorded without their submitted message text. Request
logging is disabled to prevent query/body/header capture; server errors log only
an internal code and request ID. Retention cleanup runs every minute with age and
count bounds. Stopping the process also stops cleanup; this is not a forensic log
or durable delivery system.

## Docker and future filesystem operations

The Docker socket provides effectively host-root authority even when mounted
`:ro`. Only the opt-in small monitor process mounts it. Its only literal upstream
request lists containers; it accepts no caller-supplied Docker API route. Treat
that sidecar as a privileged security boundary, patch it, and never publish its
port or attach untrusted workloads to its internal network. Each collector additionally requires its own file-backed bearer credential.
Docker and host collectors have distinct internal networks; neither messaging
worker joins them. CI checks denial by DNS and IP from a gateway+egress probe.
The host collector sees individual counter files and a selected empty disk
directory only. Core has no host-procfs or host-root mount. Core and workers use
non-root users, dropped capabilities, no-new-privileges and read-only rootfs.

Recovery permits at most six transient reconnects per rolling 15-minute window.
Retired connection generations cannot schedule new retries; sessions/listeners
close before replacements. Logout, invalid session, auth failure, replacement and
unknown protocol failures require operator action. Explicit WhatsApp pairing can
be requested at most once per process. A terminal state stays observable rather
than relying on an unlimited restart policy. The exclusive WhatsApp lock survives
crashes deliberately; stale recovery requires an explicit operator inspection,
not automatic credential deletion. See FIRST_DEPLOYMENT.md for exact recovery.

`npm run setup` generates new, private individual credential files and refuses
existing targets. It never changes an existing database. `npm run preflight`
uses read-only DB access and fixed diagnostics with no submitted values, tokens
or raw SDK errors. File-backed credentials require a regular private file (0600).
Core never mounts a directory containing all worker credentials.

The future path-policy helper rejects absolute paths and realpath traversal or
symlink escapes. It is for **existing read targets only**. It is not a safe file
write implementation and does not solve TOCTOU races. No file API currently uses
it. A future executor needs per-project policy, race-safe open semantics,
previews/diffs, explicit deletion authorization, recoverable changes and Git
rollback before it may expose mutation tools.

Report security defects privately to the repository owner. Run `npm audit` when
upgrading dependencies and preserve TLS, artifact integrity and signature checks.
The lockfile uses a targeted `minimatch` 11 override to resolve the development
lint toolchain's pattern-amplification advisory; lint/type/test checks validate the
upgrade. Reassess that override when upstream tooling adopts the patched release.
