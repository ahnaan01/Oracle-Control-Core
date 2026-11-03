import os from 'node:os';
import { readFile, readdir, statfs } from 'node:fs/promises';

export function parseNetwork(text: string) {
  return text.split('\n').slice(2).flatMap(line => {
    const [name, fields] = line.split(':');
    if (!name || !fields) return [];
    const values = fields.trim().split(/\s+/).map(Number);
    if (values.length < 16 || values.some(n => !Number.isFinite(n) || n < 0)) return [];
    return [{ interface: name.trim(), receivedBytes: values[0]!, transmittedBytes: values[8]! }];
  });
}
function cpuTicks() {
  return os.cpus().reduce((out, cpu) => ({ idle: out.idle + cpu.times.idle,
    total: out.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
}
export class SystemMonitor {
  private previous = cpuTicks();
  private cached?: { at: number; value: Awaited<ReturnType<SystemMonitor['collect']>> };
  private pending?: Promise<Awaited<ReturnType<SystemMonitor['collect']>>>;
  async collect() {
    const current = cpuTicks(); const delta = current.total - this.previous.total;
    const usage = delta > 0 ? 100 * (1 - (current.idle - this.previous.idle) / delta) : null;
    this.previous = current;
    const [disk, network, processes] = await Promise.all([
      statfs(process.cwd()).then(x => ({ totalBytes: x.blocks * x.bsize, availableBytes: x.bavail * x.bsize })).catch(() => null),
      readFile('/proc/net/dev', 'utf8').then(parseNetwork).catch(() => null),
      readdir('/proc').then(x => x.filter(n => /^\d+$/.test(n)).length).catch(() => null),
    ]);
    return { sampledAt: new Date().toISOString(), scope: 'runtime OS view (may reflect container/host limits)',
      cpu: { cores: os.availableParallelism(), usagePercent: usage, load: os.loadavg() },
      memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() }, disk, network,
      uptimeSeconds: os.uptime(), processUptimeSeconds: process.uptime(), processCount: processes,
      processMemoryBytes: process.memoryUsage().rss, os: os.platform(), architecture: os.arch() };
  }
  async snapshot() {
    if (this.cached && Date.now() - this.cached.at < 5000) return this.cached.value;
    if (!this.pending) this.pending = this.collect().then(value => {
      this.cached = { at: Date.now(), value }; return value;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
}
