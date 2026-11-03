import { HostCollector } from './collector.js';
import { monitorServer } from '../monitor-server.js';
import { readSecret } from '../../security/secrets.js';
const collector = new HostCollector();
const server = monitorServer(readSecret(process.env, 'OCC_HOST_MONITOR_TOKEN') ?? '', '/metrics', () => collector.snapshot());
server.listen(2376, process.env.OCC_COLLECTOR_HOST ?? '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => server.close());
