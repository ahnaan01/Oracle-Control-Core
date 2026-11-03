import { readFile } from 'node:fs/promises';
import { prepareSetup } from './setup.js';
process.umask(0o077);
try {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: npm run setup -- <operator answers JSON>; see config/setup.example.json');
  const result = await prepareSetup(JSON.parse(await readFile(file, 'utf8')), process.cwd());
  console.log(`Private operator configuration created. Administrator: ${result.username}; OCC ID: ${result.adminId}`);
  console.log('Next: bootstrap the account with npm run admin (local) OR docker compose run --rm core node dist/src/admin.js (Docker). Then run preflight. No existing database was modified.');
} catch { console.error('Setup failed: invalid answers, enabled transport without a real sender mapping, root operator, or existing/unwritable configuration. No existing files are overwritten. See docs/FIRST_DEPLOYMENT.md.'); process.exitCode = 1; }
