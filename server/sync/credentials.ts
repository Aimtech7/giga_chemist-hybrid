import { pgPool } from '../db/client';
import { callCloud, CloudError } from './cloudClient';
import { getSyncConfig } from './config';
import { getShopIdentity } from './identity';

/**
 * Unified login: the shop publishes its staff PASSWORD HASHES (never PINs, never plaintext) to the
 * cloud login mirror (giga_cloud.online_users) through the dedicated, shop-token-authenticated RPC
 * gc_sync_user_credentials — never through business events, commands or audit rows.
 *
 * Which hash wins is decided by (credential_version, credential_updated_at), identically on both
 * sides: an older credential never replaces a newer one. Timestamps travel as PostgreSQL text so no
 * precision is lost between the two databases.
 *
 * Disabled per shop in the cloud (giga_cloud.shops.credential_sync_enabled) until the operator
 * enables it: the RPC then stores nothing and accounts simply stay queued here.
 */
export interface FetchedCredential {
  local_user_id: string;
  email: string;
  username: string | null;
  name: string;
  role: string;
  active: boolean;
  password_hash: string;
  credential_version: number;
  credential_updated_at: string;
}

const BATCH = 50;
/** The application's PBKDF2 credential format (server/auth.ts hashCredential): 32-hex salt $ 128-hex hash. */
const PUBLISHABLE_HASH = /^[0-9a-f]{32}\$[0-9a-f]{128}$/;
const DISABLED_RECHECK_MS = 10 * 60_000;
let disabledUntil = 0;
let notice: string | null = null;

export type CredentialPushOutcome = 'ok' | 'disabled' | 'unreachable' | 'unsupported';

/** Publishes accounts whose password / status / role / identity changed. Never throws for cloud trouble. */
export async function pushUserCredentials(): Promise<CredentialPushOutcome> {
  if (Date.now() < disabledUntil) return 'disabled';
  const cfg = getSyncConfig();
  const identity = await getShopIdentity();
  for (let round = 0; round < 20; round++) {
    let rows: any[];
    try {
      rows = (await pgPool.query(
        `SELECT id, name, email, username, role, active, password_hash, credential_version,
                credential_updated_at::text AS credential_updated_at, auth_sync_seq
           FROM users WHERE auth_sync_seq > auth_synced_seq ORDER BY auth_sync_seq LIMIT $1`, [BATCH])).rows;
    } catch (err: any) {
      if (err?.code !== '42703') throw err;
      // Local migration 016 not applied yet (code updated first): nothing to publish until it is.
      disabledUntil = Date.now() + DISABLED_RECHECK_MS;
      logOnce('Credential sync waits for local database migration 016 (npm run db:migrate).');
      return 'unsupported';
    }
    if (!rows.length) return 'ok';
    // Accounts without a usable password (e.g. legacy staff imported as LOCKED_MIGRATED_...) cannot
    // log in anywhere: nothing to publish. They are published once a real password is set at the shop.
    const locked = rows.filter((r) => !PUBLISHABLE_HASH.test(String(r.password_hash || '')));
    for (const r of locked) await pgPool.query('UPDATE users SET auth_synced_seq = $2 WHERE id = $1 AND auth_synced_seq < $2', [r.id, r.auth_sync_seq]);
    rows = rows.filter((r) => PUBLISHABLE_HASH.test(String(r.password_hash || '')));
    if (!rows.length) continue;
    let response: any;
    try {
      response = await callCloud('gc_sync_user_credentials', {
        p_shop_id: identity.shop_id,
        p_token: cfg.shopToken,
        p_users: rows.map((r) => ({
          local_user_id: r.id, email: r.email, username: r.username, name: r.name, role: r.role, active: r.active,
          password_hash: r.password_hash, credential_version: Number(r.credential_version), credential_updated_at: r.credential_updated_at,
        })),
      });
    } catch (err: any) {
      if (err instanceof CloudError && err.status === 404) {
        // Cloud migration 005 not applied yet: try again much later, say so once.
        disabledUntil = Date.now() + DISABLED_RECHECK_MS;
        logOnce('Credential sync not available in the cloud yet (cloud migration 005).');
        return 'unsupported';
      }
      return 'unreachable';
    }
    if (response?.enabled === false) {
      disabledUntil = Date.now() + DISABLED_RECHECK_MS;
      logOnce('Credential sync is not enabled for this shop in the cloud; staff accounts wait here.');
      return 'disabled';
    }
    notice = null;
    const byId = new Map<string, any>((response?.results || []).map((x: any) => [String(x.local_user_id), x]));
    const conflicts: string[] = [];
    for (const r of rows) {
      const res = byId.get(String(r.id));
      if (!res || res.status === 'REJECTED') {
        conflicts.push(`${r.email}: ${res?.error || 'no result'}`);
        continue; // stays queued; retried next cycle
      }
      if (/CONFLICT/.test(res.status)) conflicts.push(`${r.email}: ${res.status}`);
      await pgPool.query('UPDATE users SET auth_synced_seq = $2 WHERE id = $1 AND auth_synced_seq < $2', [r.id, r.auth_sync_seq]);
    }
    await pgPool.query(
      `INSERT INTO sync_state (key, value, updated_at) VALUES ('credential_sync', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
      [JSON.stringify({ at: new Date().toISOString(), published: rows.length - conflicts.length, conflicts: conflicts.slice(0, 20) })]
    );
    if (conflicts.length) console.warn(`[Sync] Credential sync: ${conflicts.length} account(s) need attention (e.g. ${conflicts[0].replace(/\s+/g, ' ').slice(0, 120)})`);
    if (rows.length < BATCH) return 'ok';
  }
  return 'ok';
}

/** Re-checks the cloud on the next cycle (e.g. after the operator enabled credential sync). */
export function resetCredentialSyncBackoff(): void {
  disabledUntil = 0;
}

/**
 * The hash for ONE account named by an open USER_CREATE / USER_CREDENTIAL_REFRESH command. Kept in
 * memory only for the duration of that command; never written to command or audit rows.
 * Returns { error } for a definite cloud refusal; throws for transient trouble (retry later).
 */
export async function fetchCommandCredential(localUserId: string): Promise<{ credential?: FetchedCredential; error?: string }> {
  const cfg = getSyncConfig();
  const identity = await getShopIdentity();
  try {
    const c = await callCloud<FetchedCredential>('gc_fetch_user_credential', { p_shop_id: identity.shop_id, p_token: cfg.shopToken, p_local_user_id: localUserId });
    if (!c || typeof c.password_hash !== 'string' || String(c.local_user_id).toLowerCase() !== localUserId.toLowerCase()) {
      return { error: 'The cloud returned no usable credential for this account.' };
    }
    return { credential: c };
  } catch (err: any) {
    if (err instanceof CloudError && !err.transient) return { error: 'The cloud has no open credential for this account (command superseded or account removed).' };
    throw err;
  }
}

function logOnce(msg: string) {
  if (notice === msg) return;
  notice = msg;
  console.log(`[Sync] ${msg}`);
}
