import { mkdir, open, readFile, unlink, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkerState } from './recovery.js';
import { transportClient } from './client.js';

export async function acquireSessionLock(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, '.occ-worker.lock'); const owner = randomUUID();
  try {
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ owner, pid: process.pid })); } finally { await handle.close(); }
  } catch { throw new Error('Session is locked. Stop other workers; inspect the exact lock before operator recovery.'); }
  return async () => {
    try { if (JSON.parse(await readFile(path, 'utf8')).owner === owner) await unlink(path); } catch { /* Never remove another owner’s lock. */ }
  };
}
export function workerReporter(client: ReturnType<typeof transportClient>, platform: string) {
  let state: WorkerState = { status: 'starting', reason: 'none', attempt: 0, nextRetryAt: null };
  let stopped = false; let pending = false;
  const file = `/tmp/occ-${platform}-health.json`;
  const report = async () => {
    if (pending || stopped) return;
    pending = true;
    try {
      await client.status(state);
      await writeFile(`${file}.tmp`, JSON.stringify({ ...state, reportedAt: Date.now() }), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    } catch { // Keep heartbeat fresh only when both transport and core have been observed.
      await writeFile(file, JSON.stringify({ ...state, reason: 'core_unreachable', reportedAt: 0 }), { mode: 0o600 }).catch(() => {});
    } finally { pending = false; }
  };
  const timer = setInterval(() => { void report(); }, 15_000); // Keeps terminal/auth-required state observable; never auto-pairs.
  return { update: (next: WorkerState) => { state = next; void report(); },
    stop: async () => { clearInterval(timer); await report(); stopped = true; } };
}
