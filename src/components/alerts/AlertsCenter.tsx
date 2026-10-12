import React, { useCallback, useEffect, useState } from 'react';
import { BellRing, CheckCheck, Loader2, RefreshCw } from 'lucide-react';
import { apiFetch } from '../../services/http';
import { hasPermission } from '../../services/permissions';
import type { User } from '../../types';

/**
 * ALERTS CENTER — one list of operational alerts.
 *   shop computer: GET /api/alerts (local PostgreSQL, works offline) ; acknowledge: alerts.manage
 *   online app   : GET /api/admin/alerts (selected shop, cloud copy)  ; acknowledge: Administrator
 * One open alert per condition (refreshed, never duplicated); a condition that disappears is RESOLVED.
 */
const TYPE_OF: Record<string, string> = {
  NEAR_EXPIRY: 'EXPIRING_SOON', EXPIRED_STOCK: 'EXPIRED', SYNC_FAILING: 'SYNC_FAILURE', SYNC_HALTED: 'SYNC_FAILURE', OUTBOUND_REJECTED: 'SYNC_FAILURE',
  COMMANDS_REJECTED_24H: 'COMMAND_REJECTED', UPDATE_ROLLBACK: 'UPDATE_FAILED', BACKUP_DISABLED: 'BACKUP_STALE', DB_UNAVAILABLE: 'DATA_INTEGRITY_WARNING',
  SHOP_OFFLINE: 'SHOP_OFFLINE', SHIFT_NOT_CLOSED: 'SHIFT_LEFT_OPEN',
};
const typeOf = (a: any) => a.alert_type || TYPE_OF[String(a.alert_key).split(':')[0]] || String(a.alert_key).split(':')[0];
const SEV: Record<string, string> = { CRITICAL: 'bg-rose-100 text-rose-800 border-rose-200', WARNING: 'bg-amber-100 text-amber-800 border-amber-200', INFO: 'bg-sky-50 text-sky-800 border-sky-200' };
const when = (v?: string | null) => (v ? new Date(v).toLocaleString() : '—');

export const AlertsCenter: React.FC<{ currentUser: User; online: boolean }> = ({ currentUser, online }) => {
  const [rows, setRows] = useState<any[]>([]);
  const [which, setWhich] = useState<'active' | 'all'>('active');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const canAck = online ? currentUser.role === 'ADMIN' : hasPermission(currentUser, 'alerts.manage');

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const r: any = online
        ? await apiFetch(`/api/admin/alerts?status=${which === 'all' ? 'all' : 'open'}`)
        : await apiFetch(`/api/alerts?status=${which === 'all' ? 'ALL' : 'ACTIVE'}${refresh ? '&refresh=true' : ''}`);
      setRows(r.alerts || []);
      if (r.supported === false) setMsg({ ok: false, text: r.message });
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Could not load alerts.' });
    } finally {
      setLoading(false);
    }
  }, [online, which]);
  useEffect(() => { void load(); }, [load]);

  const ack = async (id: number) => {
    try {
      await apiFetch(online ? `/api/admin/alerts/${id}/ack` : `/api/alerts/${id}/ack`, { body: {} });
      setMsg({ ok: true, text: 'Alert acknowledged (it resolves by itself when the condition is gone).' });
      await load();
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Could not acknowledge.' });
    }
  };
  const open = rows.filter((a) => a.status !== 'RESOLVED');

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-bold text-slate-900 flex items-center gap-1.5"><BellRing className="w-4 h-4 text-teal-700" /> Alerts Center</h1>
          <p className="text-[11px] text-slate-500">{online ? 'Alerts of the selected shop (from its heartbeat and the cloud).' : 'This shop\'s alerts, computed locally (works without internet).'} One alert per condition; it resolves itself when the condition is gone.</p>
        </div>
        <div className="flex gap-2 items-center">
          <select className="px-2 py-1.5 border border-slate-300 rounded-lg text-xs" value={which} onChange={(e) => setWhich(e.target.value as any)}>
            <option value="active">Open + acknowledged</option><option value="all">Include resolved</option>
          </select>
          <button className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold flex items-center gap-1" onClick={() => void load(true)}>
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh
          </button>
        </div>
      </div>
      {msg && <div className={`text-xs rounded p-2 border ${msg.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>{msg.text}</div>}
      <div className="grid grid-cols-3 gap-2 max-w-md">
        {[['Open', open.filter((a) => a.status === 'OPEN' || a.status === 'ACTIVE').length], ['Acknowledged', open.filter((a) => a.status === 'ACKNOWLEDGED').length],
          ['Critical', open.filter((a) => a.severity === 'CRITICAL').length]].map(([k, v]) => (
          <div key={String(k)} className="bg-white border border-slate-200 rounded-lg p-2"><div className="text-[10px] uppercase text-slate-500 font-semibold">{k}</div><div className="text-sm font-bold">{v}</div></div>
        ))}
      </div>
      <div className="space-y-2">
        {rows.map((a) => (
          <div key={a.id} className={`border rounded-xl p-3 bg-white ${a.status === 'RESOLVED' ? 'opacity-60' : ''}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${SEV[a.severity] || ''}`}>{a.severity}</span>
                  <span className="px-1.5 py-0.5 rounded bg-slate-100 text-[10px] font-bold text-slate-700">{typeOf(a).replace(/_/g, ' ')}</span>
                  <span className="text-[10px] font-semibold text-slate-500">{a.status === 'ACTIVE' ? 'OPEN' : a.status}</span>
                </div>
                <div className="text-sm font-semibold text-slate-900 mt-1">{a.title}</div>
                {a.detail && <div className="text-[11px] text-slate-600 break-words">{a.detail}</div>}
                <div className="text-[10px] text-slate-500 mt-0.5">
                  First seen {when(a.first_seen_at)} · last seen {when(a.last_seen_at)}
                  {a.acknowledged_at ? ` · acknowledged by ${a.acknowledged_by_name || a.acknowledged_by} ${when(a.acknowledged_at)}` : ''}
                  {a.resolved_at ? ` · resolved ${when(a.resolved_at)}` : ''}{a.related_entity ? ` · ${a.related_entity}` : ''}
                </div>
              </div>
              {canAck && (a.status === 'OPEN' || a.status === 'ACTIVE') && (
                <button className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold flex items-center gap-1" onClick={() => void ack(a.id)}>
                  <CheckCheck className="w-3.5 h-3.5" /> Acknowledge
                </button>
              )}
            </div>
          </div>
        ))}
        {!rows.length && !loading && <div className="text-xs text-slate-500 bg-white border border-slate-200 rounded-xl p-6 text-center">No alerts. All clear.</div>}
      </div>
    </div>
  );
};
