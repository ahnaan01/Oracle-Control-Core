// Design contract only: no AI inference, filesystem edits, or arbitrary execution.
import type { Actor } from '../src/core/identity.js';
import type { CommandRouter } from '../src/core/commands.js';
export interface AIProvider { complete(authorizedContext: string): Promise<unknown> }
export interface ToolCall { name: 'status' | 'health' | 'system' | 'projects' | 'project' | 'containers'; args: string[] }
export function invokeReadOnlyTool(router: CommandRouter, actor: Actor, call: ToolCall) {
  // Actor must originate from IdentityService, never from a model response.
  return router.execute(call.name, call.args, { ...actor, platform: 'ai' });
}
