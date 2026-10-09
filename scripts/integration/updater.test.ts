import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn, spawnSync } from 'child_process';
import { check, section, summary } from './harness';

/**
 * UPDATER + DEPLOYMENT SCRIPT tests.   npm run test:updater
 *
 * Runs the REAL scripts/updater/updater.mjs against throwaway git repositories in %TEMP%:
 *   origin.git (bare)  <- dev clone (makes commits on main / production)
 *   target clone       = the "pharmacy PC" working copy (with its own .env)
 * A small HTTP server plays the shop's /api/health: it reports the commit checked out in the target
 * and is unhealthy when the checked-out health.json says so (to force a rollback).
 * Nothing here touches the real repository, the database, Windows tasks or the network.
 */
const ROOT = path.resolve('.');
const UPDATER = path.join(ROOT, 'scripts', 'updater', 'updater.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-updater-'));
const origin = path.join(tmp, 'origin.git');
const dev = path.join(tmp, 'dev');
const target = path.join(tmp, 'target');
const approvalFile = path.join(tmp, 'approval.json');
const backupMarker = path.join(tmp, 'backups.log');
// Stands in for the verified pg_dump: records which commit was checked out when the backup ran.
const fakeBackup = path.join(tmp, 'fake-backup.mjs');
fs.writeFileSync(fakeBackup, [
  "import fs from 'fs';",
  "import { execSync } from 'child_process';",
  `const head = execSync('git rev-parse HEAD', { cwd: ${JSON.stringify(target)} }).toString().trim();`,
  `fs.appendFileSync(${JSON.stringify(backupMarker)}, head + String.fromCharCode(10));`,
].join('\n'));

function sh(cwd: string, exe: string, args: string[]) {
  const r = spawnSync(exe, args, { cwd, encoding: 'utf-8', windowsHide: true });
  if (r.status !== 0) throw new Error(`${exe} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}
const git = (cwd: string, ...args: string[]) => sh(cwd, 'git', ['-c', 'user.email=itest@example.invalid', '-c', 'user.name=itest', '-c', 'commit.gpgsign=false', ...args]);

function writeProject(dir: string, version: string, healthy = true) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'gc-updater-fixture', version, private: true,
    scripts: {
      lint: 'node -e "process.exit(0)"',
      build: 'node -e "require(\'fs\').writeFileSync(\'built.txt\', \'' + version + '\')"',
      'db:migrate': 'node -e "require(\'fs\').appendFileSync(\'migrated.log\', \'' + version + '\\n\')"',
      'db:check': 'node -e "process.exit(0)"',
    },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
    name: 'gc-updater-fixture', version, lockfileVersion: 3, requires: true, packages: { '': { name: 'gc-updater-fixture', version } },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'health.json'), JSON.stringify({ healthy }));
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n.env.online\nlogs/\nnode_modules/\nbuilt.txt\nmigrated.log\n');
}
function commit(msg: string, version: string, healthy = true, branches: string[] = ['main']) {
  writeProject(dev, version, healthy);
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', msg);
  const sha = git(dev, 'rev-parse', 'HEAD');
  for (const b of branches) git(dev, 'push', '-q', 'origin', `HEAD:refs/heads/${b}`, '--force');
  return sha;
}

// Fake /api/health of the pharmacy server.
let healthUp = true;
const server = http.createServer((req, res) => {
  if (!healthUp) {
    res.writeHead(503).end();
    return;
  }
  let commitId = '';
  let healthy = true;
  try {
    commitId = sh(target, 'git', ['rev-parse', 'HEAD']);
    healthy = JSON.parse(fs.readFileSync(path.join(target, 'health.json'), 'utf-8')).healthy !== false;
  } catch {
    healthy = false;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'online', system: 'GIGA CHEMIST POS API', app_mode: 'local', commit: commitId, database: { connected: healthy } }));
});

// Async: the fake health server lives in THIS process and must keep answering while the updater runs.
function updater(mode: string, extra: string[] = [], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  const port = (server.address() as any).port;
  const p = spawn(process.execPath, [UPDATER, mode, '--root', target, ...extra], {
    cwd: target, windowsHide: true,
    env: {
      ...process.env,
      UPDATER_HEALTH_URL: `http://127.0.0.1:${port}/api/health`, UPDATER_RESTART: 'none', UPDATER_HEALTH_TIMEOUT_SECONDS: '8',
      UPDATER_APPROVAL_FILE: approvalFile,
      UPDATER_BACKUP_CMD: `"${process.execPath}" "${fakeBackup}"`,
      UPDATE_BRANCH: 'production', UPDATE_REQUIRE_APPROVAL: 'true', APP_MODE: 'local', ...env,
    },
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  return new Promise((resolve) => p.on('close', (code) => resolve({ code, out })));
}
const state = () => JSON.parse(fs.readFileSync(path.join(target, 'logs', 'runtime', 'update-state.json'), 'utf-8'));
const headOf = (dir: string) => sh(dir, 'git', ['rev-parse', 'HEAD']);
const approve = (sha: string) => fs.writeFileSync(approvalFile, JSON.stringify({ target_commit: sha }));

