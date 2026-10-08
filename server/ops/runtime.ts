import fs from 'fs';
import path from 'path';

/**
 * Runtime state files shared by the Windows supervisor, the updater and the server
 * (<project>/logs/runtime by default; logs/ is git-ignored and preserved by updates).
 *   update-state.json   written by scripts/updater/updater.mjs (status of the approved channel)
 *   restarts.log        one line per server restart, written by giga-service-runner.ps1
 *   maintenance.lock    present while the updater replaces the code (the supervisor waits)
 * Nothing in these files is secret.
 */
export function runtimeDir(): string {
  return path.resolve(process.env.GIGA_RUNTIME_DIR || path.join('logs', 'runtime'));
}

export function readRuntimeJson<T = any>(name: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(runtimeDir(), name), 'utf-8').replace(/^﻿/, '')) as T;
  } catch {
    return null;
  }
}

export interface UpdateState {
  status: string;
  channel?: string;
  current_commit?: string | null;
  current_version?: string | null;
  available_commit?: string | null;
  available_version?: string | null;
  checked_at?: string | null;
  last_install?: { at: string; from: string; to: string; result: string; detail?: string } | null;
  message?: string | null;
}

export const readUpdateState = () => readRuntimeJson<UpdateState>('update-state.json');

/** Server restarts recorded by the supervisor in the last `hours`. */
export function recentRestarts(hours = 1): number {
  try {
    const since = Date.now() - hours * 3_600_000;
    return fs.readFileSync(path.join(runtimeDir(), 'restarts.log'), 'utf-8').split(/\r?\n/)
      .filter((l) => l.trim() && Date.parse(l.trim().split(/\s+/)[0]) >= since).length;
  } catch {
    return 0;
  }
}

/** Git commit of the running code (reads .git directly; no git binary needed). */
export function currentCommit(root = process.cwd()): string | null {
  try {
    let gitDir = path.join(root, '.git');
    if (fs.statSync(gitDir).isFile()) gitDir = path.resolve(root, fs.readFileSync(gitDir, 'utf-8').replace('gitdir:', '').trim());
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = head.replace(/^ref:\s*/, '');
    const loose = path.join(gitDir, ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf-8').trim();
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf-8').split('\n').find((l) => l.endsWith(` ${ref}`));
    return packed ? packed.split(' ')[0] : null;
  } catch {
    return null;
  }
}

/** Removes things that look like credentials or connection strings from an error text. */
export function sanitizeText(v: unknown, max = 300): string | null {
  if (v === null || v === undefined || v === '') return null;
  return String(v)
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]*@[^\s'"]*/gi, '[connection hidden]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, '[token hidden]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, (m) => (/^[0-9a-f]{40}$/.test(m) ? m : '[secret hidden]'))
    .replace(/(password|pwd|secret|token|apikey|api_key)\s*[=:]\s*\S+/gi, '$1=[hidden]')
    .slice(0, max);
}

let version: string | null = null;
/** package.json version of the running code. */
export function appVersion(): string {
  if (version) return version;
  try {
    version = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8')).version || '0.0.0';
  } catch {
    version = '0.0.0';
  }
  return version!;
}
