import 'dotenv/config';
import pg from 'pg';
import { getDatabaseConnectionConfig } from '../../server/db/client';

/**
 * DRY RUN — publishing this shop's existing staff to the cloud login mirror (unified login).
 *
 *   npm run auth:credential-dryrun                 local analysis + cloud preview (gc_credential_sync_preview)
 *   npm run auth:credential-dryrun -- --local-only local analysis only (no network)
 *
 * READ ONLY on both sides. Never reads, prints or sends a password hash or PIN: the preview RPC
 * receives ids, emails, usernames, roles and active flags only, and refuses any credential field.
 */
const localOnly = process.argv.includes('--local-only');

async function main() {
  const pool = new pg.Pool(getDatabaseConnectionConfig());
  try {
    const db = (await pool.query('SELECT current_database() AS db')).rows[0].db;
    const hasVersions = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('credential_version', 'auth_sync_seq')`)).rows[0].n === 2;
    const users = (await pool.query(
      `SELECT id, name, lower(email) AS email, lower(username) AS username, role, active,
              (password_hash ~ '^[0-9a-f]{32}[$][0-9a-f]{128}$') AS hash_format_ok
         FROM users ORDER BY role, name`)).rows;
    const shop = (await pool.query(`SELECT to_regclass('shop_identity') IS NOT NULL AS ok`)).rows[0].ok
      ? (await pool.query('SELECT shop_id, shop_code FROM shop_identity WHERE id = 1')).rows[0] : null;

    const dupEmail = new Set(users.map((u) => u.email).filter((e, i, a) => a.indexOf(e) !== i));
    const dupUser = new Set(users.map((u) => u.username).filter((e, i, a) => e && a.indexOf(e) !== i));
    console.log(`\nCREDENTIAL SYNC DRY RUN — database ${db}${shop ? `, shop ${shop.shop_code} ${shop.shop_id}` : ' (no shop identity: local migration 013 not applied)'}`);
    console.log(`Local migration 016 (credential versions): ${hasVersions ? 'applied' : 'NOT applied yet'}`);
    console.log(`Local staff accounts: ${users.length} (active ${users.filter((u) => u.active).length}, inactive ${users.filter((u) => !u.active).length})`);
    console.log(`Roles: ${Object.entries(users.reduce((m: any, u) => ((m[u.role] = (m[u.role] || 0) + 1), m), {})).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    const lockedUsers = users.filter((u) => !u.hash_format_ok);
    console.log(`Password hash format publishable (PBKDF2 salt$hash): ${users.length - lockedUsers.length}/${users.length}`);
    if (lockedUsers.length) {
      console.log(`LOCKED accounts (no usable password; cannot log in at the shop or online; NOT published until a password is set at the shop): ` +
        `${lockedUsers.length} — ${lockedUsers.map((u) => `${u.name} (${u.role}, ${u.active ? 'active' : 'inactive'})`).join(', ')}`);
    }
    console.log(`Local email duplicates: ${dupEmail.size}   local username duplicates: ${dupUser.size}`);

    let preview: Map<string, any> | null = null;
    let enabled: boolean | null = null;
    if (!localOnly) {
      const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
      const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
      const token = process.env.SYNC_SHOP_TOKEN || '';
      if (!url || !key || !token || !shop) {
        console.log('Cloud preview skipped: SUPABASE_URL / API key / SYNC_SHOP_TOKEN / shop identity not configured.');
      } else {
        const res = await fetch(`${url}/rest/v1/rpc/gc_credential_sync_preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            p_shop_id: shop.shop_id, p_token: token,
            p_users: users.map((u) => ({ local_user_id: u.id, email: u.email, username: u.username, role: u.role, active: u.active })),
          }),
        }).catch((e) => ({ ok: false, status: 0, text: async () => String(e?.message || e) }) as any);
        if (res.status === 404) console.log('Cloud preview: the cloud does not have migration 005 yet (gc_credential_sync_preview missing).');
        else if (!res.ok) console.log(`Cloud preview failed: HTTP ${res.status}`);
        else {
          const body = await res.json();
          enabled = body.credential_sync_enabled;
          preview = new Map((body.results || []).map((r: any) => [String(r.local_user_id), r]));
        }
      }
    }

    console.log('\n  ROLE     ACTIVE  LOGIN    CLOUD           EMAIL-COLLISION        USERNAME-COLLISION  NAME');
    for (const u of users) {
      const p = preview?.get(String(u.id));
      const emailIssue = dupEmail.has(u.email) ? 'local duplicate' : p?.status === 'EMAIL_CONFLICT'
        ? `cloud (${p.email_conflict_with?.account_type || '?'}${p.email_conflict_with?.same_shop ? ', same shop' : ', other shop/global'})` : '-';
      const userIssue = !u.username ? '(no username)' : dupUser.has(u.username) ? 'local duplicate'
        : p?.username_conflict ? 'cloud, same shop' : p?.username_used_in_other_shops ? 'other shop (use email online)' : '-';
      console.log(`  ${u.role.padEnd(8)} ${String(u.active).padEnd(7)} ${(u.hash_format_ok ? 'password' : 'LOCKED').padEnd(8)} ${String(p?.status || (localOnly ? 'n/a (local only)' : 'unknown')).padEnd(15)} ${emailIssue.padEnd(22)} ${userIssue.padEnd(19)} ${u.name}`);
    }
    if (preview) {
      const all = [...preview.values()];
      const count = (s: string) => all.filter((x) => x.status === s).length;
      console.log(`\nCloud: matched ${count('MATCHED')}, to create ${count('TO_CREATE')}, email collisions ${count('EMAIL_CONFLICT')}; ` +
        `credential sync for this shop is ${enabled ? 'ENABLED' : 'DISABLED (nothing is published until the operator enables it)'}.`);
    }
    console.log('\nNo secret value was read, printed or sent.');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('Dry run failed:', e?.message || e);
  process.exitCode = 1;
});
