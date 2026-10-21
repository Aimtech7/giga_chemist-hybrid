process.env.APP_MODE = 'hybrid';
import fs from 'fs';
import path from 'path';
import { check, section, summary } from './harness';

async function run() {
  section('PART 27 — PWA UPDATE & BUILD IDENTITY VERIFICATION');

  // 1. Verify vite.config.ts Workbox and Cache configuration
  const viteConfigPath = path.resolve('vite.config.ts');
  const viteContent = fs.readFileSync(viteConfigPath, 'utf-8');

  check(viteContent.includes('navigateFallbackDenylist') && viteContent.includes('^\\/api'), '1.1 /api/* explicitly denied from navigateFallback');
  check(viteContent.includes('runtimeCaching: []'), '1.2 runtimeCaching is empty (no runtime caching of API responses)');
  check(viteContent.includes('emptyOutDir: true'), '1.3 emptyOutDir: true cleans dist on every build');
  check(viteContent.includes('__FRONTEND_SHA__'), '1.4 __FRONTEND_SHA__ defined in vite build config');
  check(viteContent.includes('__APP_VERSION__'), '1.5 __APP_VERSION__ defined in vite build config');
  check(viteContent.includes('__BUILD_TIME__'), '1.6 __BUILD_TIME__ defined in vite build config');

  // 2. Verify BuildIdentityAndPwaUpdate.tsx component
  const pwaCompPath = path.resolve('src/components/common/BuildIdentityAndPwaUpdate.tsx');
  check(fs.existsSync(pwaCompPath), '2.1 BuildIdentityAndPwaUpdate.tsx exists');
  const pwaContent = fs.readFileSync(pwaCompPath, 'utf-8');

  check(pwaContent.includes('NEW VERSION AVAILABLE'), '2.2 Component renders "NEW VERSION AVAILABLE" alert');
  check(pwaContent.includes('Reload Now'), '2.3 Component renders [ Reload Now ] action');
  check(pwaContent.includes("type: 'SKIP_WAITING'"), '2.4 Component activates new worker safely via SKIP_WAITING');
  check(pwaContent.includes('last_pwa_reload'), '2.5 Component implements reload loop guard in sessionStorage');
  check(pwaContent.includes('window.location.reload()'), '2.6 Component triggers single window.location.reload()');
  check(pwaContent.includes('FRONTEND SHA'), '2.7 Component displays FRONTEND SHA');
  check(pwaContent.includes('API SHA'), '2.8 Component displays API SHA');
  check(pwaContent.includes('SHOP SHA'), '2.9 Component displays SHOP SHA');
  check(pwaContent.includes('VERSION'), '2.10 Component displays VERSION');

  // 3. Verify AppShell integration
  const appShellPath = path.resolve('src/components/layout/AppShell.tsx');
  const appShellContent = fs.readFileSync(appShellPath, 'utf-8');
  check(appShellContent.includes('BuildIdentityAndPwaUpdate'), '3.1 AppShell integrates BuildIdentityAndPwaUpdate');

  // 4. Verify src/vite-env.d.ts declarations
  const dtsPath = path.resolve('src/vite-env.d.ts');
  check(fs.existsSync(dtsPath), '4.1 src/vite-env.d.ts exists');
  const dtsContent = fs.readFileSync(dtsPath, 'utf-8');
  check(dtsContent.includes('declare const __FRONTEND_SHA__: string;'), '4.2 __FRONTEND_SHA__ typed in vite-env.d.ts');
  check(dtsContent.includes('declare const __APP_VERSION__: string;'), '4.3 __APP_VERSION__ typed in vite-env.d.ts');

  const code = summary();
  process.exit(code);
}

void run();
