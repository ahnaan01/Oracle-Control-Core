import { manifestSchema, healthSchema, eventSchema, type Manifest } from './schema.js';
export * from './schema.js';

export class IntegrationError extends Error {
  constructor(readonly code: string, message: string, readonly requestId?: string, readonly status?: number) { super(message); }
}
/** Small fetch-based client. The caller owns secure token storage. No automatic non-idempotent retries. */
export class OccClient {
  constructor(private baseUrl: string, private token: string, private http: typeof fetch = fetch) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', 'core'].includes(url.hostname))
      throw new Error('Use HTTPS outside a loopback or isolated Compose connection');
    if (url.username || url.password || url.search || url.hash) throw new Error('Use a clean OCC API base URL');
  }
  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await this.http(`${this.baseUrl.replace(/\/$/, '')}/integrations${path}`, {
      method, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    const envelope = await response.json() as { data?: T; error?: { code: string; message: string }; requestId?: string };
    if (!response.ok) throw new IntegrationError(envelope.error?.code ?? 'HTTP_ERROR', envelope.error?.message ?? 'Request failed', envelope.requestId, response.status);
    return envelope.data as T;
  }
  register(manifest: Manifest) { return this.request<{ registered: boolean; projectId: string }>('/register', 'POST', manifestSchema.parse(manifest)); }
  me() { return this.request<{ id: string; health: string }>('/me'); }
  reportHealth(status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown') {
    return this.request<{ id: string; status: string }>('/health', 'POST', healthSchema.parse({ status }));
  }
  publish(type: string, payload: { status?: string; code?: string; value?: number }, idempotencyKey: string) {
    return this.request<{ id: string; duplicate: boolean }>('/events', 'POST', eventSchema.parse({ type, payload, idempotencyKey }));
  }
  events() { return this.request<{ id: string; type: string; payload: unknown; created_at: string }[]>('/events'); }
  operations() { return this.request<{ name: string; approved: boolean }[]>('/operations'); }
  invoke(operation: string) { return this.request<unknown>(`/operations/${encodeURIComponent(operation)}/invoke`, 'POST', {}); }
}
