import 'dotenv/config';
import { pgPool } from '../../server/db/client';

/**
 * Helper for scripts/updater/updater.mjs (reads/updates the local update_approvals table).
 *   get <commit>                       -> {"approved":true,"id":"..."} | {"approved":false}
 *   consume <commit> <outcome> [detail]  marks open approvals of that commit as used
 * An approval is written only by the APP_UPDATE_APPROVE cloud command (an online ADMIN).
 */
async function main() {
  const [action, commit, outcome, detail] = process.argv.slice(2);
  if (!/^[0-9a-f]{40}$/.test(commit || '')) throw new Error('commit must be a 40-character sha');
  if (action === 'get') {
    const row = (await pgPool.query(
      `SELECT id FROM update_approvals WHERE target_commit = $1 AND consumed_at IS NULL AND approved_at > now() - interval '7 days'
        ORDER BY approved_at DESC LIMIT 1`, [commit])).rows[0];
    console.log(JSON.stringify(row ? { approved: true, id: row.id } : { approved: false }));
  } else if (action === 'consume') {
    await pgPool.query(
      `UPDATE update_approvals SET consumed_at = now(), outcome = $2, outcome_detail = $3 WHERE target_commit = $1 AND consumed_at IS NULL`,
      [commit, String(outcome || 'DONE').slice(0, 20), detail ? String(detail).slice(0, 1000) : null]);
    console.log(JSON.stringify({ ok: true }));
  } else {
    throw new Error('usage: approval.ts get|consume <commit> [outcome] [detail]');
  }
}

main()
  .catch((err) => {
    console.log(JSON.stringify({ approved: false, error: String(err?.message || err).slice(0, 200) }));
    process.exitCode = 1;
  })
  .finally(() => pgPool.end());
