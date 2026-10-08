import React, { useEffect, useRef, useState } from 'react';
import { Cloud, CloudOff, Database, RefreshCw, ServerCrash, AlertTriangle, X } from 'lucide-react';
import {
  subscribeCloudSync,
  refreshCloudSyncStatus,
  requestSyncNow,
  requeueFailedEvents,
  type CloudSyncSnapshot,
  type SyncIndicatorState,
} from '../../services/cloudSync';
import { isAdmin } from '../../services/permissions';
import type { User } from '../../types';

interface SyncIndicatorProps {
  currentUser: User | null;
  /** Re-hydrates this browser's cache from the local server (existing behaviour). */
  onRefreshCache: () => void;
  isRefreshing: boolean;
}

const LABELS: Record<SyncIndicatorState, (n: number) => string> = {
  SERVER_UNREACHABLE: () => 'POS SERVER UNREACHABLE',
  DATABASE_UNAVAILABLE: () => 'DATABASE UNAVAILABLE',
  LOCAL: () => 'LOCAL',
  ONLINE_READONLY: () => 'ONLINE — CLOUD COPY (READ-ONLY)',
  LOCAL_SYNC_OFF: (n) => (n > 0 ? `LOCAL — CLOUD SYNC OFF (${n} queued)` : 'LOCAL — CLOUD SYNC OFF'),
  ONLINE_SYNCED: () => 'ONLINE — SYNCED',
  ONLINE_SYNCING: (n) => `ONLINE — SYNCING (${n})`,
  OFFLINE_PENDING: (n) => `OFFLINE — ${n} PENDING`,
  SYNC_ERROR: (n) => `SYNC ERROR — ${n} PENDING`,
  UNKNOWN: () => 'CHECKING…',
};

const DOT: Record<SyncIndicatorState, string> = {
  SERVER_UNREACHABLE: 'bg-rose-500',
  DATABASE_UNAVAILABLE: 'bg-rose-500',
  LOCAL: 'bg-slate-400',
  ONLINE_READONLY: 'bg-sky-400',
  LOCAL_SYNC_OFF: 'bg-slate-400',
  ONLINE_SYNCED: 'bg-emerald-500',
  ONLINE_SYNCING: 'bg-teal-400 animate-pulse',
  OFFLINE_PENDING: 'bg-amber-500',
  SYNC_ERROR: 'bg-rose-500',
  UNKNOWN: 'bg-slate-500',
};

const TEXT: Record<SyncIndicatorState, string> = {
  SERVER_UNREACHABLE: 'text-rose-300',
  DATABASE_UNAVAILABLE: 'text-rose-300',
  LOCAL: 'text-slate-300',
  ONLINE_READONLY: 'text-sky-300',
  LOCAL_SYNC_OFF: 'text-slate-300',
  ONLINE_SYNCED: 'text-slate-200',
  ONLINE_SYNCING: 'text-teal-300',
  OFFLINE_PENDING: 'text-amber-300',
  SYNC_ERROR: 'text-rose-300',
  UNKNOWN: 'text-slate-400',
};

function fmt(ts?: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'medium' });
}

function StateIcon({ state }: { state: SyncIndicatorState }) {
  const cls = 'w-3.5 h-3.5';
  if (state === 'SERVER_UNREACHABLE') return <ServerCrash className={`${cls} text-rose-400`} />;
  if (state === 'DATABASE_UNAVAILABLE') return <Database className={`${cls} text-rose-400`} />;
  if (state === 'OFFLINE_PENDING') return <CloudOff className={`${cls} text-amber-400`} />;
  if (state === 'SYNC_ERROR') return <AlertTriangle className={`${cls} text-rose-400`} />;
  if (state === 'LOCAL' || state === 'LOCAL_SYNC_OFF') return <Database className={`${cls} text-slate-400`} />;
  return <Cloud className={`${cls} text-slate-300`} />;
}

/**
 * Small header indicator. "POS server" (local, decides whether selling works) and "cloud" (only
 * decides when queued events are delivered) are shown as different states. Admins can open the
 * details panel and use Sync Now; Cashiers only see the label.
 */
