import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../config.js';
import { readSecret } from '../security/secrets.js';
import { validateMappings } from './identities.js';
import { DockerMonitor } from '../services/docker.js';
import { SystemMonitor } from '../services/system.js';

export interface Check { id: string; level: 'pass' | 'warn' | 'error'; message: string }
export type Role = 'core' | 'telegram' | 'whatsapp' | 'docker-monitor';
export async function portAvailable(host: string, port: number): Promise<'free' | 'busy' | 'unavailable'> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'EADDRINUSE' ? 'busy' : 'unavailable'));
    server.listen(port, host, () => server.close(() => resolve('free')));
  });
}
export async function preflight(env: NodeJS.ProcessEnv, options: { role?: Role; skipPort?: boolean; probeCollectors?: boolean;
  portCheck?: typeof portAvailable } = {}) {
  const checks: Check[] = []; const role = options.role ?? 'core';
  const add = (id: string, level: Check['level'], message: string) => checks.push({ id, level, message });
  const finish = () => ({ ok: !checks.some(c => c.level === 'error'), role, checks });
  let config;
  try { config = loadConfig(env); add('configuration', 'pass', 'Configuration schema, origin and credential rules passed'); }
  catch { add('configuration', 'error', 'Invalid configuration or unreadable credential file; check origin, base path, collector settings and private *_FILE bindings'); return finish(); }
  async function privatePath(id: string, path: string, directory: boolean) {
    try {
      const info = await stat(path);
      if (directory ? !info.isDirectory() : !info.isFile()) throw new Error();
      if (info.mode & 0o077) { add(id, 'error', 'Unsafe permissions: directory requires 0700, file requires 0600'); return false; }
      await access(path, constants.R_OK | (directory ? constants.W_OK : 0));
      add(id, 'pass', 'Private path exists and is accessible'); return true;
    } catch { add(id, 'error', 'Required directory/file is missing or inaccessible; prepare the correct mount without replacing existing data'); return false; }
  }
  const dotenvExists = await stat('.env').then(() => true).catch(() => false);
  if (dotenvExists) await privatePath('dotenv-permissions', '.env', false);
  if (role === 'core') {
    const knownUsers = new Set<string>(); let admins = 0;
    if (config.OCC_DB_PATH === ':memory:') add('database', 'error', 'Deployment preflight requires a persistent SQLite path');
    else {
      await privatePath('database-directory', dirname(config.OCC_DB_PATH), true);
      if (await privatePath('database-file', config.OCC_DB_PATH, false)) {
        let db: DatabaseSync | undefined;
        try {
          db = new DatabaseSync(config.OCC_DB_PATH, { readOnly: true });
          const version = db.prepare('PRAGMA user_version').get()?.user_version;
          if (version !== 1) throw new Error();
          for (const row of db.prepare('SELECT id,permissions FROM users').all()) {
            knownUsers.add(row.id as string);
            if ((JSON.parse(row.permissions as string) as string[]).includes('admin')) admins++;
          }
          add('database-schema', 'pass', 'Supported Phase 1 database; no migration or mutation performed');
        } catch { add('database-schema', 'error', 'Cannot read a supported existing OCC database'); }
        finally { db?.close(); }
      }
    }
    add('administrator', admins > 0 ? 'pass' : 'error', admins > 0 ? 'An administrator exists' : 'Bootstrap the administrator in the actual data volume before starting core');
    let mappings: ReturnType<typeof validateMappings> | undefined;
    if (config.OCC_IDENTITY_FILE && await privatePath('identity-file', config.OCC_IDENTITY_FILE, false)) {
      try { mappings = validateMappings(JSON.parse(await readFile(config.OCC_IDENTITY_FILE, 'utf8')), knownUsers); add('identities', 'pass', 'Exact sender/group IDs and internal user references are valid'); }
      catch { add('identities', 'error', 'Invalid sender/group format, duplicate mapping or unknown OCC user ID'); }
    } else if (config.OCC_MODE === 'live') add('identities', 'error', 'Live mode requires an explicit private identity mapping file');
    for (const platform of ['telegram', 'whatsapp'] as const) {
      const enabled = platform === 'telegram' ? config.OCC_TELEGRAM_ENABLED : config.OCC_WHATSAPP_ENABLED;
      if (config.OCC_MODE === 'live' && enabled) {
        const token = platform === 'telegram' ? config.OCC_TELEGRAM_GATEWAY_TOKEN : config.OCC_WHATSAPP_GATEWAY_TOKEN;
        add(`${platform}-gateway`, token && mappings?.identities.some(m => m.platform === platform) ? 'pass' : 'error',
          'Enabled live transport requires its own credential and explicit sender mapping');
      }
    }
    if (!options.skipPort) {
      const port = await (options.portCheck ?? portAvailable)(config.OCC_HOST, config.OCC_PORT);
      add('listen-port', port === 'busy' ? 'error' : port === 'free' ? 'pass' : 'warn', port === 'busy' ? 'Configured local port is already in use' : port === 'free' ? 'Configured local listen port is free' : 'Cannot verify port availability in this execution context');
    }
    if (config.OCC_DOCKER_MODE === 'proxy') {
      add('docker-credential', config.OCC_DOCKER_MONITOR_TOKEN ? 'pass' : 'error', 'Read-only Docker discovery requires a private monitor credential');
      if (options.probeCollectors) { const result = await new DockerMonitor(config).list(); add('docker-collector', result.available ? 'pass' : 'error', result.available ? 'Authenticated Docker inventory works' : 'Docker monitor unavailable: check socket group, read-only mount, token and isolated network'); }
      else add('docker-collector', 'warn', 'Connectivity not tested; run --probe-collectors from core network namespace after starting collectors');
    } else add('docker-collector', 'warn', config.OCC_DOCKER_MODE === 'mock' ? 'Mock inventory is not deployment validation' : 'Docker disabled; existing projects can still be registered manually');
    if (config.OCC_HOST_MONITOR_MODE === 'collector') {
      if (options.probeCollectors) { const result = await new SystemMonitor(config).snapshot(); add('host-collector', result.host.available ? 'pass' : 'error', result.host.available ? 'Authenticated fresh host metrics observed' : 'Host collector unavailable: check explicit read-only mounts, token, clock and network'); }
      else add('host-collector', 'warn', 'Host collector is configured but not probed');
    } else add('host-collector', 'warn', 'Host collector disabled; no host totals will be inferred');
  } else if (role === 'docker-monitor') {
    try {
      if (!(await stat('/var/run/docker.sock')).isSocket()) throw new Error();
      await access('/var/run/docker.sock', constants.R_OK | constants.W_OK);
      if (!readSecret(env, 'OCC_DOCKER_MONITOR_TOKEN')) throw new Error();
      add('docker-socket', 'pass', 'Socket and monitor credential accessible; only the fixed inventory request is implemented');
    } catch { add('docker-socket', 'error', 'Socket/credential inaccessible; verify monitor-only mount and actual socket GID'); }
  } else {
    const name = `OCC_${role.toUpperCase()}_GATEWAY_TOKEN`;
    add('transport-mode', config.OCC_MODE === 'live' ? 'pass' : 'error', 'Workers require explicit live mode');
    let validUrl = false;
    try {
      const url = new URL(env.OCC_CORE_URL ?? '');
      validUrl = !url.username && !url.password && !url.search && !url.hash && /\/api\/v1\/?$/.test(url.pathname)
        && (url.protocol === 'https:' || (url.protocol === 'http:' && ['core', 'localhost', '127.0.0.1'].includes(url.hostname)));
    } catch { /* Fail closed without echoing a potentially credential-bearing URL. */ }
    add('core-url', validUrl ? 'pass' : 'error', 'Worker requires a clean complete core API URL and TLS outside isolated/loopback connections');
    add('gateway-credential', readSecret(env, name) ? 'pass' : 'error', 'Worker requires its own platform gateway credential');
    if (role === 'telegram') add('telegram-credential', /^\d+:[A-Za-z0-9_-]{20,}$/.test(readSecret(env, 'OCC_TELEGRAM_TOKEN') ?? '') ? 'pass' : 'error', 'Telegram worker requires a separate OCC bot credential in the expected format');
    else {
      const directory = env.OCC_WHATSAPP_SESSION_DIR ?? './sessions/whatsapp';
      if (await privatePath('whatsapp-directory', directory, true)) {
        if (await stat(`${directory}/.occ-worker.lock`).then(() => true).catch(() => false)) add('session-lock', 'error', 'Session is locked: do not start a second worker; inspect recovery instructions');
        const paired = await stat(`${directory}/creds.json`).then(() => true).catch(() => false);
        if (paired) await privatePath('whatsapp-session', `${directory}/creds.json`, false);
        add('whatsapp-pairing', paired ? 'pass' : env.OCC_WHATSAPP_PAIR_PHONE ? 'warn' : 'error', paired ? 'Existing session found; account authorization still requires a live handshake' : 'Unpaired: an explicit one-time operator pairing is required');
      }
    }
  }
  return finish();
}
