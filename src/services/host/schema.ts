import { z } from 'zod';
const number = z.number().finite().nonnegative();
export const hostMetricsSchema = z.object({
  protocolVersion: z.literal('1.0'), scope: z.literal('host'), source: z.literal('isolated-procfs-collector'),
  sampledAt: z.iso.datetime(),
  cpu: z.object({ cores: number, usagePercent: number.max(100).nullable(), load: z.array(number).length(3) }).strict(),
  memory: z.object({ totalBytes: number, availableBytes: number, usedBytes: number }).strict(),
  disk: z.object({ totalBytes: number, availableBytes: number, usedBytes: number, scope: z.literal('selected host filesystem') }).strict().nullable(),
  network: z.array(z.object({ interface: z.string().max(80), receivedBytes: number, transmittedBytes: number }).strict()).max(100).nullable(),
  uptimeSeconds: number,
}).strict();
export type HostMetrics = z.infer<typeof hostMetricsSchema>;