export const SyncIndicator: React.FC<SyncIndicatorProps> = ({ currentUser, onRefreshCache, isRefreshing }) => {
  const [snap, setSnap] = useState<CloudSyncSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const admin = isAdmin(currentUser);

  useEffect(() => subscribeCloudSync(setSnap), []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const state = snap?.state || 'UNKNOWN';
  const pending = snap?.pending || 0;
  // Online Administrators can queue remote changes (applied by the shop computer); the cloud copy itself stays read-only.
  const label = state === 'ONLINE_READONLY' && admin ? 'ONLINE — CLOUD COPY · REMOTE ADMIN ENABLED' : LABELS[state](pending);
  const s = snap?.status;
  const title =
    state === 'SERVER_UNREACHABLE'
      ? 'This screen cannot reach the GIGA CHEMIST POS server. Check that the server PC is on.'
      : state === 'OFFLINE_PENDING'
      ? 'No cloud connection. Sales continue normally on the local server; queued records sync automatically when the internet returns.'
      : 'Local POS server connected';

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await fn());
    } catch (err: any) {
      setMessage(err?.message || 'Request failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex items-center gap-1.5 text-xs" ref={panelRef}>
      <button
        type="button"
        onClick={() => admin && setOpen((v) => !v)}
        className={`flex items-center gap-1.5 px-1.5 py-0.5 rounded ${admin ? 'hover:bg-slate-800 cursor-pointer' : 'cursor-default'}`}
        title={title}
        aria-label={`Sync status: ${label}`}
      >
        <span className={`w-2 h-2 rounded-full ${DOT[state]}`} />
        <StateIcon state={state} />
        <span className={`font-medium ${TEXT[state]}`}>{label}</span>
      </button>

      <button
        onClick={onRefreshCache}
        disabled={isRefreshing}
        className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition cursor-pointer"
        title="Reload this screen's data from the local POS server"
        aria-label="Reload data from the local server"
      >
        <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin text-teal-400' : ''}`} />
      </button>

      {open && admin && (
        <div className="absolute top-8 left-1/2 -translate-x-1/2 w-[22rem] max-w-[90vw] bg-white text-slate-800 rounded border border-slate-300 shadow-lg z-50 p-3 select-text">
          <div className="flex items-center justify-between mb-2">
            <span className="font-bold text-sm">Cloud Sync Status</span>
            <button onClick={() => setOpen(false)} className="p-1 rounded hover:bg-slate-100" aria-label="Close">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
            <dt className="text-slate-500">POS server</dt>
            <dd>{snap?.serverReachable ? 'Connected' : 'Unreachable'}</dd>
            <dt className="text-slate-500">Local database</dt>
            <dd>{s?.local_database ? (s.local_database.connected ? 'Connected' : 'NOT connected') : '—'}</dd>
            <dt className="text-slate-500">Mode</dt>
            <dd>{s ? `${s.mode.toUpperCase()}${s.mode === 'hybrid' ? (s.enabled ? ' · sync on' : ' · sync off') : ''}` : '—'}</dd>
            <dt className="text-slate-500">Cloud</dt>
            <dd>
              {s?.cloud
                ? s.cloud.configured
                  ? `${s.cloud.host || ''} · ${s.cloud_reachable === true ? 'reachable' : s.cloud_reachable === false ? 'unreachable' : 'not checked yet'}`
                  : `not configured (${s.cloud.config_error})`
                : '—'}
            </dd>
            <dt className="text-slate-500">Pending</dt>
            <dd>{s?.counts ? `${s.counts.pending + (s.counts.processing || 0)}` : '—'}</dd>
            <dt className="text-slate-500">Retrying</dt>
            <dd>{s?.counts?.retrying ?? '—'}</dd>
            <dt className="text-slate-500">Failed</dt>
            <dd className={s?.counts?.failed ? 'text-rose-700 font-semibold' : ''}>{s?.counts?.failed ?? '—'}</dd>
            <dt className="text-slate-500">Synced</dt>
            <dd>{s?.counts?.synced ?? '—'}</dd>
            <dt className="text-slate-500">Oldest pending</dt>
            <dd>{fmt(s?.counts?.oldest_pending_at)}</dd>
            <dt className="text-slate-500">Last successful sync</dt>
            <dd>{fmt(s?.last_sync)}</dd>
            <dt className="text-slate-500">Last error</dt>
            <dd className="break-words">{s?.last_error ? `${s.last_error} (${fmt(s.last_error_at)})` : '—'}</dd>
            {s?.worker?.halted_reason && (
              <>
                <dt className="text-slate-500">Halted</dt>
                <dd className="text-rose-700 break-words">{s.worker.halted_reason}</dd>
              </>
            )}
            <dt className="text-slate-500">Shop ID</dt>
            <dd className="font-mono break-all">{s?.shop_id ? `${s.shop_code} · ${s.shop_id}` : '—'}</dd>
            <dt className="text-slate-500">Device ID</dt>
            <dd className="font-mono">{s?.device_id || '—'}</dd>
          </dl>
          <div className="flex flex-wrap gap-2 mt-3">
            <button
              disabled={busy || !s?.enabled}
              onClick={() => run(async () => ((await requestSyncNow()) === 'throttled' ? 'Already requested a moment ago.' : 'Sync requested.'))}
              className="px-2.5 py-1 rounded bg-teal-700 text-white text-xs font-semibold disabled:opacity-50 cursor-pointer"
            >
              Sync Now
            </button>
            {(s?.counts?.failed || 0) > 0 && (
              <button
                disabled={busy}
                onClick={() => run(async () => `${await requeueFailedEvents()} failed event(s) re-queued.`)}
                className="px-2.5 py-1 rounded border border-slate-300 text-xs font-semibold disabled:opacity-50 cursor-pointer"
              >
                Retry failed
              </button>
            )}
            <button
              disabled={busy}
              onClick={() => run(async () => ((await refreshCloudSyncStatus()), 'Status refreshed.'))}
              className="px-2.5 py-1 rounded border border-slate-300 text-xs font-semibold disabled:opacity-50 cursor-pointer"
            >
              Refresh
            </button>
          </div>
          {message && <p className="mt-2 text-[11px] text-slate-600">{message}</p>}
        </div>
      )}
    </div>
  );
};
