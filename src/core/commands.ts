import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../database/store.js';
import type { Actor, Permission, Platform } from './identity.js';
import { requirePermission } from './identity.js';
import type { Projects } from './projects.js';
import type { Audit } from './audit.js';
import type { SystemMonitor } from '../services/system.js';
import type { DockerMonitor } from '../services/docker.js';
import { OccError, forbidden } from './errors.js';
import { parseRecognizedCommand } from './command-parser.js';

export interface CommandResult { ok: boolean; code: string; text: string; data?: unknown; taskId?: string }
interface Command {
  name: string; aliases: string[]; description: string; arguments: z.ZodType<string[]>;
  permission: Permission; platforms: Platform[]; groupSafe: boolean;
  handle: (args: string[], actor: Actor) => Promise<unknown> | unknown;
}
const noArgs = z.array(z.string()).length(0);
const projectArg = z.array(z.string().regex(/^[a-z][a-z0-9-]{1,62}$/)).length(1);
export class CommandRouter {
  private commands = new Map<string, Command>();
  constructor(private store: Store, private audit: Audit, projects: Projects, system: SystemMonitor, docker: DockerMonitor) {
    const add = (name: string, description: string, permission: Permission, groupSafe: boolean,
      handle: Command['handle'], argumentsSchema = noArgs, aliases: string[] = []) => this.register({ name,
      description, permission, groupSafe, handle, arguments: argumentsSchema, aliases,
      platforms: ['telegram', 'whatsapp', 'dashboard', 'ai'] });
    add('help', 'List commands available to you', 'status:read', true, (_args, actor) =>
      [...new Set(this.commands.values())].filter(c => c.platforms.includes(actor.platform) && (!actor.group || c.groupSafe)
        && (actor.permissions.includes('admin') || actor.permissions.includes(c.permission)))
        .map(c => ({ command: `/${c.name}`, description: c.description })), noArgs, ['start']);
    add('status', 'Core and scoped monitoring status', 'status:read', true, async (_args, actor) => {
      if (actor.group) return { status: 'ok', version: '0.1.1' };
      // The status permission alone must not bypass detailed system/container permissions.
      const data: Record<string, unknown> = { status: 'ok', version: '0.1.1', process: { uptimeSeconds: process.uptime() } };
      if (actor.permissions.includes('admin') || actor.permissions.includes('projects:read')) data.projects = projects.list().length;
      if (actor.permissions.includes('admin') || actor.permissions.includes('system:read')) {
        const metrics = await system.snapshot();
        const host = metrics.host.metrics;
        data.host = { ...metrics.host, metrics: host ? { sampledAt: host.sampledAt, cpu: { cores: host.cpu.cores, usagePercent: host.cpu.usagePercent },
          memory: host.memory, disk: host.disk, uptimeSeconds: host.uptimeSeconds } : null };
        data.container = metrics.container; data.process = metrics.process;
        data.applicationFilesystem = { scope: 'OCC application filesystem, not confirmed host disk', ...metrics.disk };
      }
      if (actor.permissions.includes('admin') || actor.permissions.includes('containers:read')) {
        const inventory = await docker.list(); data.docker = { available: inventory.available, mode: inventory.mode, reason: inventory.reason };
      }
      return data;
    });
    add('health', 'Core health', 'status:read', true, () => ({ status: 'ok', database: 'ready' }));
    add('uptime', 'OCC process uptime', 'status:read', true, () => ({ processUptimeSeconds: process.uptime() }));
    add('system', 'Runtime OS metrics', 'system:read', false, () => system.snapshot());
    add('projects', 'Registered applications', 'projects:read', false, () => projects.list().map(p => ({ id: p.id, name: p.manifest.name, health: p.health })));
    add('project', 'Project status: /project <id>', 'projects:read', false, args => {
      const p = projects.get(args[0]!); return { id: p.id, name: p.manifest.name, health: p.health, lastCheck: p.lastCheck };
    }, projectArg);
    add('containers', 'Read-only container inventory', 'containers:read', false, () => docker.list());
    add('logs', 'Log availability: /logs <id>', 'logs:read', false, args => {
      projects.get(args[0]!);
      return { available: false, reason: 'Raw application logs are disabled in Phase 1 to prevent credential and conversation disclosure' };
    }, projectArg);
  }
  register(command: Command) {
    for (const name of [command.name, ...command.aliases]) {
      if (this.commands.has(name)) throw new Error(`Duplicate command: ${name}`);
      this.commands.set(name, command);
    }
  }
  /** A missing parse result is ignored, never audited or sent to AI. */
  parse(text: string, addressedTo?: string) {
    return parseRecognizedCommand(text, new Set(this.commands.keys()), addressedTo);
  }
  catalog() { return [...this.commands.keys()]; }
  async execute(name: string, args: string[], actor: Actor, requestId: string = randomUUID()): Promise<CommandResult> {
    const command = this.commands.get(name);
    const taskId = randomUUID();
    try {
      if (!command) throw new OccError('UNKNOWN_COMMAND', 'Unknown command', 404);
      requirePermission(actor, command.permission);
      if (!command.platforms.includes(actor.platform) || (actor.group && !command.groupSafe)) throw forbidden();
      const validated = command.arguments.parse(args);
      this.store.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(taskId, actor.userId, command.name, 'running', new Date().toISOString());
      const data = await command.handle(validated, actor);
      this.store.db.prepare('UPDATE tasks SET status=? WHERE id=?').run('completed', taskId);
      this.audit.record(`command.${command.name}`, 'completed', requestId, actor);
      return { ok: true, code: 'OK', data, text: JSON.stringify(data, null, 2), taskId };
    } catch (error) {
      this.store.db.prepare('UPDATE tasks SET status=? WHERE id=?').run('failed', taskId);
      // Only registry-controlled names are recorded, never untrusted command text or arguments.
      this.audit.record(command ? `command.${command.name}` : 'command.unknown', 'denied_or_failed', requestId, actor);
      const code = error instanceof OccError ? error.code : error instanceof z.ZodError ? 'INVALID_ARGUMENTS' : 'INTERNAL_ERROR';
      return { ok: false, code, text: error instanceof OccError ? error.message : code === 'INVALID_ARGUMENTS' ? 'Invalid command arguments' : 'Command failed' };
    }
  }
}
