import http from 'node:http';
import { parseContainers } from '../docker.js';

// The only host-socket operation is this literal GET. No caller-controlled paths, IDs, or methods.
export function readDockerInventory(socketPath = '/var/run/docker.sock'): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = http.get({ socketPath, path: '/containers/json?all=true', timeout: 3000 }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('Docker inventory unavailable')); return; }
      const parts: Buffer[] = []; let size = 0;
      response.on('data', (part: Buffer) => {
        size += part.length;
        if (size > 2_000_000) { response.destroy(); reject(new Error('Inventory too large')); } else parts.push(part);
      });
      response.on('end', () => {
        try {
          // Select labels and fields here too. Sensitive daemon response fields never reach core.
          const clean = parseContainers(JSON.parse(Buffer.concat(parts).toString()));
          resolve(clean.map(c => ({ Id: c.id, Names: [c.name], Image: c.image, State: c.state, Status: c.status,
            Labels: { ...(c.composeProject ? { 'com.docker.compose.project': c.composeProject } : {}),
              ...(c.composeService ? { 'com.docker.compose.service': c.composeService } : {}) } })));
        } catch { reject(new Error('Invalid Docker inventory')); }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Docker timeout')));
    request.on('error', reject);
  });
}
export function createMonitorServer() {
  return http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method !== 'GET' || request.url !== '/containers') {
      response.writeHead(404); response.end('{"error":"NOT_FOUND"}'); return;
    }
    try { response.end(JSON.stringify(await readDockerInventory())); }
    catch { response.writeHead(503); response.end('{"error":"DOCKER_UNAVAILABLE"}'); }
  });
}
