import { pgPool } from '../db/client';
import { recordAuditLog } from '../db/audit';
import { readUpdateState, sanitizeText } from './runtime';

/**
 * The updater (scripts/updater/updater.mjs) runs outside the server, so its result is put into the
 * shop's audit trail when the server starts next: APP_UPDATE_INSTALLED / APP_UPDATE_ROLLED_BACK /
 * APP_UPDATE_FAILED / APP_UPDATE_REFUSED, once per install attempt (remembered in sync_state).
 */
export async function auditLastUpdateOnce(): Promise<void> {
  try {
    const li = readUpdateState()?.last_install;
    if (!li?.at || !li?.result) return;
    const marker = `${li.at}|${li.result}`;
    const seen = (await pgPool.query(`SELECT value FROM sync_state WHERE key = 'audited_update'`)).rows[0]?.value;
    if (seen === marker) return;
    const action = li.result === 'SUCCESS' ? 'APP_UPDATE_INSTALLED' : li.result === 'ROLLED_BACK' || li.result === 'MANUAL_ROLLBACK' ? 'APP_UPDATE_ROLLED_BACK'
      : li.result === 'REFUSED' ? 'APP_UPDATE_REFUSED' : 'APP_UPDATE_FAILED';
    await recordAuditLog({
      action, entity: 'app_update', entity_id: String(li.to || '').slice(0, 40), user_name: 'System (updater)',
      new_value: { from: li.from || null, to: li.to || null, result: li.result, started_at: li.at, finished_at: (li as any).finished_at || null, detail: sanitizeText(li.detail) },
    } as any);
    await pgPool.query(
      `INSERT INTO sync_state (key, value, updated_at) VALUES ('audited_update', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`, [marker]);
  } catch (err: any) {
    console.warn('[Updater] could not audit the last update result:', err?.message || err);
  }
}
