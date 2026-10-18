import React, { useCallback, useEffect, useState } from 'react';
import {
  Loader2,
  RefreshCw,
  RotateCcw,
  Send,
  Waypoints,
  CheckCircle2,
  AlertTriangle,
  ShieldAlert,
  Search,
  Wrench,
  Check,
} from 'lucide-react';
import { apiFetch } from '../../services/http';
import { queueRemoteCommand } from '../../services/remoteAdmin';

/**
 * SYNC & CONFLICT CONTROL CENTER (Administrator).
 *   shop computer: this shop's outbox (sequence, failed events with the cloud's reason), recent remote
 *                  commands with a plain conflict reason; retry one / all failed events, sync now,
 *                  READ-ONLY SHOP CONSISTENCY CHECK, and controlled individual reconciliations.
 *   online app   : every authorized shop (contact, heartbeat, shop vs cloud sequence, outbox, commands,
 *                  version, device, last backup) + the selected shop's rejected commands / events;
 *                  retry a rejected command (ONE new linked command), ask the shop to re-send failed events
 * Retries never duplicate: events keep their idempotency keys; a rejected command changed nothing.
 */
const when = (v?: string | null) => (v ? new Date(v).toLocaleString() : '—');
const btn = 'px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold flex items-center gap-1 disabled:opacity-50 cursor-pointer hover:bg-slate-50 transition';
const Reason: React.FC<{ v?: string | null }> = ({ v }) => (v ? <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold whitespace-nowrap">{v.replace(/_/g, ' ')}</span> : null);

const Table: React.FC<{ cols: string[]; rows: React.ReactNode[][]; empty: string }> = ({ cols, rows, empty }) => (
  <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
    <table className="w-full text-xs">
      <thead className="bg-slate-50 text-slate-600"><tr>{cols.map((c) => <th key={c} className="px-2 py-2 text-left font-semibold whitespace-nowrap">{c}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, i) => <tr key={i} className="border-t border-slate-100 align-top">{r.map((c, j) => <td key={j} className="px-2 py-1.5">{c}</td>)}</tr>)}
        {!rows.length && <tr><td colSpan={cols.length} className="px-2 py-5 text-center text-slate-500">{empty}</td></tr>}
      </tbody>
    </table>
  </div>
);

