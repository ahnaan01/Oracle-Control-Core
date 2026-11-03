import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, access, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomToken } from '../security/crypto.js';
import { loadConfig } from '../config.js';
import { validateMappings } from './identities.js';

export const setupSchema = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/).default('admin'), adminId: z.uuid().optional(),
  basePath: z.string().default('/sys'), bindPort: z.number().int().min(1024).max(65535).default(3300),
  publicOrigin: z.url().optional(), dockerMode: z.enum(['disabled', 'proxy']).default('disabled'),
  hostMonitoring: z.boolean().default(false), telegramEnabled: z.boolean().default(false), whatsappEnabled: z.boolean().default(false),
  telegramIds: z.array(z.string()).default([]), whatsappJids: z.array(z.string()).default([]),
  groups: z.array(z.object({ platform: z.enum(['telegram', 'whatsapp']), chatId: z.string() }).strict()).default([]),
}).strict();
/** Writes operator-owned config only; never touches an existing DB or existing configuration. */
export async function prepareSetup(input: unknown, root: string) {
  const options = setupSchema.parse(input); const adminId = options.adminId ?? randomUUID();
  const publicOrigin = options.publicOrigin ?? `http://localhost:${options.bindPort}`;
  loadConfig({ OCC_BASE_PATH: options.basePath, OCC_PUBLIC_ORIGIN: publicOrigin,
    OCC_SECURE_COOKIES: String(publicOrigin.startsWith('https://')) });
  const mapping = validateMappings({ identities: [
    ...options.telegramIds.map(senderId => ({ platform: 'telegram', senderId, userId: adminId })),
    ...options.whatsappJids.map(senderId => ({ platform: 'whatsapp', senderId, userId: adminId })),
  ], groups: options.groups });
  if ((options.telegramEnabled && !options.telegramIds.length) || (options.whatsappEnabled && !options.whatsappJids.length))
    throw new Error('Enabled transports need explicit administrator sender mappings');
  const operator = join(root, 'data/operator');
  for (const path of [join(root, 'data'), operator]) {
    const existing = await lstat(path).catch(() => null);
    if (existing && (existing.isSymbolicLink() || !existing.isDirectory() || (existing.mode & 0o077)))
      throw new Error('Operator configuration parents must be private real directories');
  }
  const files: Record<string, string> = {
    [join(operator, 'identities.json')]: JSON.stringify(mapping, null, 2) + '\n',
    ...Object.fromEntries(['telegram-gateway', 'whatsapp-gateway', 'docker-monitor', 'host-monitor'].map(name => [join(operator, name), randomToken() + '\n'])),
    [join(operator, 'telegram-token')]: '', // Operator fills this only when enabling Telegram.
  };
  const env = {
    OCC_MODE: 'mock', OCC_HOST: '127.0.0.1', OCC_PORT: String(options.bindPort), OCC_BIND_PORT: String(options.bindPort),
    OCC_BASE_PATH: options.basePath, OCC_PUBLIC_ORIGIN: publicOrigin, OCC_SECURE_COOKIES: String(publicOrigin.startsWith('https://')),
    OCC_CORE_URL: `http://127.0.0.1:${options.bindPort}${options.basePath}/api/v1`,
    OCC_WHATSAPP_SESSION_DIR: './sessions/whatsapp', OCC_TRUST_PROXY: 'false', OCC_UID: String(process.getuid?.() ?? 1000), OCC_GID: String(process.getgid?.() ?? 1000),
    OCC_BOOTSTRAP_ADMIN_ID: adminId, OCC_BOOTSTRAP_ADMIN_USERNAME: options.username,
    OCC_DOCKER_MODE: options.dockerMode, OCC_HOST_MONITOR_MODE: options.hostMonitoring ? 'collector' : 'disabled',
    OCC_DOCKER_PROXY_URL: 'http://docker-monitor:2375', OCC_HOST_MONITOR_URL: 'http://host-monitor:2376',
    OCC_IDENTITY_FILE: './data/operator/identities.json',
    OCC_TELEGRAM_ENABLED: String(options.telegramEnabled), OCC_WHATSAPP_ENABLED: String(options.whatsappEnabled),
    OCC_TELEGRAM_GATEWAY_TOKEN_FILE: './data/operator/telegram-gateway', OCC_WHATSAPP_GATEWAY_TOKEN_FILE: './data/operator/whatsapp-gateway',
    OCC_DOCKER_MONITOR_TOKEN_FILE: './data/operator/docker-monitor', OCC_HOST_MONITOR_TOKEN_FILE: './data/operator/host-monitor',
    OCC_TELEGRAM_TOKEN_FILE: './data/operator/telegram-token', OCC_HOST_DISK_PATH: './config/host-disk',
  };
  if (env.OCC_UID === '0') throw new Error('Run setup as the non-root deployment operator');
  files[join(root, '.env')] = Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
  for (const file of Object.keys(files)) {
    if (!resolve(file).startsWith(resolve(root) + '/')) throw new Error('Invalid setup output');
    const exists = await access(file).then(() => true).catch(() => false);
    if (exists) throw new Error('Configuration exists; refusing to overwrite. Review existing .env and data/operator files.');
  }
  await mkdir(operator, { recursive: true, mode: 0o700 });
  for (const [file, value] of Object.entries(files)) await writeFile(file, value, { flag: 'wx', mode: 0o600 });
  return { adminId, username: options.username, basePath: options.basePath };
}
