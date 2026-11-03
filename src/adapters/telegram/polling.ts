import type { Connection, ConnectionHooks } from '../recovery.js';
import { classifyDisconnect } from '../recovery.js';
import { errorCode } from '../messages.js';
export function pollingConnection<T extends { update_id: number }>(
  poll: (offset: number, signal: AbortSignal) => Promise<T[]>, handle: (update: T) => Promise<void>,
  cursor: { offset: number }, hooks: ConnectionHooks, parent: AbortSignal): Connection {
  const abort = new AbortController();
  const stop = () => abort.abort(); parent.addEventListener('abort', stop, { once: true });
  const task = (async () => {
    try {
      while (!abort.signal.aborted) {
        const updates = await poll(cursor.offset, abort.signal);
        if (abort.signal.aborted) break;
        hooks.connected();
        for (const update of updates) {
          if (abort.signal.aborted) break;
          if (update.update_id < cursor.offset) continue;
          cursor.offset = update.update_id + 1;
          try { await handle(update); } catch { /* Do not repeat uncertain deliveries or log update bodies. */ }
        }
      }
    } catch (error) { if (!abort.signal.aborted) hooks.failed(classifyDisconnect('telegram', errorCode(error))); }
  })();
  return { close: async () => { abort.abort(); parent.removeEventListener('abort', stop); await task; } };
}
