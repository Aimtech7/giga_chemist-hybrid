import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

/**
 * Validates the ONLINE / Vercel environment file without printing any value.
 *
 *   npm run env:check:online                 (checks .env.online, scans dist/ if present)
 *   npm run env:check:online -- path/to/file
 *
 * Exit code 1 when any check fails. REQUIRED_USER_INPUT counts as missing.
 */
const file = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || '.env.online');
const PLACEHOLDER = /^(REQUIRED_USER_INPUT|YOUR_[A-Z0-9_]*|.*YOUR[-_]PROJECT.*|.*YOUR-VERCEL-DOMAIN.*|.*YOUR-API-HOST.*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVER_ONLY = ['SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET', 'DATABASE_URL', 'SYNC_SHOP_TOKEN', 'DB_PASSWORD', 'SMTP_PASSWORD'];
const SECRET_NAME = /SERVICE_ROLE|JWT|SECRET|PASSWORD|DATABASE_URL|PRIVATE|SHOP_TOKEN|SMTP/i;

let failed = 0;
let warned = 0;
const pass = (m: string) => console.log(`  PASS  ${m}`);
const fail = (m: string) => {
  failed++;
  console.log(`  FAIL  ${m}`);
};
const warn = (m: string) => {
  warned++;
  console.log(`  WARN  ${m}`);
};

if (!fs.existsSync(file)) {
  console.error(`Environment file not found: ${file}`);
  process.exit(1);
}
const env = dotenv.parse(fs.readFileSync(file));
const has = (k: string) => typeof env[k] === 'string' && env[k].trim() !== '' && !PLACEHOLDER.test(env[k].trim());
const isLocalHost = (h: string) => ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(h.toLowerCase());

function httpsUrl(k: string, label = k) {
  if (!has(k)) return fail(`${label} is set`);
  try {
    const u = new URL(env[k]);
    if (u.protocol !== 'https:') return fail(`${label} uses https://`);
    if (isLocalHost(u.hostname)) return fail(`${label} is not a localhost address`);
    pass(`${label} is a valid https URL`);
  } catch {
    fail(`${label} is a valid URL`);
  }
}

console.log(`Validating ${path.relative(process.cwd(), file)} (values are never printed)\n`);

console.log('[mode]');
env.APP_MODE === 'hybrid' ? pass('APP_MODE=hybrid') : fail('APP_MODE must be hybrid');
['true', 'false'].includes(env.SYNC_ENABLED) ? pass('SYNC_ENABLED is true/false') : fail('SYNC_ENABLED must be true or false');
env.NODE_ENV === 'production' ? pass('NODE_ENV=production') : fail('NODE_ENV must be production');

console.log('\n[public frontend]');
httpsUrl('VITE_API_URL');
httpsUrl('VITE_SUPABASE_URL');
has('VITE_SUPABASE_ANON_KEY') ? pass('VITE_SUPABASE_ANON_KEY is set') : fail('VITE_SUPABASE_ANON_KEY is set');
for (const k of Object.keys(env).filter((x) => x.startsWith('VITE_'))) {
  if (SECRET_NAME.test(k)) fail(`${k}: secret-looking name must not be a VITE_ (public) variable`);
}
const serverValues = SERVER_ONLY.filter(has).map((k) => env[k]);
const leakedIntoVite = Object.keys(env).filter((k) => k.startsWith('VITE_') && has(k) && serverValues.includes(env[k]));
leakedIntoVite.length ? fail(`server-only value reused in ${leakedIntoVite.join(', ')}`) : pass('no server-only value appears in a VITE_ variable');
if (Object.keys(env).some((k) => /^VITE_.*SERVICE_ROLE/i.test(k))) fail('service-role key must never be prefixed VITE_');
else pass('service-role key is not prefixed VITE_');

console.log('\n[supabase server]');
httpsUrl('SUPABASE_URL');
has('SUPABASE_ANON_KEY') ? pass('SUPABASE_ANON_KEY is set') : fail('SUPABASE_ANON_KEY is set');
if (has('SUPABASE_URL') && has('VITE_SUPABASE_URL') && env.SUPABASE_URL !== env.VITE_SUPABASE_URL) warn('SUPABASE_URL and VITE_SUPABASE_URL differ');
if (has('SUPABASE_SERVICE_ROLE_KEY')) {
  has('SUPABASE_ANON_KEY') && env.SUPABASE_ANON_KEY === env.SUPABASE_SERVICE_ROLE_KEY
    ? fail('SUPABASE_ANON_KEY must not be the service-role key')
    : pass('service-role key set (server only)');
} else warn('SUPABASE_SERVICE_ROLE_KEY not set (optional: sync uses the anon key + shop token)');

console.log('\n[authentication]');
if (!has('JWT_SECRET')) fail('JWT_SECRET is set');
else {
  const s = env.JWT_SECRET;
  s.length >= 64 ? pass(`JWT_SECRET length >= 64 (${s.length})`) : fail(`JWT_SECRET must be >= 64 characters (${s.length})`);
  const distinct = new Set(s).size;
  distinct >= 20 ? pass(`JWT_SECRET character variety OK (${distinct} distinct)`) : fail('JWT_SECRET looks low-entropy');
  const local = fs.existsSync('.env') ? dotenv.parse(fs.readFileSync('.env')).JWT_SECRET : undefined;
  if (local && local === s) warn('JWT_SECRET is the same as the local shop .env secret');
}

console.log('\n[database]');
if (!has('DATABASE_URL')) fail('DATABASE_URL is set');
else {
  try {
    const u = new URL(env.DATABASE_URL);
    /^postgres(ql)?:$/.test(u.protocol) ? pass('DATABASE_URL is a postgres URL') : fail('DATABASE_URL must be postgres://');
    isLocalHost(u.hostname) ? fail('DATABASE_URL must not point to localhost/127.0.0.1') : pass('DATABASE_URL is not localhost');
    /giga_chemist_dev/i.test(u.pathname) ? fail('DATABASE_URL must not be the dev database') : pass('DATABASE_URL is not giga_chemist_dev');
    /sslmode=(require|verify)/.test(u.search) || /supabase\.(co|com)/.test(u.hostname) ? pass('DATABASE_URL uses TLS') : warn('DATABASE_URL has no sslmode=require');
  } catch {
    fail('DATABASE_URL is a valid URL');
  }
}

console.log('\n[shop identity]');
has('SHOP_ID') && UUID.test(env.SHOP_ID) ? pass('SHOP_ID is a UUID') : fail('SHOP_ID must be a UUID');
has('BRANCH_ID') && UUID.test(env.BRANCH_ID) ? pass('BRANCH_ID is a UUID') : fail('BRANCH_ID must be a UUID');

console.log('\n[sync]');
for (const k of ['SYNC_BATCH_SIZE', 'SYNC_INTERVAL_SECONDS', 'SYNC_INTERVAL_MS', 'SYNC_MAX_ATTEMPTS']) {
  if (env[k] === undefined) continue;
  Number.isInteger(Number(env[k])) && Number(env[k]) > 0 ? pass(`${k} is a positive integer`) : fail(`${k} must be a positive integer`);
}

console.log('\n[public URL / CORS]');
httpsUrl('APP_URL');
httpsUrl('PUBLIC_APP_URL');
if (!has('ALLOWED_ORIGINS')) fail('ALLOWED_ORIGINS is set');
else {
  const origins = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  const bad = origins.filter((o) => {
    if (o === '*') return true;
    try {
      const u = new URL(o);
      return u.protocol !== 'https:' || u.pathname !== '/' || isLocalHost(u.hostname);
    } catch {
      return true;
    }
  });
  bad.length ? fail(`ALLOWED_ORIGINS must be https origins without "*" (${bad.length} invalid)`) : pass(`ALLOWED_ORIGINS has ${origins.length} https origin(s)`);
}

// ---------------------------------------------------------------- built bundle leak scan
const dist = path.resolve('dist');
console.log('\n[frontend bundle leak scan]');
if (!fs.existsSync(dist)) warn('dist/ not found; run npm run build first');
else {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|html|css|json|webmanifest|map)$/.test(e.name)) files.push(p);
    }
  };
  walk(dist);
  const content = files.map((f) => fs.readFileSync(f, 'utf-8')).join('\n');
  // Secret VALUES from this file and from the local shop .env (only long, distinctive ones).
  const local = fs.existsSync('.env') ? dotenv.parse(fs.readFileSync('.env')) : {};
  const values = new Map<string, string>();
  for (const [src, e] of [['online', env], ['local', local]] as const) {
    for (const k of [...SERVER_ONLY, 'SUPABASE_ANON_KEY']) {
      const v = (e as any)[k];
      if (typeof v === 'string' && v.length >= 12 && !PLACEHOLDER.test(v)) values.set(`${src}:${k}`, v);
    }
  }
  const leakedValues = [...values].filter(([, v]) => content.includes(v)).map(([k]) => k);
  leakedValues.length ? fail(`secret value(s) found in dist/: ${leakedValues.join(', ')}`) : pass(`no secret values in dist/ (${files.length} files, ${values.size} secrets checked)`);
  const leakedNames = ['SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET', 'DATABASE_URL', 'SYNC_SHOP_TOKEN', 'DB_PASSWORD', 'SMTP_PASSWORD'].filter((n) => content.includes(n));
  leakedNames.length ? fail(`server-only variable name(s) referenced in dist/: ${leakedNames.join(', ')}`) : pass('no server-only variable names in dist/');
}

console.log(`\nRESULT: ${failed} failed, ${warned} warning(s)`);
process.exitCode = failed ? 1 : 0;
