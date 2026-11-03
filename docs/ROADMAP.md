# Delivery status and next phases

## Initial implementation

Milestone 1: central foundation implemented. Strict TypeScript, Fastify, SQLite
migrations, sessions/CSRF, permissions, registry, real OS metrics, shared commands,
tasks and content-free audits are present.

Milestone 2: mock adapters and live grammY/Baileys transport code implemented, with
explicit identity mapping, private/group limits, separate credentials and a
separate WhatsApp session volume. Mocks exercise the shared core. Real account
pairing, live platform behavior and reconnect reliability are **not validated**.
Phase 1.1 adds bounded classified reconnects, retired-listener cleanup, a private
worker health heartbeat, exclusive session locking and explicit operator recovery.
Live platform behavior remains unverified; mocked recovery does not validate
pairing or account compatibility.

Milestone 3: login and seven dashboard pages implemented under a runtime-configured
base path, including nested routes, assets and API calls. Monitoring uses actual
runtime OS data with explicit limitations. Settings currently support refresh
interval; identity/security/network configuration remains operator-controlled.

Milestone 4: v1 protocol, manifest schema, scoped revocable project tokens,
administrator-approved cached read operations, health reports, namespaced metadata
events, idempotency, best-effort polling subscriptions, SDK and working local
example implemented. OpenAPI and HTTP documentation are included. Not implemented:
arbitrary remote project callbacks, cross-project event grants, webhook signing,
durable outbound delivery/retries, n8n or a published standalone SDK package.

Milestone 5: non-root multi-stage Dockerfile, independent Compose stack, optional
read-only Docker inventory boundary, resource limits, health check, graceful core
shutdown, reverse proxy documentation and CI implemented. Native ARM64 image build
and container smoke are included in CI. Local image/architecture validation must
be reported separately from CI configuration or a production deployment; neither
configuration files nor unit tests establish that the user's server was tested.

## Intentional Phase 1 limits

- No production server access, cloud SDK, automatic discovery registration, or
  changes to Kuma/TelegramDL. Register discovered resources explicitly.
- `/logs` reports unavailable; safe per-project redaction/export is future work.
- Docker inventory only. No restart/deploy/update/Compose mutation API. systemd
  units can be registered as metadata but are not actively inspected or managed.
- Phase 1.1 supplies separate cgroup v2 and authenticated host-collector data.
  cgroup v1 and arbitrary remote collectors are not implemented; unavailable
  counters never imply host totals.
- No password recovery/reset UI, MFA, broad account lifecycle UI, remote identity
  pairing UI or fine-grained dashboard roles. Bootstrap is an explicit local CLI.
- No AI inference, shell execution, file mutation, n8n, Google Drive, Plex or manga
  library feature. The small AI tool contract is architecture only.

## Phase 1.1 deployment readiness

Implemented: scoped private `/status`, isolated host collector, cgroup v2/process
metrics, separate authenticated collector networks, classified bounded worker
recovery, privacy filtering from a core command catalog, setup/preflight helpers,
metadata-only existing-project registration bundles, dashboard freshness and
cancellation, and the ordered FIRST_DEPLOYMENT.md guide. SQLite remains schema v1.

Native ARM64 CI runs an actual resource-limited image/Compose smoke with generated
credentials, standalone and Compose inventory, persistent user/project restart,
private session volume and DNS/IP network-denial checks. Local AMD64 and GitHub
ARM64 execution results must be reported separately. No real messaging accounts
or production server are exercised by these checks.

## Future custom AI controller

1. Add a provider abstraction with explicit opt-in credentials, budgets and
   timeouts. Do not use a third-party agent framework or local model requirement.
2. Retrieve only authorized, allowlisted project context with bounded size;
   exclude credentials, WhatsApp sessions, raw chats and unrelated directories.
3. Map model tool requests into existing structured commands with an actor resolved
   from OCC identity. Recheck permissions at execution time; model text is never
   authority. Verify and audit results using the same task history.
4. Design any write-capable executor separately: fixed typed operations, per-project
   policy, previews/diffs, explicit approvals for destructive changes, race-safe
   filesystem access, recoverable operations and Git rollback. Never add a generic
   shell endpoint as a shortcut.
5. Add remote operations and automation only with explicit destination controls,
   authenticated payloads, signatures/replay protection, idempotency, bounded
   retention and safe retries. Test failure paths before enabling them.
