// Scans the production frontend build (dist/) for things that must never ship to a browser.
//   npm run scan:dist          (after npm run build)   exit 1 on any finding
// Checks secret NAMES and the actual secret VALUES from .env (values are never printed), template
// placeholders, preview Vercel URLs and hard-coded localhost API URLs.
import fs from 'fs';
import path from 'path';

const dist = path.resolve(process.argv[2] || 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error(`No build in ${dist}. Run npm run build first.`);
  process.exit(2);
}
const env = {};
try {
  for (const line of fs.readFileSync('.env', 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  /* no .env: name checks only */
}

const names = ['SYNC_SHOP_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL', 'DB_PASSWORD', 'JWT_SECRET', 'SMTP_PASSWORD', 'BACKUP_ENCRYPTION_KEY',
  ['REQUIRED', 'USER', 'INPUT'].join('_'), 'service_role'];
const valueKeys = ['SYNC_SHOP_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL', 'LOCAL_DATABASE_URL', 'DB_PASSWORD', 'JWT_SECRET', 'SMTP_PASSWORD', 'SUPABASE_ANON_KEY', 'BACKUP_ENCRYPTION_KEY'];
const values = valueKeys.map((k) => [k, env[k]]).filter(([, v]) => v && v.length >= 6);
const patterns = [
  ['preview Vercel URL', /https?:\/\/(?!gigachem\.vercel\.app)[a-z0-9-]+\.vercel\.app/gi],
  ['localhost API URL', /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/api/gi],
  ['postgres connection string', /postgres(ql)?:\/\/[^\s"'`]+/gi],
];

const findings = [];
let scanned = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|mjs|html|css|json|webmanifest|txt|map)$/.test(e.name)) {
      scanned++;
      const t = fs.readFileSync(p, 'utf-8');
      for (const n of names) if (t.includes(n)) findings.push(`${path.relative(dist, p)}: name ${n}`);
      for (const [k, v] of values) if (t.includes(v)) findings.push(`${path.relative(dist, p)}: VALUE of ${k}`);
      for (const [label, re] of patterns) for (const m of t.match(re) || []) findings.push(`${path.relative(dist, p)}: ${label} ${m.slice(0, 60)}`);
    }
  }
})(dist);

console.log(`scan:dist — ${scanned} files in ${dist}, ${values.length} secret value(s) from .env checked`);
if (findings.length) {
  for (const f of findings) console.log(`  FOUND ${f}`);
  console.log(`RESULT: ${findings.length} finding(s)`);
  process.exit(1);
}
console.log('RESULT: clean (no secret names/values, placeholders, preview URLs or localhost API URLs)');
