import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { setup, seedUser } from './helpers.js';
import type { Application } from '../src/api/app.js';
import { MockMessagingAdapter } from '../src/adapters/gateway.js';
import { invokeReadOnlyTool } from '../agent/tools.js';

let core: Application;
beforeEach(async () => { core = await setup(); seedUser(core, 'not-a-login-hash'); });
afterEach(async () => { await core.app.close(); });
describe('shared registry and privacy', () => {
  it('dispatches both transports to the same command and internal identity', async () => {
    const results = [];
    for (const platform of ['telegram', 'whatsapp'] as const) {
      const adapter = new MockMessagingAdapter(platform, core.dispatch);
      results.push(await adapter.receive({ senderId: platform === 'telegram' ? '123' : '123@s.whatsapp.net',
        chatId: 'private', group: false, text: '/status' }));
    }
    expect(results[0]?.data).toEqual(results[1]?.data);
    expect(results.every(x => x?.ok)).toBe(true);
    const records = core.audit.recent();
    expect(records.map(r => r.user_id)).toEqual(['admin-id', 'admin-id']);
    expect(new Set(records.map(r => r.platform))).toEqual(new Set(['telegram', 'whatsapp']));
    expect(core.store.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id=?').get('admin-id')?.n).toBe(2);
  });
  it.each(['hello private secret', ' /status', '/unknown private secret', '/status@another_bot', 'someone said /status'])('ignores unrelated WhatsApp input: %s', async text => {
    expect(await core.dispatch('whatsapp', { senderId: '123@s.whatsapp.net', chatId: 'private', group: false, text })).toBeNull();
    expect(core.audit.recent()).toHaveLength(0);
    expect(core.store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()?.n).toBe(0);
    expect(core.store.db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(0);
  });
  it('ignores messages explicitly directed to someone else', async () => {
    expect(await core.dispatch('whatsapp', { senderId: '123@s.whatsapp.net', chatId: 'allowed-group', group: true,
      text: '/status', directedElsewhere: true })).toBeNull();
  });
  it('supports Telegram bot suffix and aliases without duplicating handlers', async () => {
    expect(core.router.parse('/STATUS@OccBot', 'occbot')).toEqual({ name: 'status', args: [] });
    const result = await core.dispatch('telegram', { senderId: '123', chatId: 'private', group: false, text: '/start' });
    expect(result?.ok).toBe(true);
    expect(core.audit.recent()[0]?.action).toBe('command.help');
  });
  it('rejects invalid arguments without storing their content', async () => {
    const result = await core.dispatch('telegram', { senderId: '123', chatId: 'private', group: false, text: '/project ../../secret' });
    expect(result?.code).toBe('INVALID_ARGUMENTS');
    expect(JSON.stringify(core.audit.recent())).not.toContain('secret');
  });
});
describe('sender, chat and permission checks', () => {
  it.each([
    ['outsider', 'allowed-group', true, '/status', false],
    ['123', 'unapproved-group', true, '/status', false],
    ['123', 'allowed-group', true, '/status', true],
    ['123', 'allowed-group', true, '/system', false],
    ['123', 'allowed-group', true, '/projects', false],
    ['123', 'allowed-group', true, '/logs test-app', false],
    ['123', 'private', false, '/system', true],
  ])('authorizes sender=%s chat=%s group=%s command=%s', async (senderId, chatId, group, text, allowed) => {
    const result = await core.dispatch('telegram', { senderId, chatId, group, text });
    expect(result?.ok).toBe(allowed);
  });
  it('requires explicit permission even for a linked identity', async () => {
    core.store.db.prepare('UPDATE users SET permissions=?').run(JSON.stringify(['status:read']));
    const actor = core.identities.actor('admin-id');
    expect((await core.router.execute('system', [], actor)).code).toBe('FORBIDDEN');
    expect((await core.router.execute('health', [], actor)).ok).toBe(true);
    expect((await invokeReadOnlyTool(core.router, actor, { name: 'system', args: [] })).code).toBe('FORBIDDEN');
  });
});
