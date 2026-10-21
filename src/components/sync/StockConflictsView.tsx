import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Layers,
  Loader2,
  Plus,
  Minus,
  RefreshCw,
  Search,
  ShieldAlert,
  Sliders,
  Wrench,
  X,
} from 'lucide-react';
import { apiFetch } from '../../services/http';
import { isGlobalAdminAccount } from '../../services/shopContext';
import { queueRemoteCommand, type RemoteAction } from '../../services/remoteAdmin';

export interface StockConflictItem {
  medicine_id: string;
  medicine_name: string;
  batch_id?: string | null;
  batch_number?: string | null;
  cloud_quantity: number;
  shop_quantity: number;
  cloud_version: number;
  shop_version: number;
  difference: number;
  last_local_change?: string | null;
  last_cloud_sync?: string | null;
  details?: Record<string, unknown> | null;
}

interface StockConflictsViewProps {
  online: boolean;
}

const when = (v?: string | null) => (v ? new Date(v).toLocaleString() : '—');

export const StockConflictsView: React.FC<StockConflictsViewProps> = ({ online }) => {
  const isGlobal = isGlobalAdminAccount();
  const [loading, setLoading] = useState(false);
  const [conflicts, setConflicts] = useState<StockConflictItem[]>([]);
  const [search, setSearch] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [selectedConflict, setSelectedConflict] = useState<StockConflictItem | null>(null);
  const [overrideKind, setOverrideKind] = useState<'add' | 'remove' | 'set' | null>(null);

  // Form state
  const [overrideQty, setOverrideQty] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submittingSync, setSubmittingSync] = useState<string | null>(null);

  const loadConflicts = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    try {
      if (online) {
        const res = await apiFetch<any>('/api/admin/sync/stock-conflicts');
        setConflicts(Array.isArray(res?.conflicts) ? res.conflicts : []);
      } else {
        const audit = await apiFetch<any>('/api/sync/stock-parity');
        const items = Array.isArray(audit?.items) ? audit.items : [];
        const mismatches = items.filter((it: any) => it.status === 'PERSISTENT_MISMATCH');
        setConflicts(mismatches.map((m: any) => ({
          medicine_id: m.medicine_id,
          medicine_name: m.name,
          cloud_quantity: m.cloud_stock ?? 0,
          shop_quantity: m.local_stock,
          cloud_version: m.cloud_stock_version ?? 1,
          shop_version: m.local_stock_version,
          difference: (m.local_stock || 0) - (m.cloud_stock || 0),
          last_local_change: audit.timestamp,
          last_cloud_sync: null,
          details: { reason: m.reason },
        })));
      }
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Failed to load stock conflicts.' });
    } finally {
      setLoading(false);
    }
  }, [online]);

  useEffect(() => {
    void loadConflicts();
  }, [loadConflicts]);

  const handleSyncFromShop = async (item: StockConflictItem) => {
    setSubmittingSync(item.medicine_id);
    try {
      if (online) {
        await queueRemoteCommand('stock-snapshot-request', {
          medicine_id: item.medicine_id,
          reason: 'Sync cloud baseline from authoritative shop stock',
        });
        setMsg({ ok: true, text: `Requested stock refresh from shop for "${item.medicine_name}". Cloud will update once reported.` });
      } else {
        await apiFetch('/api/sync/reconcile-baseline', {
          method: 'POST',
          body: { medicine_id: item.medicine_id },
        });
        setMsg({ ok: true, text: `Synchronized cloud baseline from shop for "${item.medicine_name}".` });
      }
      setTimeout(loadConflicts, 2000);
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Failed to request stock refresh.' });
    } finally {
      setSubmittingSync(null);
    }
  };

  const openOverride = (item: StockConflictItem, kind: 'add' | 'remove' | 'set') => {
    setSelectedConflict(item);
    setOverrideKind(kind);
    setOverrideQty('');
    setOverrideReason('');
    setConfirmed(false);
    setConfirmText('');
  };

  const closeOverride = () => {
    setSelectedConflict(null);
    setOverrideKind(null);
    setOverrideQty('');
    setOverrideReason('');
    setConfirmed(false);
    setConfirmText('');
  };

  const submitOverride = async () => {
    if (!selectedConflict || !overrideKind) return;
    const qty = Number(overrideQty);
    if (!Number.isFinite(qty) || qty < 0 || (overrideKind !== 'set' && qty === 0)) {
      setMsg({ ok: false, text: 'Please enter a valid quantity.' });
      return;
    }
    if (overrideReason.trim().length < 3) {
      setMsg({ ok: false, text: 'Please provide a meaningful reason (at least 3 characters).' });
      return;
    }
    if (!confirmed) {
      setMsg({ ok: false, text: 'Please acknowledge the override confirmation checkbox.' });
      return;
    }
    if ((overrideKind === 'remove' || (overrideKind === 'set' && qty < selectedConflict.shop_quantity)) && confirmText.trim().toUpperCase() !== 'OVERRIDE') {
      setMsg({ ok: false, text: 'Please type "OVERRIDE" to confirm this stock reduction.' });
      return;
    }

    setSubmitting(true);
    setMsg(null);
    try {
      const actionMap: Record<string, RemoteAction> = {
        add: 'stock-override-add',
        remove: 'stock-override-remove',
        set: 'stock-override-set',
      };
      const action = actionMap[overrideKind];

      const payload: Record<string, any> = {
        medicine_id: selectedConflict.medicine_id,
        quantity: qty,
        reason: overrideReason.trim(),
        cloud_quantity_seen: selectedConflict.cloud_quantity,
      };
      if (selectedConflict.batch_id) {
        payload.batch_id = selectedConflict.batch_id;
      }
      if (selectedConflict.batch_number) {
        payload.batch_number = selectedConflict.batch_number;
      }

      await queueRemoteCommand(action, payload);
      setMsg({
        ok: true,
        text: `Stock override command (${overrideKind.toUpperCase()}) queued for "${selectedConflict.medicine_name}". Shop will execute against live stock.`,
      });
      closeOverride();
      setTimeout(loadConflicts, 2500);
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Failed to submit stock override.' });
    } finally {
      setSubmitting(false);
    }
  };

  const filtered = conflicts.filter((c) =>
    c.medicine_name.toLowerCase().includes(search.toLowerCase()) ||
    (c.batch_number && c.batch_number.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="space-y-4">
      {/* Top Banner / Summary */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Layers className="w-5 h-5 text-teal-700" />
              <h2 className="text-base font-bold text-slate-900">Stock Conflicts Center</h2>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Shop local PostgreSQL is the execution authority. Cloud reporting copies never silently overwrite Shop stock.
              Use explicit Administrative Overrides only when intentional.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={loadConflicts}
              disabled={loading}
              className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold flex items-center gap-1.5 hover:bg-slate-50 disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
            <div className="text-[11px] font-semibold text-slate-500 uppercase">Total Mismatches</div>
            <div className={`text-xl font-bold mt-0.5 ${conflicts.length > 0 ? 'text-amber-700' : 'text-slate-800'}`}>
              {conflicts.length}
            </div>
          </div>
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
            <div className="text-[11px] font-semibold text-emerald-700 uppercase">Authority</div>
            <div className="text-sm font-bold text-emerald-900 mt-1">Shop Local PostgreSQL</div>
          </div>
          <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="text-[11px] font-semibold text-blue-700 uppercase">Cloud Copy</div>
            <div className="text-sm font-bold text-blue-900 mt-1">Reporting Mirror</div>
          </div>
          <div className="p-3 bg-purple-50 border border-purple-200 rounded-lg">
            <div className="text-[11px] font-semibold text-purple-700 uppercase">Override Authority</div>
            <div className="text-sm font-bold text-purple-900 mt-1">{isGlobal ? 'Global Admin' : 'Read Only'}</div>
          </div>
        </div>
      </div>

      {msg && (
        <div className={`p-3 rounded-xl border text-xs flex items-center justify-between gap-2 ${msg.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>
          <div className="flex items-center gap-2">
            {msg.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> : <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />}
            <span>{msg.text}</span>
          </div>
          <button onClick={() => setMsg(null)} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
          <input
            type="text"
            placeholder="Filter by medicine or batch..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-teal-600"
          />
        </div>
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto shadow-xs">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
            <tr>
              <th className="px-3 py-2.5 text-left font-semibold">Medicine</th>
              <th className="px-3 py-2.5 text-left font-semibold">Batch</th>
              <th className="px-3 py-2.5 text-right font-semibold">Cloud Qty</th>
              <th className="px-3 py-2.5 text-right font-semibold">Shop Authoritative</th>
              <th className="px-3 py-2.5 text-center font-semibold">Difference</th>
              <th className="px-3 py-2.5 text-center font-semibold">Versions</th>
              <th className="px-3 py-2.5 text-left font-semibold">Last Local Change</th>
              <th className="px-3 py-2.5 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((item) => (
              <tr key={item.medicine_id} className="hover:bg-slate-50/50">
                <td className="px-3 py-2.5 font-medium text-slate-900">{item.medicine_name}</td>
                <td className="px-3 py-2.5 text-slate-600">{item.batch_number || 'Default Batch'}</td>
                <td className="px-3 py-2.5 text-right font-mono text-slate-700">{item.cloud_quantity}</td>
                <td className="px-3 py-2.5 text-right font-mono font-bold text-slate-900">{item.shop_quantity}</td>
                <td className="px-3 py-2.5 text-center">
                  <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${item.difference > 0 ? 'bg-emerald-100 text-emerald-800' : item.difference < 0 ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-700'}`}>
                    {item.difference > 0 ? `+${item.difference}` : item.difference}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-center text-slate-500 font-mono text-[11px]">
                  Shop: v{item.shop_version} / Cloud: v{item.cloud_version}
                </td>
                <td className="px-3 py-2.5 text-slate-500">{when(item.last_local_change)}</td>
                <td className="px-3 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      onClick={() => handleSyncFromShop(item)}
                      disabled={submittingSync === item.medicine_id}
                      title="Update Cloud copy to match Shop authoritative stock"
                      className="px-2 py-1 rounded bg-teal-50 border border-teal-200 text-teal-800 text-[11px] font-semibold hover:bg-teal-100 disabled:opacity-50 flex items-center gap-1"
                    >
                      {submittingSync === item.medicine_id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                      <span>Sync From Shop</span>
                    </button>
                    {isGlobal && (
                      <>
                        <button
                          onClick={() => openOverride(item, 'add')}
                          className="px-2 py-1 rounded bg-blue-50 border border-blue-200 text-blue-800 text-[11px] font-semibold hover:bg-blue-100"
                        >
                          + Override
                        </button>
                        <button
                          onClick={() => openOverride(item, 'remove')}
                          className="px-2 py-1 rounded bg-amber-50 border border-amber-200 text-amber-800 text-[11px] font-semibold hover:bg-amber-100"
                        >
                          - Override
                        </button>
                        <button
                          onClick={() => openOverride(item, 'set')}
                          className="px-2 py-1 rounded bg-purple-50 border border-purple-200 text-purple-800 text-[11px] font-semibold hover:bg-purple-100"
                        >
                          Set Count
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                  <div className="flex flex-col items-center gap-1.5">
                    <CheckCircle2 className="w-6 h-6 text-emerald-600" />
                    <span className="font-semibold text-slate-700">All stock in perfect parity</span>
                    <span className="text-[11px] text-slate-400">Authoritative shop stock and cloud reporting copy are synchronized.</span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Stock Override Modal */}
      {selectedConflict && overrideKind && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-md w-full shadow-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-amber-400" />
                <span className="text-sm font-bold">
                  OVERRIDE STOCK — {overrideKind === 'add' ? 'ADD' : overrideKind === 'remove' ? 'REMOVE' : 'SET PHYSICAL COUNT'}
                </span>
              </div>
              <button onClick={closeOverride} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>

            <div className="p-4 space-y-3 text-xs">
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg space-y-1">
                <div className="font-bold text-amber-900 text-sm">{selectedConflict.medicine_name}</div>
                <div className="flex justify-between text-amber-800">
                  <span>Cloud seen quantity:</span>
                  <span className="font-bold font-mono">{selectedConflict.cloud_quantity}</span>
                </div>
                <div className="flex justify-between text-amber-800">
                  <span>Authoritative Shop quantity:</span>
                  <span className="font-bold font-mono">{selectedConflict.shop_quantity}</span>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  {overrideKind === 'add' ? 'Quantity to ADD:' : overrideKind === 'remove' ? 'Quantity to REMOVE:' : 'Authoritative Physical Count (SET TO):'}
                </label>
                <input
                  type="number"
                  min={overrideKind === 'set' ? 0 : 1}
                  value={overrideQty}
                  onChange={(e) => setOverrideQty(e.target.value)}
                  placeholder="Enter quantity..."
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-1 focus:ring-teal-600 focus:outline-none"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Reason (required):</label>
                <input
                  type="text"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder="e.g. Physical count verified by administrator"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs focus:ring-1 focus:ring-teal-600 focus:outline-none"
                />
              </div>

              <div className="pt-2 border-t border-slate-100 space-y-2">
                <label className="flex items-start gap-2 cursor-pointer text-slate-700">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    className="mt-0.5 rounded text-teal-600 focus:ring-teal-500"
                  />
                  <span className="text-[11px] leading-snug">
                    I understand this will change the Shop's authoritative stock via a local PostgreSQL transaction and generate an auditable movement.
                  </span>
                </label>

                {(overrideKind === 'remove' || (overrideKind === 'set' && Number(overrideQty) < selectedConflict.shop_quantity)) && (
                  <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-lg space-y-1">
                    <div className="font-bold text-rose-900 text-[11px]">Destructive Stock Reduction Confirmation:</div>
                    <p className="text-[10px] text-rose-700">Type OVERRIDE below to confirm reducing stock at the shop.</p>
                    <input
                      type="text"
                      placeholder="Type OVERRIDE"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-rose-300 rounded text-xs font-mono uppercase focus:ring-1 focus:ring-rose-600 focus:outline-none"
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
              <button
                onClick={closeOverride}
                disabled={submitting}
                className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold hover:bg-slate-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={submitOverride}
                disabled={submitting || !confirmed}
                className="px-3 py-1.5 rounded-lg bg-teal-800 text-white text-xs font-semibold hover:bg-teal-900 disabled:opacity-50 flex items-center gap-1.5"
              >
                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wrench className="w-3.5 h-3.5" />}
                <span>Execute Override Command</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
