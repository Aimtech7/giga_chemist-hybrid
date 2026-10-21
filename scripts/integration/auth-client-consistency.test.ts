process.env.APP_MODE = 'hybrid';
import fs from 'fs';
import path from 'path';
import { check, section, summary } from './harness';

async function run() {
  section('TEST L & PART 1/2 — AUTHENTICATION CLIENT CONSISTENCY AUDIT');

  // 1. Audit DeleteMedicineModal.tsx
  const deleteModalPath = path.resolve('src/components/medicines/DeleteMedicineModal.tsx');
  const deleteModalContent = fs.readFileSync(deleteModalPath, 'utf-8');

  check(!deleteModalContent.includes("localStorage.getItem('token')"), 'DeleteMedicineModal does not read localStorage.getItem("token")');
  check(!deleteModalContent.includes("sessionStorage.getItem('token')"), 'DeleteMedicineModal does not read sessionStorage.getItem("token")');
  check(deleteModalContent.includes("import { apiFetch } from '../../services/http'"), 'DeleteMedicineModal imports canonical apiFetch');
  check(deleteModalContent.includes('/api/admin/medicines/'), 'DeleteMedicineModal calls preview endpoint');
  check(deleteModalContent.includes('DELETION ELIGIBILITY COULD NOT BE DETERMINED'), 'DeleteMedicineModal shows clear error on preview failure');
  check(deleteModalContent.includes('Retry Preview'), 'DeleteMedicineModal offers [ Retry Preview ] on failure');
  check(deleteModalContent.includes("preview?.outcome === 'PERMANENT_DELETE'") && deleteModalContent.includes("'Permanently Delete'"), 'DeleteMedicineModal strictly conditions button label on outcome');

  // 2. Scan entire src/ for prohibited raw token access
  const srcDir = path.resolve('src');
  const files: string[] = [];
  function scan(dir: string) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) scan(p);
      else if (f.name.endsWith('.ts') || f.name.endsWith('.tsx')) files.push(p);
    }
  }
  scan(srcDir);

  const rawTokenReaders: string[] = [];
  const rawFetchCallers: string[] = [];

  for (const f of files) {
    const rel = path.relative(process.cwd(), f).replace(/\\/g, '/');
    const content = fs.readFileSync(f, 'utf-8');

    // session.ts is the canonical place managing giga_chemist_auth_token
    if (rel === 'src/services/session.ts') continue;

    if (content.includes("localStorage.getItem('token')") || content.includes("sessionStorage.getItem('token')")) {
      rawTokenReaders.push(rel);
    }

    // Check for raw fetch('/api/' calls that bypass apiFetch for protected routes
    const matches = content.match(/fetch\(['"`]\/api\/[^'"`]+/g);
    if (matches) {
      for (const m of matches) {
        // Legitimate public or specialized calls
        if (m.includes('/api/login') || m.includes('/api/health') || m.includes('/api/device/register')) continue;
        rawFetchCallers.push(`${rel} -> ${m}`);
      }
    }
  }

  check(rawTokenReaders.length === 0, `No files manually read 'token' key (found ${rawTokenReaders.length}): ${rawTokenReaders.join(', ')}`);
  check(rawFetchCallers.length === 0, `No protected endpoints called with raw fetch bypassing apiFetch (found ${rawFetchCallers.length}): ${rawFetchCallers.join(', ')}`);

  // 3. Verify session.ts uses canonical token key
  const sessionPath = path.resolve('src/services/session.ts');
  const sessionContent = fs.readFileSync(sessionPath, 'utf-8');
  check(sessionContent.includes('giga_chemist_auth_token'), 'session.ts uses canonical giga_chemist_auth_token');

  // 4. Verify http.ts automatically injects canonical auth token
  const httpPath = path.resolve('src/services/http.ts');
  const httpContent = fs.readFileSync(httpPath, 'utf-8');
  check(httpContent.includes('getAuthToken()'), 'http.ts retrieves token via getAuthToken()');
  check(httpContent.includes('Authorization'), 'http.ts attaches Authorization header');

  // 5. Verify shopContext isGlobalAdminAccount token-level decoding
  const shopContextPath = path.resolve('src/services/shopContext.ts');
  const shopContextContent = fs.readFileSync(shopContextPath, 'utf-8');
  check(shopContextContent.includes("payload?.role === 'ADMIN'"), 'shopContext decodes JWT claims to prevent stale metadata hiding Global Admin');

  const code = summary();
  process.exit(code);
}

void run();
