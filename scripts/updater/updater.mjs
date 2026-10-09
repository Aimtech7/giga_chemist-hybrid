// GIGA CHEMIST — approved-channel software updater for the pharmacy PC.
//
// Plain Node.js with NO npm dependencies: it keeps working while it replaces node_modules
// (the Windows task runs a copy of this file from logs/runtime).
//
//   node scripts/updater/updater.mjs check      fetch the approved channel, record UPDATE_AVAILABLE / NO_UPDATE
//   node scripts/updater/updater.mjs auto       check, then install when the update is approved
//   node scripts/updater/updater.mjs install [--commit <sha>]   install the channel tip now (operator on the PC)
//   node scripts/updater/updater.mjs rollback   return to the last known-good commit
//   options: --root <dir> (default: current directory)
//
// SAFETY MODEL
//  * Only the tip of origin/<UPDATE_BRANCH> (default "production") is ever installed. main is
//    never installed. A requested commit must equal that tip after a fresh fetch.
//  * UPDATE_REQUIRE_APPROVAL=true (default): install only after an Administrator approved that
//    exact commit (APP_UPDATE_APPROVE command -> local update_approvals row).
//  * Before touching code: deployment lock, clean working tree, .env / .env.online untracked and
//    not present in the target commit, the CURRENT version healthy, and a VERIFIED pg_dump backup.
//  * Install: maintenance lock (the supervisor holds the server down) -> git checkout -> npm ci ->
//    lint -> build -> (optional migration rehearsal) -> db:migrate (additive migrations only by
//    policy) -> db:check -> restart -> health gate (API up, PostgreSQL connected, running commit
//    = target, sync worker running when hybrid sync is enabled).
//  * Any failure after the code changed: automatic ROLLBACK of the CODE to the previous commit,
//    rebuild, restart, health re-check. The database is never restored automatically (migrations
//    are forward-compatible, so the previous version keeps working on the newer schema).
//  * Status for the phone: logs/runtime/update-state.json (sent with the shop heartbeat).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'check';
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ROOT = path.resolve(opt('--root') || process.env.UPDATER_ROOT || process.cwd());
const RUNTIME = path.join(ROOT, 'logs', 'runtime');
const STATE_FILE = path.join(RUNTIME, 'update-state.json');
const LOCK_FILE = path.join(RUNTIME, 'update.lock');
const MAINT_LOCK = path.join(RUNTIME, 'maintenance.lock');
const LOG_FILE = path.join(ROOT, 'logs', 'update.log');

function readEnvFile() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf-8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env: defaults */
  }
  return out;
}
const ENV = readEnvFile();
const setting = (k, d) => process.env[k] ?? ENV[k] ?? d;

const CFG = {
  branch: setting('UPDATE_BRANCH', 'production'),
  remote: setting('UPDATE_REMOTE', 'origin'),
  requireApproval: String(setting('UPDATE_REQUIRE_APPROVAL', 'true')).toLowerCase() !== 'false',
  rehearse: String(setting('UPDATE_REHEARSE_MIGRATIONS', 'false')).toLowerCase() === 'true',
  healthUrl: process.env.UPDATER_HEALTH_URL || `http://127.0.0.1:${Number(setting('PORT', 3000)) || 3000}/api/health`,
  healthTimeoutMs: (Number(process.env.UPDATER_HEALTH_TIMEOUT_SECONDS) || 180) * 1000,
  restart: process.env.UPDATER_RESTART || (process.platform === 'win32' ? 'service' : 'none'),
  backupCmd: process.env.UPDATER_BACKUP_CMD || null,
  approvalFile: process.env.UPDATER_APPROVAL_FILE || null,
  skipLint: process.env.UPDATER_SKIP_LINT === 'true',
  expectedMode: String(setting('APP_MODE', 'local')).toLowerCase(),
  expectSync: String(setting('APP_MODE', '')).toLowerCase() === 'hybrid' && String(setting('SYNC_ENABLED', '')).toLowerCase() === 'true',
  port: Number(setting('PORT', 3000)) || 3000,
};

// ------------------------------------------------------------------ helpers
fs.mkdirSync(RUNTIME, { recursive: true });
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* logging never breaks an update */
  }
}

