import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectionSupervisor, classifyDisconnect, type ConnectionHooks } from '../src/adapters/recovery.js';
import { acquireSessionLock } from '../src/adapters/runtime.js';
import { whatsappCommand, MessageDeduplicator } from '../src/adapters/messages.js';
import { pollingConnection } from '../src/adapters/telegram/polling.js';
import { parseRecognizedCommand } from '../src/core/command-parser.js';
import { PairingGate } from '../src/adapters/pairing.js';
afterEach(() => vi.useRealTimers());
it('requires explicit pairing and requests it only once even after failure/duplicate readiness', async () => {
  const gate = new PairingGate(); const pair = vi.fn().mockRejectedValue(new Error('auth failure'));
  expect(gate.mayOpen(false)).toBe(false); expect(gate.mayOpen(false, 'not-a-phone')).toBe(false);
  await expect(gate.request(false, '12345678901', pair)).rejects.toThrow();
  expect(await gate.request(false, '12345678901', pair)).toBeNull(); expect(pair).toHaveBeenCalledOnce();
  expect(gate.mayOpen(false, '12345678901')).toBe(false); expect(gate.mayOpen(true)).toBe(true);
});
it.each([401, 403, 411, 440, 500])('never automatically reconnects or re-pairs WhatsApp failure %s', async code => {
  vi.useFakeTimers(); let hooks!: ConnectionHooks;
  const close = vi.fn(); const connect = vi.fn(async (h: ConnectionHooks) => { hooks = h; h.connected(); return { close }; });
  const supervisor = new ConnectionSupervisor(connect, () => {}, Date.now, () => 0);
  await supervisor.start(); hooks.failed(classifyDisconnect('whatsapp', code)); await vi.advanceTimersByTimeAsync(900_000);
  expect(connect).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); expect(supervisor.state.status).not.toBe('connected'); await supervisor.stop();
});
it('reconnects transient failures after closing the old session and ignores retired listeners', async () => {
  vi.useFakeTimers(); const hooks: ConnectionHooks[] = []; const order: string[] = [];
  const supervisor = new ConnectionSupervisor(async h => { hooks.push(h); order.push('open'); h.connected(); return { close: () => { order.push('close'); } }; }, () => {}, Date.now, () => 0);
  await supervisor.start(); hooks[0]!.failed(classifyDisconnect('whatsapp', 408)); await vi.advanceTimersByTimeAsync(1000);
  expect(order).toEqual(['open', 'close', 'open']);
  hooks[0]!.failed(classifyDisconnect('whatsapp', 401)); expect(supervisor.state.status).toBe('connected');
  await supervisor.stop(); expect(order).toEqual(['open', 'close', 'open', 'close']);
});
it('bounds repeated connection failures and cancels pending retries on shutdown', async () => {
  vi.useFakeTimers(); const connect = vi.fn(async (h: ConnectionHooks) => { h.failed({ retry: true, reason: 'network' }); return { close() {} }; });
  const supervisor = new ConnectionSupervisor(connect, () => {}, Date.now, () => 0);
  await supervisor.start(); await vi.advanceTimersByTimeAsync(100_000);
  expect(connect).toHaveBeenCalledTimes(7); expect(supervisor.state.reason).toBe('retries_exhausted');
  await supervisor.stop(); await vi.advanceTimersByTimeAsync(900_000); expect(connect).toHaveBeenCalledTimes(7);
});
it('handles restart-required safely, while Telegram conflict/auth failures are terminal', () => {
  expect(classifyDisconnect('whatsapp', 515)).toEqual({ retry: true, reason: 'restart_required' });
  expect(classifyDisconnect('telegram', 409).retry).toBe(false); expect(classifyDisconnect('telegram', 401).retry).toBe(false);
  expect(classifyDisconnect('telegram', 503).retry).toBe(true);
});
it('locks one WhatsApp session and releases only the owning lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'occ-lock-'));
  try { const release = await acquireSessionLock(directory); await expect(acquireSessionLock(directory)).rejects.toThrow('locked');
    expect(await readFile(join(directory, '.occ-worker.lock'), 'utf8')).not.toContain('credential');
    await release(); await (await acquireSessionLock(directory))();
  } finally { await rm(directory, { recursive: true }); }
});
it('filters ordinary/unknown WhatsApp messages, preserves exact LID participant identity and deduplicates commands', () => {
  const accepts = (text: string) => !!parseRecognizedCommand(text, new Set(['status']), 'occ');
  const key = { id: 'command-id', remoteJid: '123@g.us', participant: '456@lid' };
  for (const text of ['hello private chat', '/unknown sensitive', ' /status', '/status@someone']) expect(whatsappCommand({ key, message: { conversation: text } }, [], x => x, accepts)).toBeNull();
  expect(whatsappCommand({ key, message: { conversation: '/status' } }, [], x => x, accepts)).toMatchObject({ senderId: '456@lid', chatId: '123@g.us', group: true });
  expect(whatsappCommand({ key: { ...key, participant: undefined }, message: { conversation: '/status' } }, [], x => x, accepts)).toBeNull();
  expect(whatsappCommand({ key, message: { extendedTextMessage: { text: '/status', contextInfo: { mentionedJid: ['999@s.whatsapp.net'] } } } }, ['111@lid'], x => x, accepts)).toBeNull();
  const cache = new MessageDeduplicator(); expect(cache.accept('id', 0)).toBe(true); expect(cache.accept('id', 1)).toBe(false); expect(cache.accept('id', 300001)).toBe(true);
});
it('Telegram polling reports a classified interruption and preserves its cursor without replaying updates', async () => {
  const poll = vi.fn().mockResolvedValueOnce([{ update_id: 5 }, { update_id: 5 }]).mockRejectedValueOnce({ error_code: 503 });
  const handle = vi.fn().mockResolvedValue(undefined); const failed = vi.fn(); const cursor = { offset: 0 };
  const connection = pollingConnection(poll, handle, cursor, { connected: vi.fn(), failed }, new AbortController().signal);
  await vi.waitFor(() => expect(failed).toHaveBeenCalledWith({ retry: true, reason: 'network' }));
  expect(handle).toHaveBeenCalledOnce(); expect(cursor.offset).toBe(6); await connection.close();
});
