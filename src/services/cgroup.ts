import { readFile } from 'node:fs/promises';
export function parseCgroup(memoryCurrent: string, memoryMax: string, cpuMax: string, cpuStat: string) {
  const usedBytes = Number(memoryCurrent.trim());
  const totalBytes = memoryMax.trim() === 'max' ? null : Number(memoryMax.trim());
  const [quota, period] = cpuMax.trim().split(/\s+/);
  const cores = quota === 'max' ? null : Number(quota) / Number(period);
  const usageUsec = Number(/^usage_usec\s+(\d+)$/m.exec(cpuStat)?.[1]);
  if (![usedBytes, usageUsec].every(n => Number.isFinite(n) && n >= 0) || (totalBytes !== null && (!Number.isFinite(totalBytes) || totalBytes <= 0)) || (cores !== null && (!Number.isFinite(cores) || cores <= 0)))
    throw new Error('Invalid cgroup v2 counters');
  return { memory: { usedBytes, totalBytes, availableBytes: totalBytes === null ? null : Math.max(0, totalBytes - usedBytes) }, cpu: { cores, usageUsec } };
}
export class CgroupMonitor {
  private previous?: { at: number; usage: number };
  constructor(private read = readFile) {}
  async snapshot() {
    try {
      const input = await Promise.all(['memory.current', 'memory.max', 'cpu.max', 'cpu.stat'].map(name => this.read(`/sys/fs/cgroup/${name}`, 'utf8')));
      const data = parseCgroup(input[0]!, input[1]!, input[2]!, input[3]!); const at = performance.now();
      const previous = this.previous; this.previous = { at, usage: data.cpu.usageUsec };
      const cpuCoresUsed = previous && at > previous.at && data.cpu.usageUsec >= previous.usage ? (data.cpu.usageUsec - previous.usage) / ((at - previous.at) * 1000) : null;
      const usagePercent = cpuCoresUsed !== null && data.cpu.cores !== null ? Math.min(100, cpuCoresUsed / data.cpu.cores * 100) : null;
      return { available: true, scope: 'container/cgroup' as const, source: 'cgroup-v2', reason: null,
        sampledAt: new Date().toISOString(), memory: data.memory, cpu: { limitCores: data.cpu.cores, usagePercent, coresUsed: cpuCoresUsed } };
    } catch { return { available: false, scope: 'container/cgroup' as const, source: 'cgroup-v2', reason: 'cgroup v2 counters unavailable; no host totals inferred', sampledAt: null, memory: null, cpu: null }; }
  }
}
