import 'dotenv/config';
import { mkdir, chmod } from 'node:fs/promises';
import pino from 'pino';
import { transportClient } from '../client.js';

const dispatch = transportClient('whatsapp');
// This process alone mounts the Baileys session directory. Core and future AI never mount it.
process.umask(0o077);
const directory = process.env.OCC_WHATSAPP_SESSION_DIR ?? './sessions/whatsapp';
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
const { default: makeSocket, useMultiFileAuthState, jidNormalizedUser } = await import('@whiskeysockets/baileys');
const { state, saveCreds } = await useMultiFileAuthState(directory);
const socket = makeSocket({ auth: state, logger: pino({ level: 'silent' }),
  syncFullHistory: false, markOnlineOnConnect: false, shouldSyncHistoryMessage: () => false,
  // Baileys can request previously sent content. We deliberately keep no message archive.
  getMessage: async () => undefined,
});
let connected = false;
const heartbeat = () => { void dispatch.status(connected ? 'connected' : 'disconnected').catch(() => console.error('Core heartbeat failed')); };
setInterval(heartbeat, 30_000).unref();
socket.ev.on('creds.update', saveCreds);
socket.ev.on('connection.update', update => {
  if (update.connection) { connected = update.connection === 'open'; heartbeat(); }
  if (update.qr) console.error('WhatsApp pairing required. Use the isolated worker pairing procedure in docs/DEPLOYMENT.md.');
  if (update.connection === 'close') {
    console.error('WhatsApp disconnected; operator must inspect session status before restarting');
    process.exitCode = 1;
    socket.end(undefined);
  }
});
socket.ev.on('messages.upsert', async ({ messages, type }) => {
  if (type !== 'notify') return; // Ignore history sync and offline replay.
  for (const message of messages) {
    const chat = message.key.remoteJid;
    if (!chat || message.key.fromMe || chat === 'status@broadcast') continue;
    const group = chat.endsWith('@g.us');
    if (!group && !chat.endsWith('@s.whatsapp.net') && !chat.endsWith('@lid')) continue;
    const text = message.message?.conversation ?? message.message?.extendedTextMessage?.text;
    if (!text?.startsWith('/')) continue;
    const participant = group ? message.key.participant : chat;
    if (!participant) continue;
    const mentions = message.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
    const ownId = socket.user?.id ? jidNormalizedUser(socket.user.id) : undefined;
    if (mentions.length && !mentions.some(jid => jidNormalizedUser(jid) === ownId)) continue;
    try {
      const result = await dispatch('whatsapp', { senderId: jidNormalizedUser(participant), chatId: chat,
        group, text, addressedTo: process.env.OCC_WHATSAPP_COMMAND_NAME ?? 'occ' });
      if (result) await socket.sendMessage(chat, { text: result.text.slice(0, 3500) });
    } catch { console.error('WhatsApp command delivery failed'); }
  }
});
// Explicit pairing only, never during normal core startup. No QR/session material goes to core.
if (process.env.OCC_WHATSAPP_PAIR_PHONE && !state.creds.registered) {
  if (!/^\d{8,15}$/.test(process.env.OCC_WHATSAPP_PAIR_PHONE)) throw new Error('Invalid pairing phone format');
  const code = await socket.requestPairingCode(process.env.OCC_WHATSAPP_PAIR_PHONE);
  console.log(`One-time WhatsApp pairing code (keep private): ${code}`);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { socket.end(undefined); process.exit(0); });
