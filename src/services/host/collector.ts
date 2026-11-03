import { readFile, statfs } from 'node:fs/promises';
import { parseNetwork } from '../system.js';
import { hostMetricsSchema } from './schema.js';

export function parseMeminfo(text: string) {
  const values = Object.fromEntries([...text.matchAll(/^(MemTotal|MemAvailable):\s+(\d+) kB$/gm)].map(m => [m[1], Number(m[2]) * 1024]));
  const totalBytes = values.MemTotal; const availableBytes = values.MemAvailable;
  if (!totalBytes || availableBytes === undefined || availableBytes > totalBytes) throw new Error('Invalid host memory counters');
  return { totalBytes, availableBytes, usedBytes: totalBytes - availableBytes };
}
export function parseCpu(text: string) {
  const line = /^cpu\s+(.+)$/m.exec(text)?.[1];
  if (!line) throw new Error('Invalid host CPU counters');
  const ticks = line.trim().split(/\s+/).slice(0, 8).map(Number); // guest times are already included; do not count twice.
  if (ticks.length < 4 || ticks.some(x => !Number.isFinite(x) || x < 0)) throw new Error('Invalid host CPU counters');
  return { total: ticks.reduce((a, b) => a + b, 0), idle: ticks[3]! + (ticks[4] ?? 0), cores: [...text.matchAll(/^cpu\d+\s/gm)].length };
}
export class HostCollector {
  private previous?: ReturnType<typeof parseCpu>;
  private cache?: { at: number; metrics: Awaited<ReturnType<HostCollector['collect']>> };
  private pending?: Promise<Awaited<ReturnType<HostCollector['collect']>>>;
  constructor(private root = '/host', private read = readFile, private diskStat = statfs) {}
  private async collect() {
    const [stat, mem, uptime, load, network, disk] = await Promise.all([
      this.read(`${this.root}/stat`, 'utf8'), this.read(`${this.root}/meminfo`, 'utf8'),
      this.read(`${this.root}/uptime`, 'utf8'), this.read(`${this.root}/loadavg`, 'utf8'),
      this.read(`${this.root}/netdev`, 'utf8').then(parseNetwork).catch(() => null),
      this.diskStat(`${this.root}/disk`).then(s => ({ totalBytes: s.blocks * s.bsize, availableBytes: s.bavail * s.bsize,
        usedBytes: (s.blocks - s.bfree) * s.bsize, scope: 'selected host filesystem' as const })).catch(() => null),
    ]);
    const cpu = parseCpu(stat); const previous = this.previous; this.previous = cpu;
    const totalDelta = previous ? cpu.total - previous.total : 0;
    const usagePercent = previous && totalDelta > 0 ? Math.max(0, Math.min(100, 100 * (1 - (cpu.idle - previous.idle) / totalDelta))) : null;
    return hostMetricsSchema.parse({ protocolVersion: '1.0', scope: 'host', source: 'isolated-procfs-collector', sampledAt: new Date().toISOString(),
      cpu: { cores: cpu.cores, usagePercent, load: load.trim().split(/\s+/).slice(0, 3).map(Number) },
      memory: parseMeminfo(mem), uptimeSeconds: Number(uptime.split(' ')[0]), network, disk });
  }
  async snapshot() {
    if (this.cache && Date.now() - this.cache.at < 5000) return this.cache.metrics;
    if (!this.pending) this.pending = this.collect().then(metrics => { this.cache = { at: Date.now(), metrics }; return metrics; })
      .finally(() => { this.pending = undefined; });
    return this.pending;
  }
}
