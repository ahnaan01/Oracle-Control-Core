import 'dotenv/config';
import { Api, Bot } from 'grammy';
import { transportClient } from '../client.js';
import { ConnectionSupervisor, classifyDisconnect } from '../recovery.js';
import { workerReporter } from '../runtime.js';
import { errorCode } from '../messages.js';
import { pollingConnection } from './polling.js';
import { readSecret } from '../../security/secrets.js';

process.umask(0o077);
const dispatch = transportClient('telegram'); const reporter = workerReporter(dispatch, 'telegram');
const cursor = { offset: 0 };
const supervisor = new ConnectionSupervisor(async (hooks, signal) => {
  await dispatch.refreshCatalog();
  const token = readSecret(process.env, 'OCC_TELEGRAM_TOKEN');
  if (!token) { hooks.failed({ retry: false, reason: 'authentication' }); return { close() {} }; }
  const api = new Api(token, { timeoutSeconds: 25 });
  try {
    // grammY's Node declarations use the abort-controller polyfill; Node 24 signals are runtime-compatible.
    const me = await api.getMe(signal as unknown as Parameters<Api['getMe']>[0]); const bot = new Bot(token, { botInfo: me, client: { timeoutSeconds: 25 } });
    bot.on('message:text', async ctx => {
      if (!ctx.from || ctx.from.is_bot || !['private', 'group', 'supergroup'].includes(ctx.chat.type) || !dispatch.accepts(ctx.message.text, me.username)) return;
      const result = await dispatch('telegram', { senderId: String(ctx.from.id), chatId: String(ctx.chat.id),
        group: ctx.chat.type !== 'private', text: ctx.message.text, addressedTo: me.username });
      if (result) await ctx.reply(result.text.slice(0, 3500));
    });
    if (!cursor.offset) {
      const pending = await api.getUpdates({ offset: -1, limit: 1, timeout: 0 }, signal as unknown as Parameters<Api['getMe']>[0]);
      cursor.offset = (pending[0]?.update_id ?? 0) + 1;
    }
    return pollingConnection((offset, abort) => api.getUpdates({ offset, timeout: 20, limit: 20, allowed_updates: ['message'] }, abort as unknown as Parameters<Api['getMe']>[0]),
      update => bot.handleUpdate(update), cursor, hooks, signal);
  } catch (error) { hooks.failed(classifyDisconnect('telegram', errorCode(error))); return { close() {} }; }
}, state => reporter.update(state));
for (const event of ['SIGINT', 'SIGTERM'] as const) process.once(event, () => {
  void supervisor.stop().then(() => reporter.stop()).then(() => { process.exitCode = 0; });
});
await supervisor.start();
