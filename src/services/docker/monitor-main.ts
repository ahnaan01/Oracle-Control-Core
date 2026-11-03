import { createMonitorServer } from './monitor-worker.js';
const server = createMonitorServer();
server.listen(2375, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => server.close());
