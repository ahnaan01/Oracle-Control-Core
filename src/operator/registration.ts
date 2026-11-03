import { z } from 'zod';
import { manifestSchema, metadataSchema } from '../../packages/integration-sdk/src/schema.js';
const inputSchema = z.object({
  id: z.enum(['uptime-kuma', 'telegramdl']), name: z.string().min(1).max(100),
  version: z.string().min(1).max(50), runtime: z.enum(['docker', 'compose']),
  containerId: z.string().regex(/^[a-f0-9]{12,64}$/).optional(), composeProject: z.string().min(1).max(100).optional(),
  projectDirectory: z.string().max(500).optional(), configurationLocations: z.array(z.string().max(500)).default([]),
}).strict();
export function existingRegistration(raw: unknown) {
  const input = inputSchema.parse(raw);
  if (input.runtime === 'compose' ? !input.composeProject : !input.containerId) throw new Error('Supply the actual resource identity');
  return { manifest: manifestSchema.parse({ protocolVersion: '1.0', id: input.id, name: input.name, version: input.version,
    runtime: input.runtime, description: 'Existing independent deployment; metadata registration only' }),
    metadata: metadataSchema.parse({ containerId: input.containerId, composeProject: input.composeProject,
      projectDirectory: input.projectDirectory, configurationLocations: input.configurationLocations }) };
}