function gitExe() {
  if (process.env.UPDATER_GIT) return process.env.UPDATER_GIT;
  if (process.platform === 'win32') {
    for (const p of ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe']) if (fs.existsSync(p)) return p;
  }
  return 'git';
}
const GIT = gitExe();
const SAFE_DIR = ROOT.replace(/\\/g, '/');

function run(exe, args, { allowFail = false, quiet = false, env = {} } = {}) {
  const r = spawnSync(exe, args, { cwd: ROOT, encoding: 'utf-8', env: { ...process.env, ...env }, windowsHide: true, maxBuffer: 64 * 1024 * 1024, shell: false });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (!quiet && out) fs.appendFileSync(LOG_FILE, out.split('\n').slice(-40).map((l) => `    ${l}`).join('\n') + '\n');
  if (r.status !== 0 && !allowFail) {
    const err = new Error(`${path.basename(exe)} ${args.filter((a) => !a.startsWith('safe.directory')).join(' ')} failed (exit ${r.status ?? r.error?.code}): ${out.split('\n').slice(-3).join(' | ').slice(0, 400)}`);
    err.output = out;
    throw err;
  }
  return { code: r.status, out: (r.stdout || '').trim() };
}
const git = (args, o) => run(GIT, ['-c', `safe.directory=${SAFE_DIR}`, ...args], o);

function npm(args) {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(cli)) return run(process.execPath, [cli, ...args]);
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args);
}

