import { readSecret } from '../security/secrets.js';
const docker = process.argv[2] === 'docker';
try {
  const token = readSecret(process.env, docker ? 'OCC_DOCKER_MONITOR_TOKEN' : 'OCC_HOST_MONITOR_TOKEN');
  const response = await fetch(docker ? 'http://127.0.0.1:2375/containers' : 'http://127.0.0.1:2376/metrics', {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) process.exit(1);
  const data = await response.json();
  process.exit(docker ? Array.isArray(data) ? 0 : 1 : Date.now() - Date.parse(data.sampledAt) < 30_000 ? 0 : 1);
} catch { process.exit(1); }
