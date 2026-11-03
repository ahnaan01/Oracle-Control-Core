import { z } from 'zod';

export const projectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/);
const name = z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/);
const safeUrl = z.url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
}, 'HTTP(S) URLs without credentials only');
export const operationSchema = z.object({
  name, description: z.string().max(200), kind: z.enum(['status', 'health']),
  readOnly: z.literal(true), permission: z.literal('project:read'),
}).strict();
export const manifestSchema = z.object({
  protocolVersion: z.literal('1.0'), id: projectIdSchema,
  name: z.string().min(1).max(100), description: z.string().max(1000).default(''),
  version: z.string().min(1).max(50), runtime: z.enum(['docker', 'compose', 'systemd', 'node', 'external']),
  capabilities: z.array(name).max(30).default([]),
  healthEndpoint: safeUrl.optional(),
  operations: z.array(operationSchema).max(30).default([]),
  eventsPublished: z.array(name).max(30).default([]),
  eventsConsumed: z.array(name).max(30).default([]),
  requiredPermissions: z.array(z.enum(['project:read', 'health:write', 'events:write', 'events:read', 'operations:invoke'])).max(5).default([]),
  configuration: z.array(z.object({ name, description: z.string().max(200), required: z.boolean() }).strict()).max(30).default([]),
  dashboard: z.object({ label: z.string().max(100), url: safeUrl.optional() }).strict().optional(),
}).strict().superRefine((manifest, ctx) => {
  if (new Set(manifest.operations.map(op => op.name)).size !== manifest.operations.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate operations' });
  for (const event of [...manifest.eventsPublished, ...manifest.eventsConsumed])
    if (!event.startsWith(`${manifest.id}.`)) ctx.addIssue({ code: 'custom', message: 'Events must use the project namespace' });
});
export type Manifest = z.infer<typeof manifestSchema>;
export const metadataSchema = z.object({
  projectDirectory: z.string().max(500).optional(), sourceDirectory: z.string().max(500).optional(),
  configurationLocations: z.array(z.string().max(500)).max(20).default([]),
  containerId: z.string().max(100).optional(), composeProject: z.string().max(100).optional(),
  systemdUnit: z.string().max(100).optional(), repositoryUrl: safeUrl.optional(),
}).strict();
export const scopes = ['project:read', 'health:write', 'events:write', 'events:read', 'operations:invoke'] as const;
export type Scope = typeof scopes[number];
export const healthSchema = z.object({ status: z.enum(['healthy', 'degraded', 'unhealthy', 'unknown']) }).strict();
// Deliberately scalar and allowlisted. Events are status metadata, never chat payloads or credentials.
export const eventSchema = z.object({
  type: name,
  payload: z.object({ status: z.string().max(80).optional(), code: name.optional(), value: z.number().finite().optional() }).strict(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
}).strict();
