import { getSyncConfig } from './config';

/**
 * Minimal server-side client for the cloud RPC functions (Supabase PostgREST: POST /rest/v1/rpc/<fn>).
 * Keys and tokens go only into request headers/body; they are never logged or returned.
 */
export class CloudError extends Error {
  /** true = network/timeout/5xx/429: retry later. false = the cloud answered with a definite refusal. */
  transient: boolean;
  status: number;
  constructor(message: string, transient: boolean, status = 0) {
    super(message);
    this.name = 'CloudError';
    this.transient = transient;
    this.status = status;
  }
}

type RpcName = 'gc_ping' | 'gc_ingest_events' | 'gc_pull_commands' | 'gc_ack_command' | 'gc_heartbeat';

export async function callCloud<T = any>(fn: RpcName, args: Record<string, unknown>): Promise<T> {
  const cfg = getSyncConfig();
  if (!cfg.cloudConfigured) throw new CloudError(cfg.configError || 'Cloud is not configured.', false);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.httpTimeoutMs);
  let res: Response;
  try {
    res = await fetch(`${cfg.cloudUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        apikey: cfg.apiKey,
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
  } catch (err: any) {
    const reason = err?.name === 'AbortError'
      ? `timed out after ${cfg.httpTimeoutMs} ms`
      : describeNetworkError(err);
    throw new CloudError(`Cloud unreachable (${fn}): ${reason}`, true);
  } finally {
    clearTimeout(timer);
  }

  let body: any = null;
  try {
    const text = await res.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = typeof body?.message === 'string' ? body.message.slice(0, 500) : `HTTP ${res.status}`;
    const transient = res.status >= 500 || res.status === 408 || res.status === 429;
    throw new CloudError(`Cloud rejected ${fn} (HTTP ${res.status}): ${msg}`, transient, res.status);
  }
  return body as T;
}

function describeNetworkError(err: any): string {
  const code = err?.cause?.code || err?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS lookup failed (no internet?)';
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ECONNRESET') return 'connection reset';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'connection timed out';
  if (typeof code === 'string' && /CERT|SSL|TLS/i.test(code)) return `TLS error (${code})`;
  return (err?.cause?.message || err?.message || 'network error').slice(0, 200);
}
