import { z } from 'zod';
export const workerStateSchema = z.object({
  status: z.enum(['starting', 'connecting', 'connected', 'reconnecting', 'disconnected', 'auth_required', 'failed', 'stopped']),
  reason: z.enum(['none', 'network', 'restart_required', 'authentication', 'session_invalid', 'replaced', 'retries_exhausted', 'core_unreachable']).default('none'),
  attempt: z.number().int().min(0).max(6).default(0),
  nextRetryAt: z.string().datetime().nullable().default(null),
}).strict();
export type WorkerState = z.infer<typeof workerStateSchema>;
export type Failure = { retry: boolean; reason: WorkerState['reason'] };
export function classifyDisconnect(platform: 'telegram' | 'whatsapp', code?: number): Failure {
  if (platform === 'whatsapp' && code === 515) return { retry: true, reason: 'restart_required' };
  if ([401, 403].includes(code ?? 0)) return { retry: false, reason: 'authentication' };
  if (platform === 'whatsapp' && [411, 500].includes(code ?? 0)) return { retry: false, reason: 'session_invalid' };
  if (code === 440 || (platform === 'telegram' && code === 409)) return { retry: false, reason: 'replaced' };
  if (code === undefined || [408, 428, 429, 502, 503, 504].includes(code) || (platform === 'telegram' && code >= 500))
    return { retry: true, reason: 'network' };
  return { retry: false, reason: 'session_invalid' }; // Unknown protocol failures require operator inspection.
}
export interface Connection { close(): Promise<void> | void }
export interface ConnectionHooks { connected(): void; failed(failure: Failure): void }
export type Connect = (hooks: ConnectionHooks, signal: AbortSignal) => Promise<Connection>;

/** One connection at a time. At most six reconnects per rolling 15-minute budget. */
export class ConnectionSupervisor {
  state: WorkerState = { status: 'starting', reason: 'none', attempt: 0, nextRetryAt: null };
  private generation = 0; private stopped = false;
  private active?: Connection; private creating?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>; private abort = new AbortController();
  private attempts: number[] = []; private closing: Promise<void> = Promise.resolve();
  constructor(private connect: Connect, private observe: (state: WorkerState) => void,
    private now = Date.now, private random = Math.random) {}
  private update(status: WorkerState['status'], reason: WorkerState['reason'] = 'none', nextRetryAt: string | null = null) {
    this.state = { status, reason, attempt: this.attempts.length, nextRetryAt }; this.observe({ ...this.state });
  }
  async start() {
    if (this.stopped || this.creating || this.active || this.timer) return;
    const generation = ++this.generation;
    this.update('connecting');
    this.creating = (async () => {
      await this.closing;
      try {
        const connection = await this.connect({
          connected: () => { if (!this.stopped && generation === this.generation) this.update('connected'); },
          failed: failure => { if (!this.stopped && generation === this.generation) this.fail(failure); },
        }, this.abort.signal);
        if (this.stopped || generation !== this.generation) await connection.close();
        else this.active = connection;
      } catch { if (!this.stopped && generation === this.generation) this.fail({ retry: true, reason: 'network' }); }
    })().finally(() => { this.creating = undefined; });
    await this.creating;
  }
  private fail(failure: Failure) {
    ++this.generation; // Late events from retired listeners cannot change state or schedule retries.
    const old = this.active; this.active = undefined;
    this.closing = this.closing.then(async () => { await old?.close(); }).catch(() => {});
    if (!failure.retry) { this.update(failure.reason === 'replaced' ? 'failed' : 'auth_required', failure.reason); return; }
    const now = this.now(); this.attempts = this.attempts.filter(at => now - at < 15 * 60_000);
    if (this.attempts.length >= 6) { this.update('failed', 'retries_exhausted'); return; }
    const delay = Math.min(30_000, 1000 * 2 ** this.attempts.length) + Math.floor(this.random() * 500);
    this.attempts.push(now);
    this.update('reconnecting', failure.reason, new Date(now + delay).toISOString());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void (async () => { await this.creating; await this.closing; await this.start(); })();
    }, delay);
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true; ++this.generation; clearTimeout(this.timer); this.timer = undefined;
    this.abort.abort(); await this.creating; await this.closing; await this.active?.close(); this.active = undefined;
    this.update('stopped');
  }
}
