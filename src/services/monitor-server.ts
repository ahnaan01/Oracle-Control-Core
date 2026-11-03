import http from 'node:http';
import { equal } from '../security/crypto.js';

/** Internal network AND bearer authentication. No caller-controlled upstream route. */
export function monitorServer(token: string, route: string, collect: () => Promise<unknown>) {
  if (token.length < 32) throw new Error('A collector credential of at least 32 characters is required');
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json'); response.setHeader('cache-control', 'no-store');
    if (request.method !== 'GET' || request.url !== route) { response.writeHead(404); response.end('{"error":"NOT_FOUND"}'); return; }
    if (!equal(request.headers.authorization ?? '', `Bearer ${token}`)) { response.writeHead(401); response.end('{"error":"UNAUTHENTICATED"}'); return; }
    try { response.end(JSON.stringify(await collect())); }
    catch { response.writeHead(503); response.end('{"error":"COLLECTOR_UNAVAILABLE"}'); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxConnections = 8;
  return server;
}
