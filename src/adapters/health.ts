import { readFile } from 'node:fs/promises';
const platform = process.argv[2];
if (!['telegram', 'whatsapp'].includes(platform ?? '')) process.exit(1);
try {
  const state = JSON.parse(await readFile(`/tmp/occ-${platform}-health.json`, 'utf8'));
  process.exit(state.status === 'connected' && Date.now() - state.reportedAt < 45_000 ? 0 : 1);
} catch { process.exit(1); }
