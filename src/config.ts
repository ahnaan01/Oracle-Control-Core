import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform(v => v === 'true');
const optionalToken = z.preprocess(v => v === '' ? undefined : v, z.string().min(32).optional());
const schema = z.object({
  OCC_MODE: z.enum(['mock', 'live']).default('mock'),
  OCC_HOST: z.string().default('127.0.0.1'),
  OCC_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  OCC_BASE_PATH: z.string().regex(/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/).default('/sys'),
  OCC_PUBLIC_ORIGIN: z.url().default('http://localhost:3000'),
  OCC_DB_PATH: z.string().default('./data/occ.sqlite'),
  OCC_SECURE_COOKIES: bool.default(false),
  OCC_TRUST_PROXY: bool.default(false),
  OCC_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  OCC_DOCKER_MODE: z.enum(['disabled', 'mock', 'proxy']).default('disabled'),
  OCC_DOCKER_PROXY_URL: z.url().optional(),
  OCC_IDENTITY_FILE: z.string().optional(),
  OCC_TELEGRAM_GATEWAY_TOKEN: optionalToken,
  OCC_WHATSAPP_GATEWAY_TOKEN: optionalToken,
});

export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = schema.parse(env);
  const origin = new URL(config.OCC_PUBLIC_ORIGIN);
  if (origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash)
    throw new Error('OCC_PUBLIC_ORIGIN must be an origin without a path or credentials');
  if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('HTTP(S) origin required');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (!local && (origin.protocol !== 'https:' || !config.OCC_SECURE_COOKIES))
    throw new Error('Public access requires HTTPS and secure cookies');
  if (config.OCC_SECURE_COOKIES && origin.protocol !== 'https:')
    throw new Error('Secure cookies require an HTTPS public origin');
  if (config.OCC_DOCKER_MODE === 'proxy' && !config.OCC_DOCKER_PROXY_URL)
    throw new Error('Read-only Docker proxy URL required');
  if (config.OCC_MODE === 'live' && config.OCC_DOCKER_MODE === 'mock')
    throw new Error('Mock Docker is not permitted in live mode');
  if (config.OCC_TELEGRAM_GATEWAY_TOKEN && config.OCC_WHATSAPP_GATEWAY_TOKEN &&
      config.OCC_TELEGRAM_GATEWAY_TOKEN === config.OCC_WHATSAPP_GATEWAY_TOKEN)
    throw new Error('Telegram and WhatsApp must use different transport credentials');
  return config;
}
