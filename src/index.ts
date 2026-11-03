import 'dotenv/config';
import { loadConfig } from './config.js';
import { createApp } from './api/app.js';

process.umask(0o077);
const config = loadConfig();
const { app } = await createApp(config);
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, async () => { await app.close(); });
await app.listen({ host: config.OCC_HOST, port: config.OCC_PORT });
app.log.info({ mode: config.OCC_MODE, basePath: config.OCC_BASE_PATH }, 'OCC started; no production services are contacted automatically');
