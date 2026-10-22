// Thin client for the local read-only API.
import type { ApiErrorBody } from '../../shared/types';

export class ApiError extends Error {
  kind?: string;
  hint?: string | null;
  detail?: string | null;
  status: number;

  constructor(status: number, body: ApiErrorBody | string) {
    super(typeof body === 'string' ? body || `HTTP ${status}` : body.error);
    this.status = status;
    if (typeof body === 'object') {
      this.kind = body.kind;
      this.hint = body.hint;
      this.detail = body.detail;
    }
  }
}

export async function api<T>(path: string, params: Record<string, string | null | undefined> = {}): Promise<T> {
  const u = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { Accept: 'application/json' } });
  const type = res.headers.get('content-type') || '';
  const body: unknown = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, body as ApiErrorBody | string);
  return body as T;
}