async function updaterTests() {
  section('UPDATER — approved production channel, backup, health gate, rollback');
  sh(tmp, 'git', ['init', '-q', '--bare', origin]);
  sh(tmp, 'git', ['clone', '-q', origin, dev]);
  git(dev, 'checkout', '-q', '-b', 'main');
  const a = commit('A', '1.0.0', true, ['main', 'production']);
  sh(tmp, 'git', ['clone', '-q', '--branch', 'production', origin, target]);
  const SECRET = `JWT_SECRET=${'s'.repeat(48)}\nDB_PASSWORD=itest-not-real\n`;
  fs.writeFileSync(path.join(target, '.env'), SECRET);
  fs.writeFileSync(path.join(target, '.env.online'), 'SHOP_ID=c2a176c8-a50f-456f-a370-225c11d2e32f\n');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));

  let r = await updater('check');
  check(r.code === 0 && state().status === 'NO_UPDATE' && state().current_commit === a && state().current_version === '1.0.0', 'equal versions -> NO_UPDATE; current version recorded', state());

  const b = commit('B on main only', '1.1.0', true, ['main']);
  r = await updater('check');
  check(state().status === 'NO_UPDATE' && headOf(target) === a, 'a commit on main (not approved channel) is ignored');

  git(dev, 'push', '-q', 'origin', 'HEAD:refs/heads/production', '--force');
  r = await updater('check');
  check(state().status === 'UPDATE_AVAILABLE' && state().available_commit === b && state().available_version === '1.1.0', 'production moved -> UPDATE_AVAILABLE with version', state());

  r = await updater('auto');
  check(headOf(target) === a && state().status === 'UPDATE_AVAILABLE' && !fs.existsSync(backupMarker), 'not installed without Administrator approval (no backup, no change)');

  const c = commit('C on main only', '1.2.0', true, ['main']);
  r = await updater('install', ['--commit', c]);
  check(r.code !== 0 && headOf(target) === a && state().last_install?.result === 'REFUSED' && /not the tip of the approved branch/.test(state().last_install.detail), 'install of a commit that is not the production tip is REFUSED', state().last_install);

  approve(b);
  const envBefore = fs.readFileSync(path.join(target, '.env'), 'utf-8');
  r = await updater('auto');
  const backups = fs.existsSync(backupMarker) ? fs.readFileSync(backupMarker, 'utf-8').trim().split('\n') : [];
  check(r.code === 0 && headOf(target) === b && state().last_install?.result === 'SUCCESS' && state().status === 'NO_UPDATE' && state().current_commit === b,
    'approved update installed (checkout, npm ci, lint, build, migrate, health gate) -> SUCCESS', { code: r.code, s: state().last_install, out: r.out.slice(-500) });
  check(backups.length === 1 && backups[0] === a, 'verified backup taken BEFORE the code changed (backup ran on the old version)', backups);
  check(fs.readFileSync(path.join(target, '.env'), 'utf-8') === envBefore && fs.existsSync(path.join(target, '.env.online')), '.env and .env.online preserved');
  check(fs.readFileSync(path.join(target, 'built.txt'), 'utf-8') === '1.1.0' && /1\.1\.0/.test(fs.readFileSync(path.join(target, 'migrated.log'), 'utf-8')), 'new version built and migrations run');
  check(JSON.parse(fs.readFileSync(approvalFile, 'utf-8')).consumed === true, 'approval consumed (one approval = one install)');

  const d = commit('D unhealthy', '1.3.0', false, ['main', 'production']);
  await updater('check');
  approve(d);
  r = await updater('auto');
  check(headOf(target) === b && state().last_install?.result === 'ROLLED_BACK' && state().last_install.to === d && state().last_install.from === b,
    'new version fails its health check -> automatic CODE ROLLBACK to the previous version', state().last_install);
  check(fs.readFileSync(path.join(target, 'built.txt'), 'utf-8') === '1.1.0' && fs.readFileSync(path.join(target, '.env'), 'utf-8') === envBefore, 'previous build restored, .env untouched');
  r = await updater('auto');
  check(headOf(target) === b && fs.readFileSync(backupMarker, 'utf-8').trim().split('\n').length === 2, 'a rolled-back version is not retried without a NEW approval');

  const e = commit('E fixed', '1.3.1', true, ['main', 'production']);
  fs.appendFileSync(path.join(target, 'health.json'), ' ');
  approve(e);
  r = await updater('auto');
  check(headOf(target) === b && state().last_install?.result === 'REFUSED' && /local modifications/.test(state().last_install.detail), 'modified working copy -> REFUSED, nothing changed', state().last_install);
  git(target, 'checkout', '--', 'health.json');

  fs.writeFileSync(path.join(dev, '.env'), 'JWT_SECRET=from-repo\n');
  git(dev, 'add', '-f', '.env');
  writeProject(dev, '1.4.0', true);
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', 'F tracks .env');
  const f = git(dev, 'rev-parse', 'HEAD');
  git(dev, 'push', '-q', 'origin', 'HEAD:refs/heads/production', '--force');
  await updater('check');
  approve(f);
  r = await updater('auto');
  check(headOf(target) === b && state().last_install?.result === 'REFUSED' && /contains \.env/.test(state().last_install.detail) && fs.readFileSync(path.join(target, '.env'), 'utf-8') === envBefore,
    'a version that would overwrite .env is REFUSED', state().last_install);

  git(dev, 'rm', '-q', '--cached', '.env');
  fs.rmSync(path.join(dev, '.env'));
  git(dev, 'commit', '-q', '-m', 'G clean');
  const g = git(dev, 'rev-parse', 'HEAD');
  git(dev, 'push', '-q', 'origin', 'HEAD:refs/heads/production', '--force');
  healthUp = false;
  await updater('check');
  approve(g);
  r = await updater('auto');
  check(headOf(target) === b && state().last_install?.result === 'REFUSED' && /not healthy before the update/.test(state().last_install.detail) && fs.readFileSync(backupMarker, 'utf-8').trim().split('\n').length === 2,
    'current version unhealthy (database unreachable) -> REFUSED before backup / changes', state().last_install);
  healthUp = true;
  approve(g);
  r = await updater('auto');
  check(headOf(target) === g && state().last_install?.result === 'SUCCESS', 'install succeeds once the shop is healthy again');
  r = await updater('rollback');
  check(r.code === 0 && headOf(target) === b && state().last_install?.result === 'MANUAL_ROLLBACK', 'manual rollback returns to the previous version', state().last_install);

  const lockFile = path.join(target, 'logs', 'runtime', 'update.lock');
  fs.writeFileSync(lockFile, '{}');
  approve(g);
  r = await updater('auto');
  check(headOf(target) === b && /another update is in progress/.test(fs.readFileSync(path.join(target, 'logs', 'update.log'), 'utf-8')), 'deployment lock prevents two installs at once');
  fs.rmSync(lockFile);
  check(!fs.existsSync(path.join(target, 'logs', 'runtime', 'maintenance.lock')), 'maintenance lock never left behind');
}

