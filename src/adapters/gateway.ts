import type { CommandRouter, CommandResult } from '../core/commands.js';
import type { IdentityService } from '../core/identity.js';
import type { Audit } from '../core/audit.js';
import { randomUUID } from 'node:crypto';

export interface IncomingCommand {
  senderId: string; chatId: string; group: boolean; text: string;
  addressedTo?: string; directedElsewhere?: boolean;
}
export type Dispatch = (platform: 'telegram' | 'whatsapp', message: IncomingCommand) => Promise<CommandResult | null>;
export function createDispatch(router: CommandRouter, identities: IdentityService, audit: Audit): Dispatch {
  return async (platform, message) => {
    if (message.directedElsewhere) return null;
    const parsed = router.parse(message.text, message.addressedTo);
    if (!parsed) return null;
    const requestId = randomUUID();
    try {
      const actor = identities.resolve(platform, message.senderId, message.chatId, message.group);
      return await router.execute(parsed.name, parsed.args, actor, requestId);
    } catch {
      audit.record('command.authorization', 'denied', requestId);
      return { ok: false, code: 'FORBIDDEN', text: 'Not authorized' };
    }
  };
}
/** Mocks exercise exactly the same dispatcher as the live transports. */
export class MockMessagingAdapter {
  constructor(readonly platform: 'telegram' | 'whatsapp', private dispatch: Dispatch) {}
  receive(message: IncomingCommand) { return this.dispatch(this.platform, message); }
}
