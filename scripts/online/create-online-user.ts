import fs from 'fs';
import crypto from 'crypto';
import pg from 'pg';
import { hashCredential } from '../../server/auth';

/**
 * Creates (or resets) an ONLINE account in giga_cloud.online_users — the accounts used to log in to
 * https://gigachem.vercel.app. Separate from the shop's staff accounts (whose password/PIN hashes
 * never leave the shop). Roles: ADMIN | CASHIER.
 *
 *   npm run online:create-user -- --email owner@example.com --name "Owner" --role ADMIN [--env .env.online]
 *   options: --shop <uuid> (restrict to one shop; default SHOP_ID from the env file)
 *            --local-user <uuid> (Cashier: link to the shop staff account for "own sales")
 *            --print-sql (do not connect; print SQL to paste into the Supabase SQL editor)
 *
 * The password is read from ONLINE_USER_PASSWORD if set, otherwise a strong one is generated and
 * printed ONCE. Only its scrypt hash is stored.
 */
const args = process.argv.slice(2);
const opt = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
function fail(msg: string): never {
  console.error(`[create-online-user] ${msg}`);
  process.exit(1);
}

const envFile = opt('--env') || '.env.online';
const env: Record<string, string> = {};
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
}
const email = (opt('--email') || '').trim().toLowerCase();
const name = (opt('--name') || '').trim();
const role = (opt('--role') || '').toUpperCase();
const shopId = opt('--shop') || env.SHOP_ID || null;
const localUser = opt('--local-user') || null;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('--email is required (valid address).');
if (!name) fail('--name is required.');
if (!['ADMIN', 'CASHIER'].includes(role)) fail('--role must be ADMIN or CASHIER.');
if (shopId && !uuid.test(shopId)) fail('--shop / SHOP_ID must be a UUID.');
if (localUser && !uuid.test(localUser)) fail('--local-user must be a UUID.');

const generated = !process.env.ONLINE_USER_PASSWORD;
const password = process.env.ONLINE_USER_PASSWORD || `Gc-${crypto.randomBytes(15).toString('base64url')}`;
if (password.length < 10) fail('ONLINE_USER_PASSWORD must be at least 10 characters.');
const hash = hashCredential(password).combined;
const lit = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);
const sql = `SELECT giga_cloud.upsert_online_user(${lit(email)}, ${lit(name)}, ${lit(role)}, ${lit(hash)}, ${shopId ? `${lit(shopId)}::uuid` : 'NULL'}, ${localUser ? `${lit(localUser)}::uuid` : 'NULL'});`;

async function main() {
  if (args.includes('--print-sql')) {
    console.log('-- Run in the Supabase SQL editor:');
    console.log(sql);
  } else {
    const url = env.ONLINE_DATABASE_URL || env.DATABASE_URL || process.env.ONLINE_DATABASE_URL || '';
    if (!url || /REQUIRED_USER_INPUT/.test(url)) fail(`No cloud DATABASE_URL in ${envFile}. Use --print-sql instead.`);
    const host = new URL(url).hostname;
    const c = new pg.Client({ connectionString: url, ssl: ['localhost', '127.0.0.1'].includes(host) ? undefined : { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
    try {
      await c.connect();
    } catch (err: any) {
      fail(`Cannot connect to the cloud database (${err?.code || err?.message}). Use --print-sql and run it in the Supabase SQL editor.`);
    }
    const id = (await c.query(sql)).rows[0].upsert_online_user;
    await c.end();
    console.log(`Online ${role} account ${email} saved (id ${id}).`);
  }
  if (generated) console.log(`Generated password (shown once, store it safely): ${password}`);
}

main().catch((err) => fail(err?.message || String(err)));