export const SyncCenter: React.FC<{ online: boolean }> = ({ online }) => {
  const [data, setData] = useState<any>(null);
  const [issues, setIssues] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Shop Consistency Scanner state
  const [consistencyReport, setConsistencyReport] = useState<any>(null);
  const [runningCheck, setRunningCheck] = useState(false);
  const [parityReport, setParityReport] = useState<any>(null);
  const [runningParity, setRunningParity] = useState(false);
  const [reconcilingParity, setReconcilingParity] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      if (online) {
        const [a, b] = await Promise.all([apiFetch<any>('/api/admin/sync-center'), apiFetch<any>('/api/admin/sync-center/issues')]);
        setData(a);
        setIssues(b);
      } else {
        setData(await apiFetch<any>('/api/sync/center'));
      }
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Could not load the sync center.' });
    } finally {
      setBusy(false);
    }
  }, [online]);
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<any>, done: string) => {
    setBusy(true);
    try {
      const r = await fn();
      setMsg({ ok: true, text: `${done}${r?.requeued !== undefined ? ` (${r.requeued})` : r?.status ? ` (${r.status})` : ''}` });
      await load();
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Request failed.' });
    } finally {
      setBusy(false);
    }
  };

  const runConsistencyCheck = async () => {
    setRunningCheck(true);
    setMsg(null);
    try {
      const report = await apiFetch<any>('/api/sync/consistency-check');
      setConsistencyReport(report);
      setMsg({ ok: true, text: `Shop consistency scan completed at ${new Date(report.timestamp).toLocaleTimeString()}.` });
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Failed to run shop consistency check.' });
    } finally {
      setRunningCheck(false);
    }
  };

  const repairBaseline = async (medicineId: string, name: string) => {
    if (!window.confirm(`Re-publish authoritative baseline for "${name}"?\n\nThis locks the local medicine row, snapshots actual local stock & batches, and atomically replaces the cloud baseline.`)) return;
    await run(() => apiFetch('/api/sync/reconcile-baseline', { body: { medicine_id: medicineId } }), `Baseline re-published for ${name}`);
    await runConsistencyCheck();
  };

  const repairCatalogue = async (medicineId: string, name: string) => {
    await run(() => apiFetch('/api/sync/reconcile-catalogue', { body: { medicine_id: medicineId } }), `Catalogue re-published for ${name}`);
    await runConsistencyCheck();
  };

  const repairUserProfile = async (userId: string, name: string) => {
    await run(() => apiFetch('/api/sync/reconcile-user-profile', { body: { user_id: userId } }), `Profile re-published for ${name}`);
    await runConsistencyCheck();
  };

  const repairCredentials = async () => {
    await run(() => apiFetch('/api/sync/reconcile-credentials', { body: {} }), 'Credentials published to cloud');
    await runConsistencyCheck();
  };

  const runStockParityCheck = async () => {
    setRunningParity(true);
    setMsg(null);
    try {
      const report = await apiFetch<any>('/api/sync/stock-parity/check', { method: 'POST' });
      setParityReport(report);
      setMsg({ ok: true, text: `Stock parity check completed: ${report.summary.matched} matched, ${report.summary.mismatch} mismatched.` });
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Failed to check stock parity.' });
    } finally {
      setRunningParity(false);
    }
  };

  const reconcileAllStockParity = async () => {
    if (!window.confirm('Trigger authoritative baseline reconciliation for all mismatched medicines?\n\nDirection: LOCAL SHOP -> CLOUD (Local PostgreSQL is stock authority).')) return;
    setReconcilingParity(true);
    setMsg(null);
    try {
      const res = await apiFetch<any>('/api/sync/stock-parity/reconcile', { method: 'POST', body: { all: true } });
      setMsg({ ok: true, text: `Reconciled ${res.reconciledCount || 0} medicine(s) with cloud.` });
      await runStockParityCheck();
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Failed to reconcile stock parity.' });
    } finally {
      setReconcilingParity(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-bold text-slate-900 flex items-center gap-1.5"><Waypoints className="w-4 h-4 text-teal-700" /> Sync &amp; Conflict Center</h1>
          <p className="text-[11px] text-slate-500">Retries never duplicate: events keep their idempotency keys; a rejected command changed nothing and is re-sent once as a new linked command.</p>
        </div>
        <div className="flex gap-2">
          {!online && (
            <>
              <button
                className="px-3 py-1.5 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold flex items-center gap-1.5 shadow-xs cursor-pointer disabled:opacity-50 transition"
                disabled={runningCheck}
                onClick={runConsistencyCheck}
              >
                {runningCheck ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                <span>Run Consistency Check</span>
              </button>
              <button
                className="px-3 py-1.5 rounded-lg border border-teal-300 bg-teal-50 hover:bg-teal-100 text-teal-800 text-xs font-semibold flex items-center gap-1.5 shadow-xs cursor-pointer disabled:opacity-50 transition"
                disabled={runningParity}
                onClick={runStockParityCheck}
              >
                {runningParity ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                <span>Check Stock Sync Now</span>
              </button>
              <button className={btn} disabled={busy} onClick={() => void run(() => apiFetch('/api/sync/now', { body: {} }), 'Sync started')}><Send className="w-3.5 h-3.5" /> Sync now</button>
            </>
          )}
          <button className={btn} disabled={busy} onClick={() => void load()}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh</button>
        </div>
      </div>
      {msg && <div className={`text-xs rounded p-2 border ${msg.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>{msg.text}</div>}

      {/* Local Shop Consistency Audit & Controlled Reconciliation */}
      {/* Stock Parity / Auto-Reconciliation Status Card */}
      {!online && parityReport && (
        <div className="bg-white border border-slate-200 rounded-xl p-3.5 space-y-3 shadow-xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {parityReport.healthy ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
              ) : (
                <ShieldAlert className="w-5 h-5 text-rose-600 shrink-0" />
              )}
              <div>
                <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <span>Stock Parity</span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-100 text-slate-700 font-mono">LOCAL AUTHORITATIVE</span>
                </h2>
                <p className="text-[11px] text-slate-500">
                  Last checked: {new Date(parityReport.timestamp).toLocaleTimeString()} · Cloud status: {parityReport.cloud_accessible ? 'Connected' : 'Offline / Unreachable'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {parityReport.summary.mismatch > 0 && (
                <button
                  className="px-3 py-1 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold flex items-center gap-1 shadow-xs cursor-pointer disabled:opacity-50 transition"
                  disabled={reconcilingParity}
                  onClick={reconcileAllStockParity}
                >
                  {reconcilingParity ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wrench className="w-3.5 h-3.5" />}
                  <span>Reconcile All Mismatched ({parityReport.summary.mismatch})</span>
                </button>
              )}
              <button
                className="text-xs text-slate-500 hover:text-slate-800 font-semibold cursor-pointer"
                onClick={() => setParityReport(null)}
              >
                Dismiss
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="p-2.5 rounded-lg border border-slate-200 bg-emerald-50/50 text-emerald-950">
              <div className="text-[10px] uppercase font-semibold text-emerald-700">Matched</div>
              <div className="text-base font-bold font-mono">{parityReport.summary.matched}</div>
            </div>
            <div className="p-2.5 rounded-lg border border-slate-200 bg-sky-50/50 text-sky-950">
              <div className="text-[10px] uppercase font-semibold text-sky-700">Syncing / Pending</div>
              <div className="text-base font-bold font-mono">{parityReport.summary.syncing}</div>
            </div>
            <div className={`p-2.5 rounded-lg border ${parityReport.summary.mismatch > 0 ? 'bg-rose-50 border-rose-200 text-rose-950' : 'bg-slate-50 border-slate-200 text-slate-800'}`}>
              <div className="text-[10px] uppercase font-semibold text-slate-600">Mismatch</div>
              <div className="text-base font-bold font-mono">{parityReport.summary.mismatch}</div>
            </div>
            <div className="p-2.5 rounded-lg border border-slate-200 bg-slate-50 text-slate-800">
              <div className="text-[10px] uppercase font-semibold text-slate-600">Reconciled</div>
              <div className="text-base font-bold font-mono">{parityReport.summary.reconciled}</div>
            </div>
          </div>
        </div>
      )}
      {!online && consistencyReport && (
        <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-3 shadow-xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {consistencyReport.healthy ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
              ) : (
                <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0" />
              )}
              <div>
                <h2 className="text-sm font-bold text-slate-900">
                  Shop Consistency Audit {consistencyReport.healthy ? '— Fully Consistent' : '— Discrepancies Detected'}
                </h2>
                <p className="text-[11px] text-slate-500">
                  Read-only comparison of authoritative local PostgreSQL vs cloud. Select individual repair actions below.
                </p>
              </div>
            </div>
            <button
              className="text-xs text-slate-500 hover:text-slate-800 font-semibold cursor-pointer"
              onClick={() => setConsistencyReport(null)}
            >
              Dismiss
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
            <div className={`p-2 rounded-lg border ${consistencyReport.summary.negative_cloud_stock > 0 ? 'bg-rose-50 border-rose-200 text-rose-900' : 'bg-slate-50 border-slate-200'}`}>
              <div className="text-[10px] uppercase font-semibold text-slate-500">Negative Cloud Stock</div>
              <div className="text-sm font-bold">{consistencyReport.summary.negative_cloud_stock}</div>
            </div>
            <div className={`p-2 rounded-lg border ${consistencyReport.summary.stock_mismatches > 0 ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-slate-50 border-slate-200'}`}>
              <div className="text-[10px] uppercase font-semibold text-slate-500">Stock Mismatches</div>
              <div className="text-sm font-bold">{consistencyReport.summary.stock_mismatches}</div>
            </div>
            <div className={`p-2 rounded-lg border ${consistencyReport.summary.catalogue_missing_cloud > 0 ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-slate-50 border-slate-200'}`}>
              <div className="text-[10px] uppercase font-semibold text-slate-500">Missing in Cloud</div>
              <div className="text-sm font-bold">{consistencyReport.summary.catalogue_missing_cloud}</div>
            </div>
            <div className={`p-2 rounded-lg border ${consistencyReport.summary.users_missing_online_login > 0 ? 'bg-blue-50 border-blue-200 text-blue-900' : 'bg-slate-50 border-slate-200'}`}>
              <div className="text-[10px] uppercase font-semibold text-slate-500">No Online Login</div>
              <div className="text-sm font-bold">{consistencyReport.summary.users_missing_online_login}</div>
            </div>
            <div className={`p-2 rounded-lg border ${consistencyReport.summary.sequence_gaps > 0 ? 'bg-rose-50 border-rose-200 text-rose-900' : 'bg-slate-50 border-slate-200'}`}>
              <div className="text-[10px] uppercase font-semibold text-slate-500">Sequence Gaps</div>
              <div className="text-sm font-bold">{consistencyReport.summary.sequence_gaps}</div>
            </div>
          </div>

          {/* Stock Discrepancies Table */}
          {consistencyReport.stock_issues?.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-bold text-slate-800 flex items-center justify-between">
                <span>Stock Discrepancies ({consistencyReport.stock_issues.length})</span>
                <span className="text-[11px] text-slate-500 font-normal">Re-publishing baseline authoritatively updates cloud with local stock snapshot</span>
              </div>
              <Table
                cols={['Medicine', 'Barcode / SKU', 'Local Stock', 'Cloud Stock', 'Discrepancy', 'Status', 'Action']}
                empty="No stock discrepancies."
                rows={consistencyReport.stock_issues.map((s: any) => [
                  <b>{s.name}</b>,
                  <span className="font-mono text-slate-500">{s.barcode || s.sku || '—'}</span>,
                  <span className="font-bold text-emerald-800">{s.local_stock}</span>,
                  <span className={`font-bold ${s.cloud_stock < 0 ? 'text-rose-700' : 'text-slate-700'}`}>{s.cloud_stock ?? 'None'}</span>,
                  <span className="font-mono text-xs">{s.difference > 0 ? `+${s.difference}` : s.difference}</span>,
                  s.negative_cloud ? (
                    <span className="px-1.5 py-0.5 rounded bg-rose-100 text-rose-800 text-[10px] font-bold">NEGATIVE CLOUD STOCK</span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold">MISMATCH</span>
                  ),
                  <button
                    className="px-2 py-1 rounded bg-teal-50 hover:bg-teal-100 text-teal-800 border border-teal-300 text-xs font-semibold cursor-pointer"
                    disabled={busy}
                    onClick={() => repairBaseline(s.medicine_id, s.name)}
                  >
                    Reconcile Baseline
                  </button>,
                ])}
              />
            </div>
          )}

          {/* Catalogue Discrepancies */}
          {consistencyReport.catalogue_issues?.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-bold text-slate-800">Catalogue Parity Issues ({consistencyReport.catalogue_issues.length})</div>
              <Table
                cols={['Medicine', 'Issue Type', 'Details', 'Action']}
                empty="No catalogue issues."
                rows={consistencyReport.catalogue_issues.map((c: any) => [
                  <b>{c.name}</b>,
                  <Reason v={c.type} />,
                  <span className="text-slate-600 text-[11px]">{typeof c.details === 'string' ? c.details : JSON.stringify(c.details)}</span>,
                  <button
                    className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-semibold cursor-pointer"
                    disabled={busy}
                    onClick={() => repairCatalogue(c.medicine_id, c.name)}
                  >
                    Re-publish Catalogue
                  </button>,
                ])}
              />
            </div>
          )}

          {/* User Parity Issues */}
          {consistencyReport.user_issues?.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-bold text-slate-800 flex items-center justify-between">
                <span>User Accounts &amp; Credential Sync ({consistencyReport.user_issues.length})</span>
                <button
                  className={btn}
                  disabled={busy}
                  onClick={repairCredentials}
                >
                  <Send className="w-3 h-3 text-teal-700" />
                  <span>Publish All Pending Credentials</span>
                </button>
              </div>
              <Table
                cols={['Staff Name', 'Email Identifier', 'Issue', 'Action']}
                empty="All staff accounts synced."
                rows={consistencyReport.user_issues.map((u: any) => [
                  <b>{u.name}</b>,
                  <span className="font-mono text-slate-600">{u.email}</span>,
                  <Reason v={u.type} />,
                  <button
                    className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-semibold cursor-pointer"
                    disabled={busy}
                    onClick={() => repairUserProfile(u.user_id, u.name)}
                  >
                    Re-publish Profile
                  </button>,
                ])}
              />
            </div>
          )}
        </div>
      )}

      {online && data && (
        <>
          <Table cols={['Shop', 'Online', 'Heartbeat', 'Last sync', 'Shop seq', 'Cloud seq', 'Gap', 'Outbox pending / failed', 'Commands pending / delivered / rejected 7d', 'Version', 'Device', 'Last backup']}
            empty="No shop."
            rows={data.shops.map((s: any) => [
              <b>{s.shop_code}</b>, s.online ? <span className="text-emerald-700 font-bold">ONLINE</span> : <span className="text-rose-700 font-bold">OFFLINE</span>,
              when(s.last_heartbeat_at), when(s.last_sync_at), s.shop_last_seq ?? '—', s.cloud_last_seq ?? '—', s.sequence_gap ?? '—',
              `${s.outbox_pending ?? '—'} / ${s.outbox_failed ?? '—'}`, `${s.commands_pending} / ${s.commands_delivered} / ${s.commands_rejected_7d}`,
              <span className="font-mono">{String(s.installed_commit || '').slice(0, 7) || '—'}{s.update_status === 'UPDATE_AVAILABLE' ? ` → ${String(s.available_commit || '').slice(0, 7)}` : ''}</span>,
              <span className="font-mono text-[10px]">{s.device_id || '—'}</span>,
              s.last_backup_at ? `${when(s.last_backup_at)}${s.backup_verified ? ' ✓' : ''}` : '—',
            ])} />
          <div className="flex gap-2 items-center">
            <button className={btn} disabled={busy} onClick={() => window.confirm('Ask the selected shop to re-send its FAILED sync events (same idempotency keys)?') && void run(() => queueRemoteCommand('sync-retry-failed', { reason: 'Retry from the Sync Center' }), 'Queued for the shop')}>
              <RotateCcw className="w-3.5 h-3.5" /> Re-send failed events (selected shop)
            </button>
          </div>
          <div className="text-sm font-bold text-slate-800">Rejected remote commands (selected shop)</div>
          <Table cols={['When', 'Command', 'Record', 'Conflict', 'Reason', '']} empty="No rejected command."
            rows={(issues?.commands || []).map((c: any) => [
              when(c.acked_at || c.created_at), c.command_type, c.entity ? `${c.entity.entity} ${String(c.entity.entity_id).slice(0, 8)}` : '—', <Reason v={c.conflict} />,
              <span className="text-slate-700">{c.error || c.status}</span>,
              c.already_retried ? <span className="text-[10px] text-slate-500">retried</span>
                : <button className={btn} disabled={busy} onClick={() => window.confirm(`Retry ${c.command_type}? It is re-checked against the shop's current data.`) && void run(() => apiFetch(`/api/admin/commands/${c.command_id}/retry`, { body: {} }), 'Retry queued')}><RotateCcw className="w-3.5 h-3.5" /> Retry</button>,
            ])} />
          <div className="text-sm font-bold text-slate-800">Events rejected by the cloud (selected shop)</div>
          <Table cols={['When', 'Event', 'Conflict', 'Reason']} empty="No rejected event."
            rows={(issues?.rejected_events || []).map((e: any) => [when(e.rejected_at), e.event_type, <Reason v={e.conflict} />, e.error])} />
        </>
      )}

      {!online && data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
            {[['Mode', data.status?.mode], ['Cloud', data.status?.cloud?.reachable === false ? 'UNREACHABLE' : data.status?.cloud?.reachable ? 'CONNECTED' : '—'],
              ['Last seq', data.sequence?.last_seq ?? '—'], ['Last synced seq', data.sequence?.last_synced_seq ?? '—'],
              ['Pending', data.status?.counts?.pending ?? '—'], ['Failed', data.status?.counts?.failed ?? '—']].map(([k, v]) => (
              <div key={String(k)} className="bg-white border border-slate-200 rounded-lg p-2"><div className="text-[10px] uppercase text-slate-500 font-semibold">{k}</div><div className="text-sm font-bold">{String(v)}</div></div>
            ))}
          </div>
          <div className="text-[11px] text-slate-500">Last successful sync {when(data.status?.last_sync)}{data.status?.last_error ? ` · last error: ${data.status.last_error}` : ''}</div>
          <div className="flex items-center justify-between">
            <div className="text-sm font-bold text-slate-800">Failed / retrying events</div>
            <button className={btn} disabled={busy || !data.failed_events.some((e: any) => e.status === 'FAILED')} onClick={() => void run(() => apiFetch('/api/sync/retry-failed', { body: {} }), 'Failed events re-queued')}><RotateCcw className="w-3.5 h-3.5" /> Retry all failed</button>
          </div>
          <Table cols={['Seq', 'Event', 'Reference', 'Status', 'Attempts', 'Conflict', 'Last error', '']} empty="Nothing waiting: the outbox is clean."
            rows={data.failed_events.map((e: any) => [e.seq, e.event_type, e.business_ref || e.entity_id, e.status, e.attempt_count, <Reason v={e.conflict} />, <span className="text-slate-700">{e.last_error}</span>,
              e.status === 'FAILED' ? <button className={btn} disabled={busy} onClick={() => void run(() => apiFetch(`/api/sync/events/${e.id}/retry`, { body: {} }), 'Event re-queued')}><RotateCcw className="w-3.5 h-3.5" /> Retry</button> : null])} />
          <div className="text-sm font-bold text-slate-800">Recent remote commands</div>
          <Table cols={['Received', 'Command', 'Status', 'Conflict', 'Reason / error']} empty="No remote command received."
            rows={data.commands.map((c: any) => [when(c.received_at), c.command_type, c.status, <Reason v={c.conflict} />, c.error || '—'])} />
        </>
      )}
    </div>
  );
};
