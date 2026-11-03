import type { Dispatch } from './gateway.js';
import { z } from 'zod';
import { readSecret } from '../security/secrets.js';
import { parseRecognizedCommand } from '../core/command-parser.js';
import type { WorkerState } from './recovery.js';

export function transportClient(platform: 'telegram' | 'whatsapp') {
  if (process.env.OCC_MODE !== 'live') throw new Error('Live transports require OCC_MODE=live; use npm run demo for mocks');
  const origin = z.url().parse(process.env.OCC_CORE_URL);
  const url = new URL(origin);
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', 'core'].includes(url.hostname))
    throw new Error('Remote transport traffic requires HTTPS');
  const token = z.string().min(32).parse(readSecret(process.env, `OCC_${platform.toUpperCase()}_GATEWAY_TOKEN`));
  let catalog = new Set<string>();
  const dispatch: Dispatch = async (_platform, message) => {
    const response = await fetch(`${origin.replace(/\/$/, '')}/gateway/${platform}/commands`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(message), signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Core rejected transport request (${response.status})`);
    const result = await response.json() as { data: Awaited<ReturnType<Dispatch>> };
    return result.data;
  };
  return Object.assign(dispatch, {
    accepts: (text: string, addressedTo?: string) => !!parseRecognizedCommand(text, catalog, addressedTo),
    refreshCatalog: async () => {
      const response = await fetch(`${origin.replace(/\/$/, '')}/gateway/${platform}/catalog`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      if (!response.ok) throw new Error('Command catalog unavailable');
      const result = await response.json() as { data: unknown };
      catalog = new Set(z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).max(100).parse(result.data));
    }, status: async (status: WorkerState) => {
    const response = await fetch(`${origin.replace(/\/$/, '')}/gateway/${platform}/status`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(status), signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!response.ok) throw new Error('Heartbeat failed');
  } });
}
