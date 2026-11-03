import 'dotenv/config';
import { preflight, type Role } from './preflight.js';
process.umask(0o077);
const roleIndex = process.argv.indexOf('--role'); const role = roleIndex < 0 ? 'core' : process.argv[roleIndex + 1];
if (!['core', 'telegram', 'whatsapp', 'docker-monitor'].includes(role ?? '')) { console.error('Invalid preflight role'); process.exit(1); }
try {
  const result = await preflight(process.env, { role: role as Role, skipPort: process.argv.includes('--skip-port'), probeCollectors: process.argv.includes('--probe-collectors') });
  console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ok ? 0 : 1;
} catch { console.error('Preflight failed safely; check private configuration and file bindings. No secret values are shown.'); process.exitCode = 1; }
