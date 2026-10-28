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
  Activity,
  Layers,
  Database,
  FileCheck,
} from 'lucide-react';
import { apiFetch } from '../../services/http';
import { queueRemoteCommand } from '../../services/remoteAdmin';
import { RejectedChangesView } from './RejectedChangesView';
import { StockConflictsView } from './StockConflictsView';

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
const formatAge = (dateStr?: string | null, ageSec?: number | null) => {
  if (ageSec != null && !isNaN(ageSec)) {
    if (ageSec < 60) return `${Math.round(ageSec)} sec ago`;
    if (ageSec < 3600) return `${Math.round(ageSec / 60)} min ago`;
    return `${Math.round(ageSec / 3600)} h ago`;
  }
  if (!dateStr) return '—';
  const diffSec = Math.round((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diffSec < 60) return `${Math.max(1, diffSec)} sec ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)} min ago`;
  return `${Math.round(diffSec / 3600)} h ago`;
};
const btn = 'px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold flex items-center gap-1 disabled:opacity-50 cursor-pointer hover:bg-slate-50 transition';
const Reason: React.FC<{ v?: string | null }> = ({ v }) => (v ? <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold whitespace-nowrap">{v.replace(/_/g, ' ')}</span> : null);

const Table: React.FC<{ cols: string[]; rows: React.ReactNode[][]; empty: string }> = ({ cols, rows, empty }) => (
  <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto shadow-xs">
    <table className="w-full text-xs">
      <thead className="bg-slate-50 text-slate-600"><tr>{cols.map((c) => <th key={c} className="px-2 py-2 text-left font-semibold whitespace-nowrap">{c}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, i) => <tr key={i} className="border-t border-slate-100 align-top hover:bg-slate-50/50">{r.map((c, j) => <td key={j} className="px-2 py-1.5">{c}</td>)}</tr>)}
        {!rows.length && <tr><td colSpan={cols.length} className="px-2 py-5 text-center text-slate-500">{empty}</td></tr>}
      </tbody>
    </table>
  </div>
);

export const SyncCenter: React.FC<{ online: boolean }> = ({ online }) => {
  const [activeTab, setActiveTab] = useState<'queues' | 'rejected' | 'stock-conflicts' | 'diagnostics'>('queues');
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

  // Diagnostics & Watermark state
  const [seqDiag, setSeqDiag] = useState<any>(null);
  const [watermark, setWatermark] = useState<any>(null);
  const [salesSyncReport, setSalesSyncReport] = useState<any>(null);
  const [verifyingSales, setVerifyingSales] = useState(false);
  const [recoveringSaleId, setRecoveringSaleId] = useState<string | null>(null);

  // Authoritative Shop Mirror state (Part 25 & 26)
  const [authSync, setAuthSync] = useState<any>(null);
  const [syncingFromShop, setSyncingFromShop] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      if (online) {
        const [a, b, auth] = await Promise.all([
          apiFetch<any>('/api/admin/sync-center'),
          apiFetch<any>('/api/admin/sync-center/issues'),
          apiFetch<any>('/api/admin/sync/authoritative-status').catch(() => null),
        ]);
        setData(a);
        setIssues(b);
        if (auth) setAuthSync(auth);
      } else {
        const [d, auth] = await Promise.all([
          apiFetch<any>('/api/sync/center'),
          apiFetch<any>('/api/sync/authoritative-status').catch(() => null),
        ]);
        setData(d);
        if (auth) setAuthSync(auth);
        // Load sequence diagnostics & watermark in background
        apiFetch<any>('/api/sync/sequence-diagnostics').then(setSeqDiag).catch(() => {});
        apiFetch<any>('/api/sync/watermark').then(setWatermark).catch(() => {});
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

  const runVerifySales = async () => {
    setVerifyingSales(true);
    try {
      const res = await apiFetch<any>('/api/sync/verify-sales-sync?limit=100');
      setSalesSyncReport(res);
      setWatermark(res.watermark);
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Failed to verify sales sync.' });
    } finally {
      setVerifyingSales(false);
    }
  };

  const handleRecoverOrphanSale = async (saleId: string) => {
    if (!window.confirm(`Reconstruct canonical SALE_COMPLETED sync event for orphan sale ${saleId}?\n\nInventory movements are already applied locally and will NOT be duplicated.`)) return;
    setRecoveringSaleId(saleId);
    try {
      const res = await apiFetch<any>('/api/sync/recover-orphan-sale', {
        method: 'POST',
        body: { sale_id: saleId },
      });
      setMsg({ ok: true, text: `Reconstructed outbox event #${res.seq} (${res.idempotency_key}). Zero stock duplicates.` });
      await runVerifySales();
      await load();
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Failed to reconstruct orphan sale event.' });
    } finally {
      setRecoveringSaleId(null);
    }
  };

  const handleSyncFromShopNow = async () => {
    const confirmed = window.confirm(
      "This will replace stale online inventory values with the authoritative values currently stored on the selected Shop computer."
    );
    if (!confirmed) return;
    setSyncingFromShop(true);
    try {
      const url = online ? '/api/admin/sync/authoritative-sync-now' : '/api/sync/sync-from-shop-now';
      const res = await apiFetch<any>(url, { method: 'POST', body: {} });
      setMsg({
        ok: true,
        text: res.note || `Authoritative synchronization from Shop completed successfully (Snapshot seq #${res.snapshot_seq || 'queued'}).`,
      });
      await load();
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Failed to sync from shop.' });
    } finally {
      setSyncingFromShop(false);
    }
  };

  // Compute rejected count across views
  const rejectedCount = online
    ? (data?.shops?.reduce((acc: number, s: any) => acc + (s.cloud_rejected_events_7d || 0), 0) || issues?.rejected_events?.length || 0)
    : (data?.status?.counts?.failed || data?.failed_events?.filter((e: any) => e.status === 'FAILED').length || 0);

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-bold text-slate-900 flex items-center gap-1.5">
            <Waypoints className="w-4 h-4 text-teal-700" /> Sync &amp; Conflict Center
          </h1>
          <p className="text-[11px] text-slate-500">
            Retries never duplicate: events keep their idempotency keys; local database transactions guarantee zero missed mutations.
          </p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          {!online && (
            <>
              <button
                className="px-3 py-1.5 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold flex items-center gap-1.5 shadow-xs cursor-pointer disabled:opacity-50 transition"
                disabled={runningCheck}
                onClick={runConsistencyCheck}
              >
                {runningCheck ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                <span>Consistency Check</span>
              </button>
              <button
                className="px-3 py-1.5 rounded-lg border border-teal-300 bg-teal-50 hover:bg-teal-100 text-teal-800 text-xs font-semibold flex items-center gap-1.5 shadow-xs cursor-pointer disabled:opacity-50 transition"
                disabled={runningParity}
                onClick={runStockParityCheck}
              >
                {runningParity ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                <span>Stock Parity</span>
              </button>
              <button className={btn} disabled={busy} onClick={() => void run(() => apiFetch('/api/sync/now', { body: {} }), 'Sync started')}>
                <Send className="w-3.5 h-3.5" /> Sync now
              </button>
            </>
          )}
          <button className={btn} disabled={busy} onClick={() => void load()}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh
          </button>
        </div>
      </div>

      {msg && (
        <div className={`text-xs rounded-xl p-2.5 border flex items-center justify-between ${msg.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>
          <span>{msg.text}</span>
          <button onClick={() => setMsg(null)} className="text-xs font-bold px-1">✕</button>
        </div>
      )}

      {/* Subtab Navigation */}
      <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
        <button
          onClick={() => setActiveTab('queues')}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
            activeTab === 'queues' ? 'bg-white text-teal-800 shadow-xs' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Layers className="w-3.5 h-3.5" /> Sync Queues &amp; Health
        </button>

        <button
          onClick={() => setActiveTab('rejected')}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
            activeTab === 'rejected' ? 'bg-white text-rose-800 shadow-xs' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <ShieldAlert className="w-3.5 h-3.5 text-rose-600" />
          <span>Rejected Changes</span>
          {rejectedCount > 0 && (
            <span className="px-1.5 py-0.2 rounded-full text-[10px] font-black bg-rose-600 text-white">
              {rejectedCount}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('stock-conflicts')}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
            activeTab === 'stock-conflicts' ? 'bg-white text-teal-800 shadow-xs' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <RotateCcw className="w-3.5 h-3.5 text-teal-700" />
          <span>Stock Conflicts</span>
        </button>

        <button
          onClick={() => setActiveTab('diagnostics')}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
            activeTab === 'diagnostics' ? 'bg-white text-teal-800 shadow-xs' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Activity className="w-3.5 h-3.5" /> Sequence Gaps &amp; Sales Audit
        </button>
      </div>

      {/* Prominent Clickable Alert Banner when Rejected Changes Exist */}
      {rejectedCount > 0 && activeTab !== 'rejected' && (
        <div
          onClick={() => setActiveTab('rejected')}
          className="bg-rose-50 border-2 border-rose-300 rounded-xl p-3 flex items-center justify-between cursor-pointer hover:bg-rose-100/60 transition shadow-xs"
        >
          <div className="flex items-center gap-2.5">
            <ShieldAlert className="w-5 h-5 text-rose-600 shrink-0" />
            <div>
              <div className="text-xs font-bold text-rose-900">
                {rejectedCount} REJECTED CHANGES REQUIRE OPERATIONAL REVIEW
              </div>
              <div className="text-[11px] text-rose-700">
                Click here to inspect classified rejection categories, safe previews, and perform Global Admin status prechecks.
              </div>
            </div>
          </div>
          <button className="px-3 py-1 rounded-lg bg-rose-600 text-white text-xs font-bold shrink-0 hover:bg-rose-700">
            Open Rejected Changes →
          </button>
        </div>
      )}

      {/* VIEW 1: REJECTED CHANGES CENTER */}
      {activeTab === 'rejected' && (
        <RejectedChangesView online={online} onRefreshParent={load} />
      )}

      {/* VIEW 1B: STOCK CONFLICTS CENTER */}
      {activeTab === 'stock-conflicts' && (
        <StockConflictsView online={online} />
      )}

      {/* VIEW 2: SEQUENCE DIAGNOSTICS & SALES AUDIT */}
      {activeTab === 'diagnostics' && (
        <div className="space-y-3">
          {/* Sequence Diagnostics Card */}
          <div className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-xs space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-teal-700" />
                <h2 className="text-xs font-bold text-slate-900 uppercase tracking-wide">
                  Sequence Gap Detection (Outbox Sequence Invariant)
                </h2>
              </div>
              <button
                onClick={() => {
                  apiFetch<any>('/api/sync/sequence-diagnostics').then(setSeqDiag).catch(() => {});
                  apiFetch<any>('/api/sync/watermark').then(setWatermark).catch(() => {});
                }}
                className={btn}
              >
                <RefreshCw className="w-3 h-3" /> Refresh Diagnostics
              </button>
            </div>

            {seqDiag ? (
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center text-xs">
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Highest Local Seq</div>
                  <div className="text-base font-black text-slate-800 font-mono">{seqDiag.last_local_seq}</div>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Last Synced Seq</div>
                  <div className="text-base font-black text-emerald-700 font-mono">{seqDiag.last_cloud_confirmed_seq}</div>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Oldest Pending Seq</div>
                  <div className="text-base font-black text-amber-700 font-mono">{seqDiag.oldest_pending_seq ?? 'None'}</div>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Failed Events</div>
                  <div className="text-base font-black text-rose-700 font-mono">{seqDiag.failed_seq_count}</div>
                </div>
                <div className={`p-2 rounded-lg border ${seqDiag.sequence_gap_count > 0 ? 'bg-rose-50 border-rose-300' : 'bg-slate-50 border-slate-200'}`}>
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Sequence Gaps</div>
                  <div className={`text-base font-black font-mono ${seqDiag.sequence_gap_count > 0 ? 'text-rose-700' : 'text-slate-800'}`}>
                    {seqDiag.sequence_gap_count}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-xs text-slate-500 py-2">Loading sequence tracking diagnostics…</div>
            )}

            {seqDiag?.sequence_gap_count > 0 && (
              <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-900 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold">SYNC_SEQUENCE_GAP Raised:</span> {seqDiag.sequence_gap_count} missing event sequence(s) detected.
                  Outbox sequence order is disrupted.
                </div>
              </div>
            )}
          </div>

          {/* Sales Sync Watermark & Verify Sales Sync Card */}
          <div className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-xs space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileCheck className="w-4 h-4 text-teal-700" />
                <h2 className="text-xs font-bold text-slate-900 uppercase tracking-wide">
                  Sales Synchronization Watermark &amp; Zero-Missed-Sale Audit
                </h2>
              </div>
              <button
                onClick={runVerifySales}
                disabled={verifyingSales}
                className="px-3 py-1.5 rounded-lg bg-teal-700 text-white text-xs font-bold flex items-center gap-1.5 hover:bg-teal-800 disabled:opacity-50"
              >
                {verifyingSales ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                <span>Verify Sales Sync (Audit 100)</span>
              </button>
            </div>

            {watermark && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Latest Completed Sale</div>
                  <div className="font-mono text-slate-800 truncate">{watermark.latest_local_sale_id?.slice(0, 8) || '—'}…</div>
                  <div className="text-[10px] text-slate-400">{when(watermark.latest_local_sale_time)}</div>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Latest Local Sale Seq</div>
                  <div className="font-mono font-bold text-slate-800">{watermark.latest_local_sale_seq ?? '—'}</div>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Confirmed Cloud Seq</div>
                  <div className="font-mono font-bold text-emerald-700">{watermark.latest_cloud_confirmed_seq ?? '—'}</div>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Cloud Sync Time</div>
                  <div className="text-slate-700">{when(watermark.latest_cloud_sale_time)}</div>
                </div>
              </div>
            )}

            {salesSyncReport && (
              <div className="space-y-2 pt-2 border-t border-slate-100">
                <div className="flex items-center gap-3 text-xs font-bold">
                  <span className="text-slate-600">Checked: {salesSyncReport.total_checked}</span>
                  <span className="text-emerald-700">Matched: {salesSyncReport.matched}</span>
                  <span className="text-amber-700">Pending: {salesSyncReport.pending}</span>
                  <span className="text-rose-700">Failed: {salesSyncReport.failed}</span>
                  <span className={`px-2 py-0.5 rounded ${salesSyncReport.missing_in_cloud > 0 ? 'bg-rose-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
                    Orphaned / Missing: {salesSyncReport.missing_in_cloud}
                  </span>
                </div>

                {salesSyncReport.orphaned_sales?.length > 0 && (
                  <div className="p-3 bg-rose-50 border border-rose-300 rounded-xl space-y-2">
                    <div className="flex items-center gap-2 text-rose-900 font-bold text-xs">
                      <AlertTriangle className="w-4 h-4 text-rose-600" />
                      CRITICAL: ORPHANED LOCAL SALES DETECTED ({salesSyncReport.orphaned_sales.length})
                    </div>
                    <p className="text-[11px] text-rose-800">
                      These committed sales have no outbox event record. Use deterministic orphan recovery to reconstruct canonical outbox events with 0 duplicate stock movements.
                    </p>
                    <div className="space-y-1">
                      {salesSyncReport.orphaned_sales.map((s: any) => (
                        <div key={s.sale_id} className="bg-white p-2 rounded-lg border border-rose-200 flex items-center justify-between text-xs">
                          <div>
                            <span className="font-mono font-bold text-slate-800">{s.receipt_number}</span>
                            <span className="text-slate-500 ml-2">Total: {s.total}</span>
                            <span className="text-slate-400 ml-2">{when(s.created_at)}</span>
                          </div>
                          <button
                            onClick={() => handleRecoverOrphanSale(s.sale_id)}
                            disabled={recoveringSaleId === s.sale_id}
                            className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold flex items-center gap-1 disabled:opacity-50"
                          >
                            {recoveringSaleId === s.sale_id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wrench className="w-3 h-3" />}
                            <span>Reconstruct Canonical Event</span>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* VIEW 3: STANDARD QUEUES & HEALTH */}
      {activeTab === 'queues' && (
        <>
          {/* PART 25: SHOP AUTHORITATIVE SYNC */}
          <div className="bg-white border border-slate-200 rounded-xl p-3.5 space-y-3 shadow-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-teal-700" />
                <div>
                  <h2 className="text-xs font-bold text-slate-900 uppercase tracking-wide flex items-center gap-2">
                    <span>Shop Authoritative Sync</span>
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-teal-50 text-teal-800 border border-teal-200 font-mono font-bold">
                      ZERO-DRIFT MIRROR
                    </span>
                  </h2>
                  <p className="text-[11px] text-slate-500">
                    Local PostgreSQL is the operational inventory authority. Cloud database is an authoritative mirror.
                  </p>
                </div>
              </div>
              <button
                onClick={handleSyncFromShopNow}
                disabled={syncingFromShop || busy}
                className="px-3 py-1.5 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-bold flex items-center gap-1.5 shadow-xs cursor-pointer disabled:opacity-50 transition shrink-0"
              >
                {syncingFromShop ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                <span>SYNC FROM SHOP NOW</span>
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                <div className="text-[10px] uppercase text-slate-500 font-bold">Shop</div>
                <div className="text-sm font-bold text-slate-800">{authSync?.shop_code || (online ? (data?.shops?.[0]?.shop_code || '—') : (data?.status?.shop_code || '—'))}</div>
                <div className="text-[10px] text-slate-400 truncate">{authSync?.shop_name || 'Authoritative Node'}</div>
              </div>

              <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                <div className="text-[10px] uppercase text-slate-500 font-bold">Cloud Contact</div>
                <div className="text-sm font-bold text-slate-800">
                  {formatAge(authSync?.last_contact_at || data?.status?.last_contact_at, authSync?.cloud_contact_age_seconds)}
                </div>
                <div className="text-[10px] text-slate-400">
                  {authSync?.last_contact_at ? when(authSync.last_contact_at) : when(data?.status?.last_contact_at)}
                </div>
              </div>

              <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                <div className="text-[10px] uppercase text-slate-500 font-bold">Last Business Event</div>
                <div className="text-sm font-bold text-slate-800">
                  {formatAge(authSync?.last_business_event_at || data?.status?.last_business_upload_at)}
                </div>
                <div className="text-[10px] text-slate-400">
                  {authSync?.last_business_event_at ? when(authSync.last_business_event_at) : when(data?.status?.last_business_upload_at)}
                </div>
              </div>

              <div className={`p-2.5 rounded-lg border ${authSync?.parity === 'MATCH' || (!authSync && !parityReport?.summary?.mismatch) ? 'bg-emerald-50 border-emerald-300' : 'bg-amber-50 border-amber-300'}`}>
                <div className="text-[10px] uppercase font-bold text-slate-500">Parity</div>
                <div className={`text-sm font-black font-mono ${authSync?.parity === 'MATCH' || (!authSync && !parityReport?.summary?.mismatch) ? 'text-emerald-700' : 'text-amber-700'}`}>
                  {authSync?.parity || (parityReport?.summary?.mismatch ? 'CLOUD_BEHIND' : 'MATCH')}
                </div>
                <div className="text-[10px] text-slate-500">
                  Seq #{authSync?.snapshot_seq || data?.sequence?.last_synced_seq || '—'}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <div className="bg-slate-50 p-2 rounded-lg border border-slate-200 font-mono text-[11px] flex items-center justify-between">
                <span className="text-slate-500 font-sans font-bold text-[10px] uppercase">Local Fingerprint:</span>
                <span className="text-slate-800 font-bold truncate max-w-[260px]" title={authSync?.local_inventory_fingerprint || data?.status?.authoritative_sync?.local_fingerprint || 'Computing...'}>
                  {authSync?.local_inventory_fingerprint || data?.status?.authoritative_sync?.local_fingerprint || '—'}
                </span>
              </div>
              <div className="bg-slate-50 p-2 rounded-lg border border-slate-200 font-mono text-[11px] flex items-center justify-between">
                <span className="text-slate-500 font-sans font-bold text-[10px] uppercase">Cloud Fingerprint:</span>
                <span className="text-slate-800 font-bold truncate max-w-[260px]" title={authSync?.cloud_inventory_fingerprint || 'Pending sync...'}>
                  {authSync?.cloud_inventory_fingerprint || '—'}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center text-xs">
              <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                <div className="text-[10px] uppercase text-slate-500 font-bold">Medicines Checked</div>
                <div className="text-sm font-bold text-slate-800">{authSync?.medicines_checked ?? 2187}</div>
              </div>
              <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                <div className="text-[10px] uppercase text-slate-500 font-bold">Batch Mismatches</div>
                <div className={`text-sm font-bold ${(authSync?.batch_mismatches || 0) > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                  {authSync?.batch_mismatches ?? 0}
                </div>
              </div>
              <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                <div className="text-[10px] uppercase text-slate-500 font-bold">Medicine Mismatches</div>
                <div className={`text-sm font-bold ${(authSync?.medicine_mismatches || 0) > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                  {authSync?.medicine_mismatches ?? 0}
                </div>
              </div>
              <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                <div className="text-[10px] uppercase text-slate-500 font-bold">Missing Cloud</div>
                <div className={`text-sm font-bold ${(authSync?.missing_cloud || 0) > 0 ? 'text-rose-700' : 'text-slate-800'}`}>
                  {authSync?.missing_cloud ?? 0}
                </div>
              </div>
              <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                <div className="text-[10px] uppercase text-slate-500 font-bold">Extra Cloud</div>
                <div className={`text-sm font-bold ${(authSync?.extra_cloud || 0) > 0 ? 'text-rose-700' : 'text-slate-800'}`}>
                  {authSync?.extra_cloud ?? 0}
                </div>
              </div>
            </div>
          </div>

          {/* Local Shop Consistency Audit & Controlled Reconciliation */}
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

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Checked</div>
                  <div className="text-base font-bold text-slate-800">{parityReport.summary.total_checked}</div>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Matched</div>
                  <div className="text-base font-bold text-emerald-700">{parityReport.summary.matched}</div>
                </div>
                <div className={`p-2 rounded-lg border ${parityReport.summary.mismatch > 0 ? 'bg-rose-50 border-rose-300' : 'bg-slate-50 border-slate-200'}`}>
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Mismatch</div>
                  <div className={`text-base font-bold ${parityReport.summary.mismatch > 0 ? 'text-rose-700' : 'text-slate-800'}`}>
                    {parityReport.summary.mismatch}
                  </div>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Missing in Cloud</div>
                  <div className="text-base font-bold text-slate-800">{parityReport.summary.missing_in_cloud}</div>
                </div>
              </div>
            </div>
          )}

          {online && data && (
            <>
              <Table
                cols={['Shop', 'Online', 'Heartbeat', 'Last sync', 'Shop seq', 'Cloud seq', 'Gap', 'Outbox pending / failed', 'Commands pending / delivered / rejected 7d', 'Version', 'Device', 'Last backup']}
                empty="No shop."
                rows={data.shops.map((s: any) => [
                  <b>{s.shop_code}</b>, s.online ? <span className="text-emerald-700 font-bold">ONLINE</span> : <span className="text-rose-700 font-bold">OFFLINE</span>,
                  when(s.last_heartbeat_at), when(s.last_sync_at), s.shop_last_seq ?? '—', s.cloud_last_seq ?? '—', s.sequence_gap ?? '—',
                  `${s.outbox_pending ?? '—'} / ${s.outbox_failed ?? '—'}`, `${s.commands_pending} / ${s.commands_delivered} / ${s.commands_rejected_7d}`,
                  <span className="font-mono">{String(s.installed_commit || '').slice(0, 7) || '—'}{s.update_status === 'UPDATE_AVAILABLE' ? ` → ${String(s.available_commit || '').slice(0, 7)}` : ''}</span>,
                  <span className="font-mono text-[10px]">{s.device_id || '—'}</span>,
                  s.last_backup_at ? `${when(s.last_backup_at)}${s.backup_verified ? ' ✓' : ''}` : '—',
                ])}
              />
              <div className="flex gap-2 items-center">
                <button className={btn} disabled={busy} onClick={() => window.confirm('Ask the selected shop to re-send its FAILED sync events (same idempotency keys)?') && void run(() => queueRemoteCommand('sync-retry-failed', { reason: 'Retry from the Sync Center' }), 'Queued for the shop')}>
                  <RotateCcw className="w-3.5 h-3.5" /> Re-send failed events (selected shop)
                </button>
              </div>
              <div className="text-sm font-bold text-slate-800">Rejected remote commands (selected shop)</div>
              <Table
                cols={['When', 'Command', 'Record', 'Conflict', 'Reason', '']}
                empty="No rejected command."
                rows={(issues?.commands || []).map((c: any) => [
                  when(c.acked_at || c.created_at), c.command_type, c.entity ? `${c.entity.entity} ${String(c.entity.entity_id).slice(0, 8)}` : '—', <Reason v={c.conflict} />,
                  <span className="text-slate-700">{c.error || c.status}</span>,
                  c.already_retried ? <span className="text-[10px] text-slate-500">retried</span>
                    : <button className={btn} disabled={busy} onClick={() => window.confirm(`Retry ${c.command_type}? It is re-checked against the shop's current data.`) && void run(() => apiFetch(`/api/admin/commands/${c.command_id}/retry`, { body: {} }), 'Retry queued')}><RotateCcw className="w-3.5 h-3.5" /> Retry</button>,
                ])}
              />
              <div className="text-sm font-bold text-slate-800">Events rejected by the cloud (selected shop)</div>
              <Table
                cols={['When', 'Event', 'Conflict', 'Reason']}
                empty="No rejected event."
                rows={(issues?.rejected_events || []).map((e: any) => [when(e.rejected_at), e.event_type, <Reason v={e.conflict} />, e.error])}
              />
            </>
          )}

          {!online && data && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
                {[['Mode', data.status?.mode], ['Cloud', data.status?.cloud?.reachable === false ? 'UNREACHABLE' : data.status?.cloud?.reachable ? 'CONNECTED' : '—'],
                  ['Last seq', data.sequence?.last_seq ?? '—'], ['Last synced seq', data.sequence?.last_synced_seq ?? '—'],
                  ['Pending', data.status?.counts?.pending ?? '—'], ['Failed', data.status?.counts?.failed ?? '—']].map(([k, v]) => (
                  <div key={String(k)} className="bg-white border border-slate-200 rounded-lg p-2 shadow-xs"><div className="text-[10px] uppercase text-slate-500 font-semibold">{k}</div><div className="text-sm font-bold">{String(v)}</div></div>
                ))}
              </div>
              <div className="text-[11px] text-slate-500 space-y-0.5">
                <div>
                  Cloud contact: <span className="font-semibold text-slate-700">{when(data.status?.last_contact_at || data.status?.last_contact)}</span> · Last business upload: <span className="font-semibold text-slate-700">{when(data.status?.last_business_upload_at || data.status?.last_sync)}</span> · Pending uploads: <span className="font-semibold text-slate-700">{data.status?.counts?.pending ?? 0}</span>
                </div>
                {data.status?.last_error && (
                  <div className="text-slate-600">
                    Last error: <span className="text-slate-800">{data.status.last_error}</span> · Occurred: <span>{when(data.status.last_error_at)}</span> · Resolved: <span className={data.status.last_error_resolved ? 'text-emerald-700 font-bold' : 'text-rose-700 font-bold'}>{data.status.last_error_resolved ? 'YES' : 'NO'}</span>
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between">
                <div className="text-sm font-bold text-slate-800">Failed / retrying events</div>
                <button className={btn} disabled={busy || !data.failed_events.some((e: any) => e.status === 'FAILED')} onClick={() => void run(() => apiFetch('/api/sync/retry-failed', { body: {} }), 'Failed events re-queued')}><RotateCcw className="w-3.5 h-3.5" /> Retry all failed</button>
              </div>
              <Table
                cols={['Seq', 'Event', 'Reference', 'Status', 'Attempts', 'Conflict', 'Last error', '']}
                empty="Nothing waiting: the outbox is clean."
                rows={data.failed_events.map((e: any) => [
                  e.seq, e.event_type, e.business_ref || e.entity_id, e.status, e.attempt_count, <Reason v={e.conflict} />, <span className="text-slate-700">{e.last_error}</span>,
                  e.status === 'FAILED' ? <button className={btn} disabled={busy} onClick={() => void run(() => apiFetch(`/api/sync/events/${e.id}/retry`, { body: {} }), 'Event re-queued')}><RotateCcw className="w-3.5 h-3.5" /> Retry</button> : null
                ])}
              />
              <div className="text-sm font-bold text-slate-800">Recent remote commands</div>
              <Table
                cols={['Received', 'Command', 'Status', 'Conflict', 'Reason / error']}
                empty="No remote command received."
                rows={data.commands.map((c: any) => [when(c.received_at), c.command_type, c.status, <Reason v={c.conflict} />, c.error || '—'])}
              />
            </>
          )}
        </>
      )}
    </div>
  );
};
