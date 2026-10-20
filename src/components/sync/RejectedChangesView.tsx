import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RotateCcw,
  RefreshCw,
  AlertTriangle,
  ShieldAlert,
  CheckCircle2,
  Eye,
  X,
  Lock,
  ChevronDown,
  ChevronRight,
  Info,
  Layers,
  Search,
  Filter,
} from 'lucide-react';
import { apiFetch } from '../../services/http';
import { isGlobalAdminAccount } from '../../services/shopContext';

export interface RejectedChangeItem {
  id: string;
  shop_id: string;
  shop_code: string;
  shop_name: string;
  idempotency_key: string;
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  local_seq: number | null;
  business_ref: string | null;
  device_id: string | null;
  actor_name: string | null;
  created_at: string;
  last_attempt_at?: string;
  rejected_at?: string;
  attempt_count?: number;
  local_status?: string;
  cloud_status: string;
  rejection: {
    category: string;
    human_reason: string;
    technical_error: string;
    is_eligible_for_retry: boolean;
    is_permanent_failure: boolean;
  };
  sanitized_preview: Record<string, unknown>;
}

export interface SafeRetryPreviewReport {
  selected: number;
  already_processed_count: number;
  safe_to_retry_count: number;
  still_incompatible_count: number;
  permanent_failures_count: number;
  conflicts_review_required_count: number;
  items: Array<{
    id: string;
    idempotency_key: string;
    event_type: string;
    cloud_status: string;
    category: string;
    human_reason: string;
    safe_to_retry: boolean;
    already_processed: boolean;
  }>;
}

const when = (v?: string | null) => (v ? new Date(v).toLocaleString() : '—');

const categoryBadgeClass = (category: string) => {
  switch (category) {
    case 'SCHEMA_RPC_ERROR':
      return 'bg-amber-100 text-amber-800 border-amber-300';
    case 'VALIDATION_ERROR':
    case 'UNSUPPORTED_EVENT_TYPE':
      return 'bg-rose-100 text-rose-800 border-rose-300';
    case 'SEQUENCE_CONFLICT':
    case 'CONCURRENCY_CONFLICT':
      return 'bg-blue-100 text-blue-800 border-blue-300';
    case 'MISSING_REFERENCE':
      return 'bg-purple-100 text-purple-800 border-purple-300';
    case 'PROTOCOL_INCOMPATIBLE':
      return 'bg-indigo-100 text-indigo-800 border-indigo-300';
    case 'AUTHENTICATION_ERROR':
      return 'bg-red-100 text-red-800 border-red-300';
    case 'DUPLICATE_ALREADY_APPLIED':
      return 'bg-emerald-100 text-emerald-800 border-emerald-300';
    case 'CLOUD_ERROR':
      return 'bg-sky-100 text-sky-800 border-sky-300';
    default:
      return 'bg-slate-100 text-slate-800 border-slate-300';
  }
};

