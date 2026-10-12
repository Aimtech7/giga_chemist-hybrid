// npm run lint — TypeScript check of the files TRACKED by git only.
//
// tsconfig.json has no "include", so a plain `tsc --noEmit` checks every .ts/.tsx file in the
// folder, including leftovers that are not part of the release (e.g. an old untracked test script
// on a shop computer). The shop updater runs `npm run lint` before activating a release, so such a
// file used to fail the update and roll it back. This checks exactly the release's files instead.
// Outside a git checkout (or without git) it falls back to the plain project check.
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

// Same lookup as scripts/updater/updater.mjs: the shop service may not have git on its PATH.
function gitExe() {
  if (process.env.UPDATER_GIT) return process.env.UPDATER_GIT;
  if (process.platform === 'win32') {
    for (const p of ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe']) if (fs.existsSync(p)) return p;
  }
  return 'git';
}

let files = null;
try {
  const out = execFileSync(gitExe(), ['-c', `safe.directory=${root.replace(/\\/g, '/')}`, 'ls-files', '-z', '--', '*.ts', '*.tsx'],
    { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  files = out.split('\0').filter(Boolean).filter((f) => fs.existsSync(path.join(root, f)));
} catch {
  files = null;
}

let args = ['--noEmit', '-p', path.join(root, 'tsconfig.json')];
if (files && files.length) {
  const dir = path.join(root, 'node_modules', '.cache');
  fs.mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, 'tsconfig.lint.json');
  fs.writeFileSync(cfg, JSON.stringify({
    extends: path.relative(dir, path.join(root, 'tsconfig.json')).replace(/\\/g, '/'),
    files: files.map((f) => path.relative(dir, path.join(root, f)).replace(/\\/g, '/')),
  }));
  args = ['--noEmit', '-p', cfg];
  console.log(`lint: type-checking ${files.length} tracked TypeScript files`);
} else {
  console.log('lint: git file list unavailable; type-checking the whole project folder');
}
const r = spawnSync(process.execPath, [tsc, ...args], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
