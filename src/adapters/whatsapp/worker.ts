import 'dotenv/config';
import { mkdir, chmod } from 'node:fs/promises';
import pino from 'pino';
import { transportClient } from '../client.js';
import { ConnectionSupervisor, classifyDisconnect } from '../recovery.js';
import { acquireSessionLock, workerReporter } from '../runtime.js';
import { errorCode, MessageDeduplicator, whatsappCommand } from '../messages.js';
import { PairingGate } from '../pairing.js';

process.umask(0o077);
const dispatch = transportClient('whatsapp'); const reporter = workerReporter(dispatch, 'whatsapp');
const directory = process.env.OCC_WHATSAPP_SESSION_DIR ?? './sessions/whatsapp';
await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
const unlock = await acquireSessionLock(directory);
const { default: makeSocket, useMultiFileAuthState, jidNormalizedUser } = await import('@whiskeysockets/baileys');
const deduplicate = new MessageDeduplicator(); const pairing = new PairingGate();
let savePending: Promise<void> = Promise.resolve();
const supervisor = new ConnectionSupervisor(async (hooks) => {
  await dispatch.refreshCatalog();
  const { state, saveCreds } = await useMultiFileAuthState(directory);
  const phone = process.env.OCC_WHATSAPP_PAIR_PHONE;
  if (!pairing.mayOpen(!!state.creds.registered, phone)) {
    hooks.failed({ retry: false, reason: 'authentication' }); return { close() {} };
  }
  const socket = makeSocket({ auth: state, logger: pino({ level: 'silent' }), syncFullHistory: false,
    markOnlineOnConnect: false, shouldSyncHistoryMessage: () => false, getMessage: async () => undefined });
  const creds = () => { savePending = savePending.then(saveCreds).catch(() => { hooks.failed({ retry: false, reason: 'session_invalid' }); }); };
  const connection = (update: Partial<import('@whiskeysockets/baileys').ConnectionState>) => {
    if (update.connection === 'open') hooks.connected();
    if (update.connection === 'close') hooks.failed(classifyDisconnect('whatsapp', errorCode(update.lastDisconnect?.error)));
    if (update.qr && !state.creds.registered) {
      void pairing.request(false, phone, value => socket.requestPairingCode(value))
        .then(code => { if (code) console.log(`One-time pairing code (private operator terminal only): ${code}`); })
        .catch(() => hooks.failed({ retry: false, reason: 'authentication' }));
    }
  };
  const messages = async ({ messages, type }: import('@whiskeysockets/baileys').BaileysEventMap['messages.upsert']) => {
    if (type !== 'notify') return;
    for (const message of messages) {
      const ownIds = [socket.user?.id, socket.user?.lid].filter((x): x is string => !!x).map(jidNormalizedUser);
      const input = whatsappCommand(message, ownIds, jidNormalizedUser, text => dispatch.accepts(text, process.env.OCC_WHATSAPP_COMMAND_NAME ?? 'occ'));
      if (!input || !deduplicate.accept(`${input.chatId}:${input.senderId}:${input.messageId}`)) continue;
      try {
        const command = { senderId: input.senderId, chatId: input.chatId, group: input.group, text: input.text };
        const result = await dispatch('whatsapp', { ...command, addressedTo: process.env.OCC_WHATSAPP_COMMAND_NAME ?? 'occ' });
        if (result) await socket.sendMessage(input.chatId, { text: result.text.slice(0, 3500) });
      } catch { console.error('OCC command delivery failed'); }
    }
  };
  socket.ev.on('creds.update', creds); socket.ev.on('connection.update', connection); socket.ev.on('messages.upsert', messages);
  return { close: async () => {
    socket.ev.off('creds.update', creds); socket.ev.off('connection.update', connection); socket.ev.off('messages.upsert', messages);
    socket.end(undefined); await savePending;
  } };
}, state => reporter.update(state));
let stopping = false;
for (const event of ['SIGINT', 'SIGTERM'] as const) process.once(event, () => {
  if (stopping) return; stopping = true;
  void supervisor.stop().then(unlock).then(() => reporter.stop()).then(() => { process.exitCode = 0; });
});
await supervisor.start();
