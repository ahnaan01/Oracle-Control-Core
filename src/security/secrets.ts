import { readFileSync, statSync } from 'node:fs';

/** Support file-backed credentials without ever placing their values in diagnostics. */
export function readSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (!file) return env[name] || undefined;
  if (env[name]) throw new Error(`Use either ${name} or ${name}_FILE`);
  try {
    const info = statSync(file);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 4096) throw new Error();
    return readFileSync(file, 'utf8').trim();
  } catch { throw new Error(`${name}_FILE must be a readable private regular file (0600)`); }
}