function shell(commandLine) {
  // Operator/test-configured command (UPDATER_BACKUP_CMD). Never built from remote input.
  const r = spawnSync(commandLine, { cwd: ROOT, encoding: 'utf-8', shell: true, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (out) fs.appendFileSync(LOG_FILE, out.split('\n').slice(-20).map((l) => `    ${l}`).join('\n') + '\n');
  return { code: r.status, out };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}
function writeState(patch) {
  const next = { ...readState(), ...patch, channel: CFG.branch };
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, STATE_FILE);
  return next;
}

const head = () => git(['rev-parse', 'HEAD'], { quiet: true }).out;
const channelRef = () => `refs/remotes/${CFG.remote}/${CFG.branch}`;
function versionAt(rev) {
  try {
    return JSON.parse(git(['show', `${rev}:package.json`], { quiet: true }).out).version || null;
  } catch {
    return null;
  }
}
const sha256 = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchChannel() {
  const r = git(['fetch', '--quiet', '--no-tags', CFG.remote, `+refs/heads/${CFG.branch}:${channelRef()}`], { allowFail: true, quiet: true });
  if (r.code !== 0) {
    const missing = /couldn't find remote ref|not found/i.test(r.out);
    return { ok: false, missing, error: r.out.split('\n').slice(-2).join(' ').slice(0, 300) };
  }
  return { ok: true, tip: git(['rev-parse', channelRef()], { quiet: true }).out };
}

// ------------------------------------------------------------------ check
function check() {
  const current = head();
  const currentVersion = versionAt('HEAD');
  const f = fetchChannel();
  const base = { current_commit: current, current_version: currentVersion, checked_at: new Date().toISOString() };
  if (!f.ok) {
    const status = f.missing ? 'NO_CHANNEL' : 'CHECK_FAILED';
    const message = f.missing
      ? `The approved branch "${CFG.branch}" does not exist yet on ${CFG.remote}. Nothing will be installed until it is created.`
      : `Could not reach ${CFG.remote}: ${f.error}`;
    log(`check: ${status} ${message}`);
    return writeState({ ...base, status, available_commit: null, available_version: null, message });
  }
  if (f.tip === current) {
    log(`check: NO_UPDATE (${current.slice(0, 12)})`);
    return writeState({ ...base, status: 'NO_UPDATE', available_commit: null, available_version: null, message: null });
  }
  const st = readState();
  const message = st.last_install?.to === f.tip && st.last_install.result === 'ROLLED_BACK'
    ? 'This version failed its health check and was rolled back; approve again only after a fix.'
    : CFG.requireApproval ? 'Waiting for Administrator approval (Health > Software updates > Install).' : 'Will be installed automatically.';
  log(`check: UPDATE_AVAILABLE ${current.slice(0, 12)} -> ${f.tip.slice(0, 12)}`);
  return writeState({ ...base, status: 'UPDATE_AVAILABLE', available_commit: f.tip, available_version: versionAt(f.tip), message });
}

// ------------------------------------------------------------------ approval
function approvalFor(commit) {
  if (CFG.approvalFile) {
    try {
      const a = JSON.parse(fs.readFileSync(CFG.approvalFile, 'utf-8'));
      return a.target_commit === commit && !a.consumed ? { approved: true, id: 'file' } : { approved: false };
    } catch {
      return { approved: false };
    }
  }
  const r = run(process.execPath, ['--import', 'tsx', 'scripts/updater/approval.ts', 'get', commit], { allowFail: true, quiet: true });
  try {
    return JSON.parse(r.out.split('\n').filter((l) => l.startsWith('{')).pop() || '{}');
  } catch {
    return { approved: false };
  }
}
function consumeApproval(commit, outcome, detail) {
  if (CFG.approvalFile) {
    try {
      const a = JSON.parse(fs.readFileSync(CFG.approvalFile, 'utf-8'));
      if (a.target_commit === commit) fs.writeFileSync(CFG.approvalFile, JSON.stringify({ ...a, consumed: true, outcome }));
    } catch {
      /* ignore */
    }
    return;
  }
  run(process.execPath, ['--import', 'tsx', 'scripts/updater/approval.ts', 'consume', commit, outcome, String(detail || '').slice(0, 500)], { allowFail: true, quiet: true });
}

// ------------------------------------------------------------------ service control
function stopServer() {
  if (CFG.restart !== 'service') return;
  // The supervisor sees maintenance.lock and does not restart it until the lock is removed.
  if (process.platform === 'win32') {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-NetTCPConnection -LocalPort ${CFG.port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`],
    { allowFail: true, quiet: true });
  }
}
async function waitPortFree(ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      await fetch(CFG.healthUrl, { signal: AbortSignal.timeout(1500) });
      await sleep(1000);
    } catch {
      return true;
    }
  }
  return false;
}

async function healthy(expectedCommit, timeoutMs = CFG.healthTimeoutMs) {
  const end = Date.now() + timeoutMs;
  let good = 0;
  let last = 'no answer';
  while (Date.now() < end) {
    try {
      const r = await fetch(CFG.healthUrl, { signal: AbortSignal.timeout(4000) });
      const h = await r.json();
      const problems = [];
      if (!r.ok) problems.push(`HTTP ${r.status}`);
      if (!h?.system?.startsWith('GIGA CHEMIST')) problems.push('not the GIGA CHEMIST API');
      if (!h?.database?.connected) problems.push('PostgreSQL not connected');
      if (expectedCommit && h.commit !== expectedCommit) problems.push(`running commit ${String(h.commit).slice(0, 12)} != ${expectedCommit.slice(0, 12)}`);
      if (CFG.expectedMode && h.app_mode && h.app_mode !== CFG.expectedMode) problems.push(`mode ${h.app_mode} != ${CFG.expectedMode}`);
      if (CFG.expectSync && h.sync_worker && !h.sync_worker.enabled) problems.push('sync worker not running');
      if (problems.length === 0) {
        if (++good >= 2) return { ok: true, detail: 'healthy' };
      } else {
        good = 0;
        last = problems.join('; ');
      }
    } catch (err) {
      good = 0;
      last = String(err?.message || err).slice(0, 200);
    }
    await sleep(2500);
  }
  return { ok: false, detail: last };
}

// ------------------------------------------------------------------ locks
function acquireLock() {
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    fs.closeSync(fd);
    return true;
  } catch {
    const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
    if (age > 2 * 3_600_000) {
      log('lock: removing a stale deployment lock (older than 2 h)');
      fs.unlinkSync(LOCK_FILE);
      return acquireLock();
    }
    return false;
  }
}
const setMaintenance = () => fs.writeFileSync(MAINT_LOCK, JSON.stringify({ by: 'updater', pid: process.pid, at: new Date().toISOString() }));
const clearMaintenance = () => {
  try {
    fs.unlinkSync(MAINT_LOCK);
  } catch {
    /* already gone */
  }
};

// ------------------------------------------------------------------ build steps
function buildActivate(commit, { lint }) {
  git(['checkout', '--quiet', '--detach', commit]);
  npm(['ci', '--no-audit', '--no-fund']);
  if (lint && !CFG.skipLint) npm(['run', 'lint']);
  npm(['run', 'build']);
  normalizeTree();
}

// A build may rewrite tracked generated files (api/index.js) with other line endings. Restore them
// when the ONLY difference is line endings; any real content change to tracked files is an error.
function normalizeTree() {
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], { quiet: true }).out;
  if (!dirty) return;
  // A full patch with CR-at-EOL ignored is empty when only line endings differ.
  const real = git(['diff', '--ignore-cr-at-eol'], { quiet: true }).out;
  if (real) {
    const files = git(['diff', '--name-only'], { quiet: true }).out.split(/\r?\n/).slice(0, 5).join(', ');
    throw new Error(`the build changed tracked files: ${files}`);
  }
  git(['checkout', '--', '.']);
  log(`build: restored ${dirty.split(/\r?\n/).length} tracked file(s) that differed only in line endings`);
}

async function install(requested) {
  if (!acquireLock()) {
    log('install: another update is in progress');
    return { result: 'BUSY' };
  }
  const startedAt = new Date().toISOString();
  let previous = null;
  let target = null;
  let codeChanged = false;
  const finish = (result, detail) => {
    const st = readState();
    const current = head();
    const lastInstall = { at: startedAt, finished_at: new Date().toISOString(), from: previous, to: target, result, detail: String(detail || '').slice(0, 500) };
    writeState({
      status: result === 'SUCCESS' ? 'NO_UPDATE' : result === 'ROLLED_BACK' || result === 'ROLLBACK_FAILED' ? 'FAILED' : st.status === 'INSTALLING' ? 'UPDATE_AVAILABLE' : st.status,
      current_commit: current, current_version: versionAt('HEAD'), last_install: lastInstall,
      last_good_commit: result === 'SUCCESS' ? current : st.last_good_commit ?? previous,
      available_commit: result === 'SUCCESS' ? null : st.available_commit, available_version: result === 'SUCCESS' ? null : st.available_version,
      message: result === 'SUCCESS' ? `Installed ${String(target).slice(0, 12)}.` : `${result}: ${String(detail || '').slice(0, 300)}`,
    });
    if (target) consumeApproval(target, result, detail);
    log(`install: ${result} ${detail || ''}`);
    return { result, detail };
  };
  try {
    // 1. Target = tip of the approved channel, re-fetched now.
    const f = fetchChannel();
    if (!f.ok) return finish('FAILED', f.missing ? `branch ${CFG.branch} missing` : `fetch failed: ${f.error}`);
    target = f.tip;
    if (requested && requested !== target) {
      return finish('REFUSED', `commit ${String(requested).slice(0, 12)} is not the tip of the approved branch ${CFG.branch} (${target.slice(0, 12)})`);
    }
    previous = head();
    if (previous === target) return finish('SUCCESS', 'already installed');
    git(['merge-base', '--is-ancestor', target, channelRef()]);

    // 2. Pre-flight (nothing changed yet).
    const dirty = git(['status', '--porcelain', '--untracked-files=no'], { quiet: true }).out;
    if (dirty) return finish('REFUSED', `working copy has local modifications: ${dirty.split('\n').slice(0, 5).join(', ')}`);
    for (const secret of ['.env', '.env.online']) {
      if (git(['ls-files', '--error-unmatch', secret], { allowFail: true, quiet: true }).code === 0) return finish('REFUSED', `${secret} is tracked by git`);
      if (git(['ls-tree', '--name-only', target, '--', secret], { quiet: true }).out) {
        return finish('REFUSED', `the target version contains ${secret}; it would overwrite the shop configuration`);
      }
    }
    if (!fs.existsSync(path.join(ROOT, '.env'))) return finish('REFUSED', '.env is missing on this computer');
    const envHash = { env: sha256(path.join(ROOT, '.env')), online: sha256(path.join(ROOT, '.env.online')) };
    writeState({ status: 'INSTALLING', message: `Installing ${target.slice(0, 12)}...` });

    // 3. The current version must be healthy (database reachable) before we start.
    const pre = await healthy(null, Math.min(CFG.healthTimeoutMs, 30_000));
    if (!pre.ok) return finish('REFUSED', `current version not healthy before the update (${pre.detail})`);

    // 4. Verified backup BEFORE any change.
    log(`install: backup before ${previous.slice(0, 12)} -> ${target.slice(0, 12)}`);
    const b = CFG.backupCmd ? shell(CFG.backupCmd) : run(process.execPath, ['--import', 'tsx', 'scripts/backup/backup-db.ts', '--pre-upgrade'], { allowFail: true });
    if (b.code !== 0) return finish('FAILED', 'pre-update backup failed; nothing was changed');

    // 5. Activate the new version.
    setMaintenance();
    stopServer();
    await waitPortFree();
    try {
      codeChanged = true;
      buildActivate(target, { lint: true });
      if (sha256(path.join(ROOT, '.env')) !== envHash.env || sha256(path.join(ROOT, '.env.online')) !== envHash.online) {
        throw new Error('.env changed during the update');
      }
      if (CFG.rehearse) npm(['run', 'target:rehearse']);
      npm(['run', 'db:migrate']);
      npm(['run', 'db:check']);
      clearMaintenance();
      const h = await healthy(target);
      if (!h.ok) throw new Error(`health check failed after the update: ${h.detail}`);
      return finish('SUCCESS', `${previous.slice(0, 12)} -> ${target.slice(0, 12)}`);
    } catch (err) {
      const why = String(err?.message || err).slice(0, 400);
      log(`install: FAILED (${why}); rolling back the code to ${previous.slice(0, 12)}`);
      return await rollbackTo(previous, why, finish);
    }
  } catch (err) {
    return finish(codeChanged ? 'ROLLBACK_FAILED' : 'FAILED', String(err?.message || err));
  } finally {
    clearMaintenance();
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {
      /* ignore */
    }
  }
}

async function rollbackTo(commit, why, finish) {
  try {
    setMaintenance();
    stopServer();
    await waitPortFree();
    buildActivate(commit, { lint: false });
    clearMaintenance();
    const h = await healthy(commit);
    if (!h.ok) return finish('ROLLBACK_FAILED', `${why} | previous version also unhealthy: ${h.detail}`);
    return finish('ROLLED_BACK', why);
  } catch (err) {
    clearMaintenance();
    return finish('ROLLBACK_FAILED', `${why} | rollback error: ${String(err?.message || err).slice(0, 200)}`);
  }
}

// ------------------------------------------------------------------ main
async function main() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) throw new Error(`${ROOT} is not a git working copy`);
  if (cmd === 'check') {
    check();
    return 0;
  }
  if (cmd === 'auto') {
    const st = check();
    if (st.status !== 'UPDATE_AVAILABLE') return 0;
    if (st.last_install?.to === st.available_commit && ['ROLLED_BACK', 'ROLLBACK_FAILED'].includes(st.last_install.result)) {
      const a = approvalFor(st.available_commit);
      if (!a.approved) return 0; // a failed version is retried only after a NEW approval
    }
    if (CFG.requireApproval && !approvalFor(st.available_commit).approved) {
      log(`auto: ${st.available_commit.slice(0, 12)} waits for approval`);
      return 0;
    }
    const r = await install(st.available_commit);
    return ['SUCCESS', 'BUSY'].includes(r.result) ? 0 : 1;
  }
  if (cmd === 'install') {
    const r = await install(opt('--commit'));
    return ['SUCCESS', 'BUSY'].includes(r.result) ? 0 : 1;
  }
  if (cmd === 'rollback') {
    if (!acquireLock()) return 1;
    try {
      const st = readState();
      const to = opt('--commit') || st.last_install?.from || st.last_good_commit;
      if (!to || !/^[0-9a-f]{40}$/.test(to)) throw new Error('no previous version recorded; pass --commit <sha>');
      git(['cat-file', '-e', `${to}^{commit}`]);
      const prev = head();
      const r = await rollbackTo(to, 'manual rollback', (result, detail) => {
        writeState({ current_commit: head(), current_version: versionAt('HEAD'), last_install: { at: new Date().toISOString(), from: prev, to, result: result === 'ROLLED_BACK' ? 'MANUAL_ROLLBACK' : result, detail } });
        log(`rollback: ${result} ${detail}`);
        return { result };
      });
      return r.result === 'ROLLED_BACK' ? 0 : 1;
    } finally {
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch {
        /* ignore */
      }
    }
  }
  console.error('usage: updater.mjs check|auto|install [--commit sha]|rollback [--commit sha] [--root dir]');
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log(`ERROR ${err?.message || err}`);
    try {
      writeState({ status: 'CHECK_FAILED', message: String(err?.message || err).slice(0, 300), checked_at: new Date().toISOString() });
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
