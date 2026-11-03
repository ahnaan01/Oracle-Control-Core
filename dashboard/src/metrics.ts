import type { SystemMonitor } from '../../src/services/system.js';
export type Metrics = Awaited<ReturnType<SystemMonitor['snapshot']>>;
export function metricView(metrics?: Metrics) {
  const host = metrics?.host.available ? metrics.host.metrics : null;
  const container = metrics?.container.available ? metrics.container : null;
  return {
    source: host ? 'Host · isolated read-only collector' : container ? 'OCC container/cgroup v2 · not host totals' : 'Host and cgroup metrics unavailable',
    cpuPercent: host?.cpu.usagePercent ?? (host ? null : container?.cpu?.usagePercent ?? null),
    cores: host?.cpu.cores ?? container?.cpu?.limitCores ?? null,
    memory: host?.memory ?? container?.memory ?? null,
    disk: host?.disk ?? (metrics?.disk ? { ...metrics.disk, usedBytes: metrics.disk.totalBytes - metrics.disk.availableBytes } : null),
    diskScope: host?.disk ? 'Selected host filesystem' : 'OCC application filesystem · not confirmed host disk',
    uptime: host?.uptimeSeconds ?? null,
    sampledAt: host?.sampledAt ?? container?.sampledAt ?? metrics?.sampledAt,
    network: host?.network ?? metrics?.network ?? null,
    networkScope: host?.network ? 'Host interface counters' : 'OCC runtime network namespace',
    hostReason: metrics?.host.reason ?? 'Waiting for backend observations',
  };
}
