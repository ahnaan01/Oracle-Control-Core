import type { IncomingCommand } from './gateway.js';
export function errorCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return;
  const record = error as Record<string, unknown>;
  const output = record.output && typeof record.output === 'object' ? record.output as Record<string, unknown> : {};
  return typeof record.error_code === 'number' ? record.error_code : typeof output.statusCode === 'number' ? output.statusCode : undefined;
}
interface WhatsAppMessage {
  key?: { remoteJid?: string | null; participant?: string | null; fromMe?: boolean | null; id?: string | null };
  message?: { conversation?: string | null; extendedTextMessage?: { text?: string | null; contextInfo?: { mentionedJid?: string[] | null } | null } | null } | null;
}
export function whatsappCommand(message: WhatsAppMessage, ownJids: string[], normalize: (jid: string) => string,
  accepts: (text: string) => boolean): (IncomingCommand & { messageId: string }) | null {
  const chatId = message.key?.remoteJid; const text = message.message?.conversation ?? message.message?.extendedTextMessage?.text;
  if (!chatId || message.key?.fromMe || !message.key?.id || !text || !accepts(text)) return null;
  const group = chatId.endsWith('@g.us');
  if (!group && !/^\d+@(s\.whatsapp\.net|lid)$/.test(chatId)) return null;
  const sender = group ? message.key?.participant : chatId;
  if (!sender) return null;
  const mentions = message.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
  if (mentions.length && !mentions.some(jid => ownJids.includes(normalize(jid)))) return null;
  return { senderId: normalize(sender), chatId, group, text, messageId: message.key.id };
}
export class MessageDeduplicator {
  private seen = new Map<string, number>();
  accept(id: string, now = Date.now()) {
    for (const [key, at] of this.seen) if (now - at > 5 * 60_000) this.seen.delete(key);
    if (this.seen.has(id)) return false;
    this.seen.set(id, now);
    if (this.seen.size > 2000) this.seen.delete(this.seen.keys().next().value!);
    return true;
  }
}
