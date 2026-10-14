import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, RotateCcw, Send, Waypoints } from 'lucide-react';
import { apiFetch } from '../../services/http';
import { queueRemoteCommand } from '../../services/remoteAdmin';

/**
 * SYNC & CONFLICT CONTROL CENTER (Administrator).
 *   shop computer: this shop's outbox (sequence, failed events with the cloud's reason), recent remote
 *                  commands with a plain conflict reason; retry one / all failed events, sync now
 *   online app   : every authorized shop (contact, heartbeat, shop vs cloud sequence, outbox, commands,
 *                  version, device, last backup) + the selected shop's rejected commands / events;
 *                  retry a rejected command (ONE new linked command), ask the shop to re-send failed events
 * Retries never duplicate: events keep their idempotency keys; a rejected command changed nothing.
 */
const when = (v?: string | null) => (v ? new Date(v).toLocaleString() : '—');
const btn = 'px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold flex items-center gap-1 disabled:opacity-50';
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

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-bold text-slate-900 flex items-center gap-1.5"><Waypoints className="w-4 h-4 text-teal-700" /> Sync &amp; Conflict Center</h1>
          <p className="text-[11px] text-slate-500">Retries never duplicate: events keep their idempotency keys; a rejected command changed nothing and is re-sent once as a new linked command.</p>
        </div>
        <div className="flex gap-2">
          {!online && <button className={btn} disabled={busy} onClick={() => void run(() => apiFetch('/api/sync/now', { body: {} }), 'Sync started')}><Send className="w-3.5 h-3.5" /> Sync now</button>}
          <button className={btn} disabled={busy} onClick={() => void load()}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh</button>
        </div>
      </div>
      {msg && <div className={`text-xs rounded p-2 border ${msg.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>{msg.text}</div>}

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
