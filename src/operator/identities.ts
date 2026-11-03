import { z } from 'zod';
export const mappingSchema = z.object({
  identities: z.array(z.object({ platform: z.enum(['telegram', 'whatsapp']), senderId: z.string().min(1).max(100), userId: z.string().min(1).max(100) }).strict()).max(100),
  groups: z.array(z.object({ platform: z.enum(['telegram', 'whatsapp']), chatId: z.string().min(1).max(100) }).strict()).max(100),
}).strict();
export function validateMappings(raw: unknown, users?: Set<string>) {
  const data = mappingSchema.parse(raw);
  const identities = new Set<string>(); const groups = new Set<string>();
  for (const row of data.identities) {
    const key = `${row.platform}:${row.senderId}`;
    const valid = row.platform === 'telegram' ? /^\d+$/.test(row.senderId) : /^\d+@(s\.whatsapp\.net|lid)$/.test(row.senderId);
    if (!valid || identities.has(key) || (users && !users.has(row.userId))) throw new Error('Invalid, duplicate or unknown identity mapping');
    identities.add(key);
  }
  for (const row of data.groups) {
    const key = `${row.platform}:${row.chatId}`;
    if (groups.has(key) || !(row.platform === 'telegram' ? /^-\d+$/.test(row.chatId) : /^\d+(?:-\d+)?@g\.us$/.test(row.chatId))) throw new Error('Invalid or duplicate group mapping');
    groups.add(key);
  }
  return data;
}
