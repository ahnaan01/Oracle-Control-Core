import 'dotenv/config';
import { Bot } from 'grammy';
import { z } from 'zod';
import { transportClient } from '../client.js';

const dispatch = transportClient('telegram');
const bot = new Bot(z.string().min(10).parse(process.env.OCC_TELEGRAM_TOKEN));
// No handlers for ordinary conversations; do not log updates or errors containing API tokens.
bot.on('message:text', async ctx => {
  if (!ctx.message.text.startsWith('/') || !ctx.from || ctx.from.is_bot) return;
  if (!['private', 'group', 'supergroup'].includes(ctx.chat.type)) return;
  const result = await dispatch('telegram', { senderId: String(ctx.from.id), chatId: String(ctx.chat.id),
    group: ctx.chat.type !== 'private', text: ctx.message.text, addressedTo: bot.botInfo.username });
  if (result) await ctx.reply(result.text.slice(0, 3500));
});
bot.catch(() => console.error('Telegram command delivery failed'));
process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
await bot.start({ drop_pending_updates: true, onStart: () => {
  const heartbeat = () => { void dispatch.status('connected').catch(() => console.error('Core heartbeat failed')); };
  heartbeat(); setInterval(heartbeat, 30_000).unref();
} });
