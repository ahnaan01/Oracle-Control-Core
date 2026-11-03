import { z } from 'zod';
import type { Config } from '../config.js';
import { collectorJson } from './collector-client.js';

const containerSchema = z.object({
  Id: z.string(), Names: z.array(z.string()), Image: z.string(), State: z.string(), Status: z.string(),
  Labels: z.record(z.string(), z.string()).default({}),
});
export function parseContainers(raw: unknown) {
  return z.array(containerSchema).max(1000).parse(raw).map(c => ({
    id: c.Id, name: c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12), image: c.Image,
    state: c.State, status: c.Status,
    composeProject: c.Labels['com.docker.compose.project'] ?? null,
    composeService: c.Labels['com.docker.compose.service'] ?? null,
    health: /\(unhealthy\)/.test(c.Status) ? 'unhealthy' : /\(healthy\)/.test(c.Status) ? 'healthy' : /\(health: starting\)/.test(c.Status) ? 'starting' : 'unknown',
  }));
}
export class DockerMonitor {
  constructor(private config: Config) {}
  async list() {
    if (this.config.OCC_DOCKER_MODE === 'disabled') return { available: false, mode: 'disabled', containers: [], reason: 'Docker monitoring is not configured' };
    if (this.config.OCC_DOCKER_MODE === 'mock') return { available: true, mode: 'mock', containers: parseContainers([
      { Id: 'mock-kuma', Names: ['/sample-kuma'], Image: 'sample/kuma', State: 'running', Status: 'Up (healthy)', Labels: {} },
      { Id: 'mock-dl', Names: ['/sample-dl'], Image: 'sample/telegramdl', State: 'running', Status: 'Up', Labels: { 'com.docker.compose.project': 'sample-downloads', 'com.docker.compose.service': 'telegramdl' } },
    ]), reason: 'Explicit mock fixtures; no Docker connection' };
    try {
      if (!this.config.OCC_DOCKER_MONITOR_TOKEN) throw new Error('Monitor credential missing');
      const data = await collectorJson(new URL('/containers', this.config.OCC_DOCKER_PROXY_URL), this.config.OCC_DOCKER_MONITOR_TOKEN, 2_000_000);
      return { available: true, mode: 'proxy', containers: parseContainers(data), reason: null };
    } catch { return { available: false, mode: 'proxy', containers: [], reason: 'Read-only Docker monitor unavailable' }; }
  }
}