function deployScriptTests() {
  section('DEPLOYMENT SCRIPTS — Task Scheduler configuration, no secrets');
  const dir = path.join(ROOT, 'deployment', 'windows');
  const files = ['install-giga-service.ps1', 'check-giga-service.ps1', 'remove-giga-service.ps1', 'giga-service-runner.ps1', 'start-giga.ps1', 'stop-giga.ps1',
    'watchdog.ps1', 'updater/run-updater.ps1', 'updater/check-for-update.ps1', 'updater/install-update.ps1', 'updater/rollback-update.ps1',
    'updater/install-updater-task.ps1', 'updater/remove-updater-task.ps1', 'updater/check-updater.ps1'];
  const text = (f: string) => fs.readFileSync(path.join(dir, f), 'utf-8');
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f));
    check(raw.every((byte) => byte < 128), `${f}: ASCII only (Windows PowerShell 5.1 safe)`);
  }
  if (process.platform === 'win32') {
    const list = files.map((f) => `'${path.join(dir, f).replace(/'/g, "''")}'`).join(',');
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$bad=0; foreach ($f in @(${list})) { $e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($f,[ref]$null,[ref]$e); if ($e.Count) { $bad++; Write-Output "$f $($e[0].Message)" } }; Write-Output "BAD=$bad"`],
    { encoding: 'utf-8' });
    check(/BAD=0/.test(ps.stdout), 'all deployment scripts parse in Windows PowerShell', ps.stdout.slice(-500));
  }
  const inst = text('install-giga-service.ps1');
  check(/NT AUTHORITY\\SYSTEM/.test(inst) && /-LogonType ServiceAccount/.test(inst), 'server task runs as SYSTEM (no interactive logon needed)');
  check(/New-ScheduledTaskTrigger -AtStartup/.test(inst) && /RepetitionInterval \(New-TimeSpan -Minutes 5\)/.test(inst), 'starts at boot + 5-minute watchdog trigger');
  check(/-MultipleInstances IgnoreNew/.test(inst) && /RestartCount/.test(inst) && /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/.test(inst), 'single instance, restart on failure, no time limit');
  check(/Set-Service -Name \$svc\.Name -StartupType Automatic/.test(inst) && /GIGA CHEMIST Watchdog/.test(inst), 'PostgreSQL forced to Automatic start; watchdog task registered');
  check(/-Profile Private/.test(inst) && !/LocalPort 5432/.test(inst), 'only the POS port on the Private profile; PostgreSQL never opened');
  const all = files.map(text).join('\n');
  check(!/\$env:APP_MODE\s*=/.test(all) && !/(PASSWORD|SECRET|TOKEN|SERVICE_ROLE)[A-Z_]*\s*=\s*['"][^'"$]/.test(all), 'no APP_MODE override and no secret literals in scripts / task arguments');
  check(/maintenance\.lock/.test(text('giga-service-runner.ps1')) && /restarts\.log/.test(text('giga-service-runner.ps1')), 'supervisor honours the updater maintenance lock and records restarts');
  const upd = text('updater/install-updater-task.ps1');
  check(/-Mode auto/.test(upd) && /RepetitionInterval \(New-TimeSpan -Minutes \$IntervalMinutes\)/.test(upd) && /\[int\]\$IntervalMinutes = 10/.test(upd) && /NT AUTHORITY\\SYSTEM/.test(upd),
    'updater task: SYSTEM, every 10 minutes, approval-gated auto mode');
  check(!/github_pat_|ghp_[A-Za-z0-9]/.test(all), 'no GitHub token in deployment scripts');

  section('TARGET-RUN — numbered installation scripts');
  const runDir = path.join(ROOT, 'TARGET-RUN');
  const runs = ['run1.ps1', 'run2.ps1', 'run3.ps1', 'run4.ps1', 'run5.ps1', 'run6.ps1', 'run7.ps1', 'run8.ps1', 'lib/common.ps1', 'README-FIRST.txt'];
  check(runs.every((f) => fs.existsSync(path.join(runDir, f))), 'run1..run8, lib/common.ps1 and README-FIRST.txt exist');
  const rt = (f: string) => fs.readFileSync(path.join(runDir, f), 'utf-8');
  check(runs.every((f) => fs.readFileSync(path.join(runDir, f)).every((b) => b < 128)), 'all TARGET-RUN files are ASCII');
  if (process.platform === 'win32') {
    const list = runs.filter((f) => f.endsWith('.ps1')).map((f) => `'${path.join(runDir, f).replace(/'/g, "''")}'`).join(',');
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$bad=0; foreach ($f in @(${list})) { $e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($f,[ref]$null,[ref]$e); if ($e.Count) { $bad++; Write-Output "$f $($e[0].Message)" } }; Write-Output "BAD=$bad"`],
    { encoding: 'utf-8' });
    check(/BAD=0/.test(ps.stdout), 'all TARGET-RUN scripts parse in Windows PowerShell', ps.stdout.slice(-300));
  }
  const allRuns = runs.filter((f) => f.endsWith('.ps1')).map(rt).join('\n');
  check(runs.filter((f) => /^run\d\.ps1$/.test(f)).every((f) => /Write-Title/.test(rt(f)) && /Assert-Admin/.test(rt(f)) && /Done |exit 0/.test(rt(f))), 'every step prints a title, requires Administrator and ends with PASS');
  check(/function Fail[\s\S]*exit 1/.test(rt('lib/common.ps1')), 'any FAIL stops the step (exit 1)');
  const withBootstrap = runs.filter((f) => f.endsWith('.ps1') && /sync:bootstrap/.test(rt(f)) && !/^lib/.test(f));
  check(withBootstrap.length === 1 && withBootstrap[0] === 'run6.ps1' && /Confirm-Text[^\n]*"BOOTSTRAP TARGET SHOP1"/.test(rt('run6.ps1')) && /bootstrap-done\.json/.test(rt('run6.ps1')) &&
        rt('run6.ps1').indexOf('Invoke-Check "bootstrap-guard"') > 0 &&
        rt('run6.ps1').indexOf('Invoke-Check "bootstrap-guard"') < rt('run6.ps1').indexOf('Confirm-Text') &&
        rt('run6.ps1').indexOf('Confirm-Text') < rt('run6.ps1').indexOf('Invoke-Npm @("run", "sync:bootstrap"'),
    'only run6 bootstraps: guard first, typed confirmation, one-time marker');
  check(!/dev-reset|db:seed|giga_chemist_dev|DROP DATABASE|TRUNCATE|install-autostart|remove-autostart|restart-service/i.test(allRuns.replace(/NEVER[^\n]*/g, '')), 'no destructive / development / legacy script is referenced');
  check(/backup/.test(rt('run1.ps1')) && rt('run1.ps1').indexOf('"preflight"') < rt('run1.ps1').indexOf('"backup"'), 'run1 makes the verified backup after the preflight');
  check(/--source-db giga_chemist/.test(rt('run2.ps1')) && /result -ne "PASS"/.test(rt('run3.ps1')) && rt('run3.ps1').indexOf('PASS') < rt('run3.ps1').indexOf('db:migrate'),
    'migrations only after a PASS rehearsal (run2 -> run3)');
  check(/install-giga-service\.ps1/.test(rt('run5.ps1')) && /install-updater-task\.ps1/.test(rt('run5.ps1')) && /check-giga-service\.ps1/.test(rt('run5.ps1')), 'run5 uses the new service / updater installers and checks');
  check(/Read-Host[\s\S]*REBOOT/.test(rt('run8.ps1')) && /-ceq "REBOOT"/.test(rt('run8.ps1')), 'run8 reboots only after the operator types REBOOT');
  check(!/Write-Host[^\n]*\$envMap\[/.test(allRuns) && !/Write-Host[^\n]*(DB_PASSWORD|SYNC_SHOP_TOKEN|JWT_SECRET)/.test(allRuns), 'scripts never print .env secret values');
}

async function main() {
  deployScriptTests();
  try {
    await updaterTests();
  } finally {
    server.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* temp leftovers are harmless */
    }
  }
  process.exitCode = summary() ? 1 : 0;
}

main().catch((err) => {
  console.error('[updater] aborted:', err?.message || err);
  server.close();
  process.exitCode = 1;
});