export const RejectedChangesView: React.FC<{
  online: boolean;
  onRefreshParent?: () => void;
}> = ({ online, onRefreshParent }) => {
  const [items, setItems] = useState<RejectedChangeItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Selection for retry
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Modal states
  const [inspectItem, setInspectItem] = useState<RejectedChangeItem | null>(null);
  const [showTechnicalError, setShowTechnicalError] = useState(false);
  const [previewModal, setPreviewModal] = useState<SafeRetryPreviewReport | null>(null);
  const [isRetryingAll, setIsRetryingAll] = useState(false);
  const [confirmingRetry, setConfirmingRetry] = useState(false);

  // Search & filter
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');

  const isGlobalAdmin = online ? isGlobalAdminAccount() : true;

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const endpoint = online ? '/api/admin/sync/rejected-changes' : '/api/sync/rejected-changes';
      const res = await apiFetch<{ total: number; items: RejectedChangeItem[] }>(endpoint);
      setItems(res.items || []);
      setSelectedIds(new Set());
    } catch (err: any) {
      setError(err?.message || 'Failed to load rejected changes.');
    } finally {
      setLoading(false);
    }
  }, [online]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (categoryFilter !== 'ALL' && item.rejection.category !== categoryFilter) {
        return false;
      }
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        item.event_type.toLowerCase().includes(q) ||
        (item.entity_type && item.entity_type.toLowerCase().includes(q)) ||
        (item.entity_id && item.entity_id.toLowerCase().includes(q)) ||
        (item.business_ref && item.business_ref.toLowerCase().includes(q)) ||
        (item.shop_name && item.shop_name.toLowerCase().includes(q)) ||
        (item.shop_code && item.shop_code.toLowerCase().includes(q)) ||
        item.rejection.human_reason.toLowerCase().includes(q)
      );
    });
  }, [items, search, categoryFilter]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllEligible = () => {
    const eligible = filteredItems.filter((i) => i.rejection.is_eligible_for_retry);
    const allSelected = eligible.every((i) => selectedIds.has(i.id));
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(eligible.map((i) => i.id)));
    }
  };

  const handleOpenPreview = async (allEligible: boolean) => {
    if (!isGlobalAdmin) return;
    setActionMsg(null);
    setConfirmingRetry(true);
    setIsRetryingAll(allEligible);
    try {
      const ids = Array.from(selectedIds);
      const res = await apiFetch<SafeRetryPreviewReport>('/api/admin/sync/rejected-changes/preview', {
        method: 'POST',
        body: allEligible ? { all: true } : { event_ids: ids },
      });
      setPreviewModal(res);
    } catch (err: any) {
      setActionMsg({ ok: false, text: err?.message || 'Precheck failed: SAFE_RETRY_PRECHECK_FAILED' });
    } finally {
      setConfirmingRetry(false);
    }
  };

  const handleExecuteRetry = async () => {
    if (!isGlobalAdmin) return;
    setConfirmingRetry(true);
    try {
      const ids = Array.from(selectedIds);
      const res = await apiFetch<{
        success: boolean;
        retried_count: number;
        already_applied_count: number;
        message?: string;
      }>('/api/admin/sync/rejected-changes/retry', {
        method: 'POST',
        body: isRetryingAll ? { all_eligible: true } : { event_ids: ids },
      });

      setPreviewModal(null);
      setActionMsg({
        ok: true,
        text: `Retry completed: ${res.retried_count} queued for retransmission, ${res.already_applied_count} verified as ALREADY_PROCESSED and synced.`,
      });
      await loadData();
      if (onRefreshParent) onRefreshParent();
    } catch (err: any) {
      setActionMsg({ ok: false, text: err?.message || 'Manual retry failed.' });
    } finally {
      setConfirmingRetry(false);
    }
  };

  const categories = useMemo(() => {
    const set = new Set(items.map((i) => i.rejection.category));
    return Array.from(set);
  }, [items]);

  const eligibleCount = useMemo(() => {
    return items.filter((i) => i.rejection.is_eligible_for_retry).length;
  }, [items]);

  return (
    <div className="space-y-3">
      {/* Action Notification */}
      {actionMsg && (
        <div
          className={`p-2.5 rounded-xl text-xs font-medium flex items-center justify-between border ${
            actionMsg.ok
              ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
              : 'bg-rose-50 text-rose-800 border-rose-200'
          }`}
        >
          <div className="flex items-center gap-1.5">
            {actionMsg.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <AlertTriangle className="w-4 h-4 text-rose-600" />}
            <span>{actionMsg.text}</span>
          </div>
          <button onClick={() => setActionMsg(null)} className="p-1 hover:bg-black/5 rounded">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Top Banner / Summary */}
      <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-rose-600" />
              <h2 className="text-sm font-bold text-slate-900">Rejected Changes Management Center</h2>
              <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-rose-100 text-rose-800 border border-rose-200">
                {items.length} REJECTED
              </span>
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Inspecting synchronization rejections. Only Global / Universal Administrators hold server-enforced retry authority.
            </p>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => void loadData()}
              disabled={loading}
              className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold flex items-center gap-1 hover:bg-slate-50 disabled:opacity-50"
              title="Check cloud event status again"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Check Status Again
            </button>

            {online && isGlobalAdmin ? (
              <>
                <button
                  onClick={() => void handleOpenPreview(false)}
                  disabled={loading || selectedIds.size === 0 || confirmingRetry}
                  className="px-2.5 py-1.5 rounded-lg bg-teal-700 text-white text-xs font-semibold flex items-center gap-1 hover:bg-teal-800 disabled:opacity-50"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Retry Selected ({selectedIds.size})
                </button>
                <button
                  onClick={() => void handleOpenPreview(true)}
                  disabled={loading || eligibleCount === 0 || confirmingRetry}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold flex items-center gap-1 hover:bg-slate-800 disabled:opacity-50"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Retry All Eligible ({eligibleCount})
                </button>
              </>
            ) : online ? (
              <div className="flex items-center gap-1 text-[11px] text-slate-500 bg-slate-100 px-2.5 py-1.5 rounded-lg border border-slate-200">
                <Lock className="w-3.5 h-3.5 text-slate-400" /> Global Admin Authority Required to Retry
              </div>
            ) : null}
          </div>
        </div>

        {/* Filter Bar */}
        <div className="mt-3 pt-3 border-t border-slate-100 flex flex-col sm:flex-row gap-2 items-center justify-between">
          <div className="relative w-full sm:w-72">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search event, ref, entity, error..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-8 pr-2.5 py-1.5 text-xs rounded-lg border border-slate-200 focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <Filter className="w-3.5 h-3.5 text-slate-400" />
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="text-xs rounded-lg border border-slate-200 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-teal-500 bg-white"
            >
              <option value="ALL">All Rejection Categories ({items.length})</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c} ({items.filter((i) => i.rejection.category === c).length})
                </option>
              ))}
            </select>

            {online && isGlobalAdmin && (
              <button
                onClick={toggleSelectAllEligible}
                className="text-[11px] font-medium text-teal-700 hover:text-teal-900 px-2 py-1"
              >
                Toggle Select Eligible
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Main Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto shadow-xs">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
            <tr>
              {online && isGlobalAdmin && <th className="px-2 py-2 text-center w-8">#</th>}
              <th className="px-2.5 py-2 text-left font-semibold">Shop</th>
              <th className="px-2.5 py-2 text-left font-semibold">Event</th>
              <th className="px-2.5 py-2 text-left font-semibold">Entity</th>
              <th className="px-2 py-2 text-center font-semibold">Seq</th>
              <th className="px-2.5 py-2 text-left font-semibold">Reference</th>
              <th className="px-2.5 py-2 text-left font-semibold">Category</th>
              <th className="px-2.5 py-2 text-left font-semibold">Rejection Explanation</th>
              <th className="px-2 py-2 text-center font-semibold">Cloud</th>
              <th className="px-2.5 py-2 text-left font-semibold">Rejected At</th>
              <th className="px-2.5 py-2 text-center font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredItems.map((item) => {
              const isSelected = selectedIds.has(item.id);
              return (
                <tr
                  key={item.id}
                  className={`hover:bg-slate-50/75 transition ${
                    isSelected ? 'bg-teal-50/30' : ''
                  }`}
                >
                  {online && isGlobalAdmin && (
                    <td className="px-2 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(item.id)}
                        className="rounded border-slate-300 text-teal-600 focus:ring-teal-500 cursor-pointer"
                      />
                    </td>
                  )}
                  <td className="px-2.5 py-2">
                    <span className="font-bold text-slate-800">{item.shop_code}</span>
                    <div className="text-[10px] text-slate-500 truncate max-w-[100px]">
                      {item.shop_name}
                    </div>
                  </td>
                  <td className="px-2.5 py-2">
                    <span className="font-mono font-bold text-slate-900">{item.event_type}</span>
                  </td>
                  <td className="px-2.5 py-2">
                    <span className="text-slate-700 capitalize">{item.entity_type}</span>
                    {item.entity_id && (
                      <div className="font-mono text-[10px] text-slate-400">
                        {item.entity_id.slice(0, 8)}…
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2 text-center font-mono text-slate-600">
                    {item.local_seq ?? '—'}
                  </td>
                  <td className="px-2.5 py-2 font-mono text-slate-700">
                    {item.business_ref || '—'}
                  </td>
                  <td className="px-2.5 py-2">
                    <span
                      className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold border ${categoryBadgeClass(
                        item.rejection.category
                      )}`}
                    >
                      {item.rejection.category}
                    </span>
                  </td>
                  <td className="px-2.5 py-2 max-w-xs">
                    <div className="text-slate-800 font-medium line-clamp-2">
                      {item.rejection.human_reason}
                    </div>
                  </td>
                  <td className="px-2 py-2 text-center">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                        item.cloud_status === 'PROCESSED'
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-rose-100 text-rose-800'
                      }`}
                    >
                      {item.cloud_status}
                    </span>
                  </td>
                  <td className="px-2.5 py-2 text-slate-500 whitespace-nowrap">
                    {when(item.rejected_at || item.created_at)}
                  </td>
                  <td className="px-2.5 py-2 text-center">
                    <button
                      onClick={() => {
                        setInspectItem(item);
                        setShowTechnicalError(false);
                      }}
                      className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium inline-flex items-center gap-1"
                    >
                      <Eye className="w-3 h-3" /> Details
                    </button>
                  </td>
                </tr>
              );
            })}

            {!filteredItems.length && !loading && (
              <tr>
                <td
                  colSpan={11}
                  className="px-3 py-8 text-center text-slate-500 text-xs"
                >
                  No rejected changes match the selected filter.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td
                  colSpan={11}
                  className="px-3 py-8 text-center text-slate-500 text-xs"
                >
                  Loading rejected change registry…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Change Details Modal */}
      {inspectItem && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-2xl w-full border border-slate-200 shadow-xl overflow-hidden my-6">
            <div className="px-4 py-3 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-teal-400" />
                <span className="font-bold text-sm">CHANGE DETAILS — {inspectItem.event_type}</span>
              </div>
              <button
                onClick={() => setInspectItem(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-4 max-h-[80vh] overflow-y-auto">
              {/* Metadata Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Shop</div>
                  <div className="font-bold text-slate-800">
                    {inspectItem.shop_name} ({inspectItem.shop_code})
                  </div>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Event</div>
                  <div className="font-mono font-bold text-slate-800">{inspectItem.event_type}</div>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Local Sequence</div>
                  <div className="font-mono font-bold text-slate-800">{inspectItem.local_seq ?? '—'}</div>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Entity</div>
                  <div className="font-bold text-slate-800">
                    {inspectItem.entity_type} {inspectItem.entity_id ? `(${inspectItem.entity_id.slice(0, 8)}…)` : ''}
                  </div>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Business Reference</div>
                  <div className="font-mono font-bold text-slate-800">{inspectItem.business_ref || '—'}</div>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Device / Cashier</div>
                  <div className="font-bold text-slate-800 truncate">
                    {inspectItem.actor_name || inspectItem.device_id || '—'}
                  </div>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Created At</div>
                  <div className="text-slate-700">{when(inspectItem.created_at)}</div>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Last Attempted</div>
                  <div className="text-slate-700">{when(inspectItem.rejected_at || inspectItem.last_attempt_at)}</div>
                </div>
                <div className="bg-slate-50 p-2 rounded-lg border border-slate-200">
                  <div className="text-[10px] uppercase text-slate-500 font-bold">Cloud State</div>
                  <div className="font-bold text-rose-700">{inspectItem.cloud_status}</div>
                </div>
              </div>

              {/* Rejection Category & Explanation */}
              <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 text-xs">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-rose-900 uppercase text-[10px] tracking-wide">
                    Rejection Category
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-bold border ${categoryBadgeClass(
                      inspectItem.rejection.category
                    )}`}
                  >
                    {inspectItem.rejection.category}
                  </span>
                </div>
                <div className="text-rose-950 font-medium text-xs mt-1">
                  {inspectItem.rejection.human_reason}
                </div>

                {/* Expandable Technical Diagnostics */}
                {inspectItem.rejection.technical_error && (
                  <div className="mt-2 pt-2 border-t border-rose-200/60">
                    <button
                      onClick={() => setShowTechnicalError((prev) => !prev)}
                      className="text-[11px] font-semibold text-rose-800 hover:text-rose-950 flex items-center gap-1"
                    >
                      {showTechnicalError ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      Technical Diagnostics
                    </button>
                    {showTechnicalError && (
                      <pre className="mt-1.5 p-2 bg-rose-100/70 rounded-lg text-[10px] font-mono text-rose-900 overflow-x-auto whitespace-pre-wrap">
                        {inspectItem.rejection.technical_error}
                      </pre>
                    )}
                  </div>
                )}
              </div>

              {/* Sanitized Payload Preview */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                    <Info className="w-3.5 h-3.5 text-teal-700" />
                    Sanitized Business Payload Preview
                  </div>
                  <span className="text-[10px] text-slate-400 font-mono">Zero credentials exposed</span>
                </div>

                <div className="bg-slate-900 text-slate-100 rounded-xl p-3 text-xs font-mono overflow-x-auto max-h-56">
                  <pre>{JSON.stringify(inspectItem.sanitized_preview, null, 2)}</pre>
                </div>
              </div>
            </div>

            <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex justify-end">
              <button
                onClick={() => setInspectItem(null)}
                className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-bold hover:bg-slate-100 text-slate-700"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Safe Retry Preview Modal */}
      {previewModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-xl w-full border border-slate-200 shadow-xl overflow-hidden my-6">
            <div className="px-4 py-3 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <RotateCcw className="w-4 h-4 text-teal-400" />
                <span className="font-bold text-sm">SAFE RETRY PREVIEW &amp; CONFIRMATION</span>
              </div>
              <button
                onClick={() => setPreviewModal(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-3 text-xs">
              <p className="text-slate-600">
                The cloud status precheck was performed. Review the classification breakdown before confirming manual retry:
              </p>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-200">
                  <div className="text-[10px] uppercase font-bold text-slate-500">Selected Events</div>
                  <div className="text-base font-black text-slate-900">{previewModal.selected}</div>
                </div>
                <div className="bg-emerald-50 p-2.5 rounded-xl border border-emerald-200">
                  <div className="text-[10px] uppercase font-bold text-emerald-800">Already Processed</div>
                  <div className="text-base font-black text-emerald-700">
                    {previewModal.already_processed_count}
                  </div>
                  <div className="text-[9px] text-emerald-600 mt-0.5">Synced without retransmission</div>
                </div>
                <div className="bg-teal-50 p-2.5 rounded-xl border border-teal-200">
                  <div className="text-[10px] uppercase font-bold text-teal-800">Safe to Retry</div>
                  <div className="text-base font-black text-teal-700">
                    {previewModal.safe_to_retry_count}
                  </div>
                  <div className="text-[9px] text-teal-600 mt-0.5">Compatible with current cloud</div>
                </div>
                <div className="bg-amber-50 p-2.5 rounded-xl border border-amber-200">
                  <div className="text-[10px] uppercase font-bold text-amber-800">Still Incompatible</div>
                  <div className="text-base font-black text-amber-700">
                    {previewModal.still_incompatible_count}
                  </div>
                </div>
                <div className="bg-rose-50 p-2.5 rounded-xl border border-rose-200">
                  <div className="text-[10px] uppercase font-bold text-rose-800">Permanent Failures</div>
                  <div className="text-base font-black text-rose-700">
                    {previewModal.permanent_failures_count}
                  </div>
                </div>
                <div className="bg-blue-50 p-2.5 rounded-xl border border-blue-200">
                  <div className="text-[10px] uppercase font-bold text-blue-800">Review Required</div>
                  <div className="text-base font-black text-blue-700">
                    {previewModal.conflicts_review_required_count}
                  </div>
                </div>
              </div>

              {previewModal.safe_to_retry_count === 0 && previewModal.already_processed_count === 0 ? (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-900 text-xs">
                  None of the selected events are safe to retry at this time. Resolve schema or validation issues first.
                </div>
              ) : (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-700 text-xs">
                  Confirming will re-queue {previewModal.safe_to_retry_count} eligible event(s) with identical idempotency keys, and reconcile {previewModal.already_processed_count} already-applied event(s).
                </div>
              )}
            </div>

            <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
              <button
                onClick={() => setPreviewModal(null)}
                disabled={confirmingRetry}
                className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-bold hover:bg-slate-100 text-slate-700"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleExecuteRetry()}
                disabled={confirmingRetry || (previewModal.safe_to_retry_count === 0 && previewModal.already_processed_count === 0)}
                className="px-3.5 py-1.5 rounded-lg bg-teal-700 text-white text-xs font-bold hover:bg-teal-800 disabled:opacity-50 flex items-center gap-1.5"
              >
                {confirmingRetry ? 'Executing Retry…' : 'Confirm & Execute Safe Retry'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
