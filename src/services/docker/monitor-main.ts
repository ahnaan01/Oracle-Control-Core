import { createMonitorServer } from './monitor-worker.js';
import { readSecret } from '../../security/secrets.js';
const server = createMonitorServer(readSecret(process.env, 'OCC_DOCKER_MONITOR_TOKEN') ?? '');
server.listen(2375, process.env.OCC_COLLECTOR_HOST ?? '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => server.close());
