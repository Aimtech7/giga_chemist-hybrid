import { resolveApiBase, joinApiUrl, sanitizeApiOverride } from '../../src/services/api';

/**
 * Regression tests for frontend API URL resolution (same-origin by default; placeholders ignored).
 *   npm run test:api-url        (also run by npm run test:online)
 */
export function apiUrlTests(check: (cond: boolean, label: string, detail?: unknown) => void) {
  const url = (override: unknown, endpoint: string, pathname = '/') => joinApiUrl(resolveApiBase(override, pathname), endpoint);
  for (const v of ['', '   ', undefined, null, 'REQUIRED_USER_INPUT', 'required_user_input', 'YOUR_API_URL', 'https://YOUR-API-HOST.example.com',
    'PLACEHOLDER', 'https://placeholder.example', 'CHANGE_ME', '<api-url>', 'undefined', 'null', 'ftp://host/api', 'not a url', '//evil.example/api']) {
    check(resolveApiBase(v, '/') === '/api', `VITE_API_URL=${JSON.stringify(v)} -> /api`, resolveApiBase(v, '/'));
  }
  check(url('REQUIRED_USER_INPUT', '/api/auth/login') === '/api/auth/login', 'placeholder never reaches the URL: /api/auth/login', url('REQUIRED_USER_INPUT', '/api/auth/login'));
  check(url('', '/api/auth/login') === '/api/auth/login' && url('', '/api/health') === '/api/health', 'blank -> same-origin /api/auth/login, /api/health');
  check(url('', 'api/medicines') === '/api/medicines' && url('', '/api') === '/api', 'endpoint without leading slash / bare /api');
  for (const [ov, path] of [['', '/'], ['', '/sales'], ['REQUIRED_USER_INPUT', '/reports']] as const) {
    const u = url(ov, '/api/auth/login', path);
    check(!u.includes('/api/api') && !u.includes('REQUIRED_USER_INPUT'), `no /api/api or placeholder (page ${path})`, u);
  }
  check(url('http://192.168.1.50:3000', '/api/auth/login') === 'http://192.168.1.50:3000/api/auth/login', 'explicit LAN host is kept: http://192.168.1.50:3000/api/auth/login');
  check(url('http://192.168.1.50:3000/api/', '/api/sales') === 'http://192.168.1.50:3000/api/sales', 'explicit LAN /api base with trailing slash: no /api/api');
  check(url('https://pos.example.org', '/api/health') === 'https://pos.example.org/api/health', 'explicit https host kept');
  check(url('/custom/api', '/api/health') === '/custom/api/health', 'explicit path base kept');
  check(url('', '/api/health', '/giga-chemist/app/') === '/giga-chemist/api/health', 'Apache /giga-chemist subfolder kept');
  check(url('REQUIRED_USER_INPUT', '/api/health', '/giga-chemist/') === '/giga-chemist/api/health', 'placeholder + subfolder -> subfolder API');
  check(sanitizeApiOverride('http://localhost:3000') === 'http://localhost:3000', 'explicit localhost override still allowed for local dev');
}

const isMain = process.argv[1] && /api-url\.test\.ts$/.test(process.argv[1]);
if (isMain) {
  let passed = 0;
  let failed = 0;
  apiUrlTests((cond, label, detail) => {
    if (cond) passed++;
    else failed++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  });
  console.log(`\n  RESULT: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
