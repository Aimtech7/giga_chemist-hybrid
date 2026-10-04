import React, { useEffect, useMemo, useState } from 'react';
import { RotateCcw, CheckCircle2, XCircle, Clock, AlertTriangle, RefreshCw } from 'lucide-react';
import { db } from '../../db/dexie';
import { apiFetch } from '../../services/http';
import { applyServerStockResult, refreshCacheAfterCommit } from '../../services/stockCache';
import type { PharmacySettings, User } from '../../types';

/**
 * Return requests. Cashiers see "My Return Requests" (read-only). Administrators review PENDING
 * requests and APPROVE (refund + optional restock, applied by the server in one transaction) or
 * REJECT them. The server enforces these permissions; this screen only reflects them.
 */
type Status = 'PENDING' | 'APPROVED' | 'REJECTED';

interface ReturnRow {
  id: string;
  sale_id: string;
  receipt_number: string;
  sale_date: string;
  sale_time: string;
  sale_price_mode?: string | null;
  sale_discount_percent: number;
  customer_name?: string;
  medicine_name: string;
  batch_number: string;
  quantity: number;
  approved_quantity?: number;
  sold_quantity: number;
  sold_total: number;
  sold_line_discount: number;
  other_approved_quantity: number;
  unit_price: number;
  effective_unit_price: number;
  requested_refund?: number;
  refund_amount: number;
  restocked?: boolean;
  action: string;
  reason: string;
  status: Status;
  user_name: string;
  timestamp: number;
  reviewed_by_name?: string;
  reviewed_at?: string;
  review_notes?: string;
}

interface Props {
  currentUser: User | null;
  settings: PharmacySettings;
}

const STATUS_STYLE: Record<Status, string> = {
  PENDING: 'bg-amber-100 text-amber-900 border-amber-300',
  APPROVED: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  REJECTED: 'bg-rose-50 text-rose-800 border-rose-200',
};

export const ReturnsManager: React.FC<Props> = ({ currentUser, settings }) => {
  const isAdmin = currentUser?.role === 'ADMIN';
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [tab, setTab] = useState<Status>('PENDING');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Review dialog state
  const [reviewing, setReviewing] = useState<{ row: ReturnRow; mode: 'approve' | 'reject' } | null>(null);
  const [restock, setRestock] = useState<'yes' | 'no' | ''>('');
  const [disposition, setDisposition] = useState<'quarantine' | 'damaged' | 'dispose'>('quarantine');
  const [notes, setNotes] = useState('');
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await apiFetch<ReturnRow[]>('/api/returns'));
    } catch (err: any) {
      setError(err?.message || 'Could not load return requests.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const counts = useMemo(
    () => ({
      PENDING: rows.filter((r) => r.status === 'PENDING').length,
      APPROVED: rows.filter((r) => r.status === 'APPROVED').length,
      REJECTED: rows.filter((r) => r.status === 'REJECTED').length,
    }),
    [rows]
  );
  const visible = rows.filter((r) => r.status === tab);
  const money = (n?: number) => `${settings.currency} ${(Number(n) || 0).toFixed(2)}`;

  const openReview = (row: ReturnRow, mode: 'approve' | 'reject') => {
    setReviewing({ row, mode });
    setRestock('');
    setDisposition('quarantine');
    setNotes('');
    setReviewError(null);
  };

  const submitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reviewing) return;
    setReviewError(null);
    if (reviewing.mode === 'approve' && !restock) {
      setReviewError('Choose whether the item goes back to sellable stock.');
      return;
    }
    if (reviewing.mode === 'reject' && !notes.trim()) {
      setReviewError('Enter the reason for rejecting this return.');
      return;
    }
    setSubmitting(true);
    try {
      if (reviewing.mode === 'approve') {
        const result = await apiFetch<any>(`/api/returns/${reviewing.row.id}/approve`, {
          body: { restock: restock === 'yes', disposition: restock === 'no' ? disposition : undefined, notes: notes.trim() || undefined },
        });
        await refreshCacheAfterCommit(async () => {
          await db.customer_returns.put(result.return);
          await db.sales.put(result.sale);
          await applyServerStockResult({ medicine: result.medicine, batch: result.batch });
        });
        setNotice(
          `Approved: ${reviewing.row.quantity}x ${reviewing.row.medicine_name}, refund ${money(result.refund_amount)}` +
            (restock === 'yes' ? ' — returned to sellable stock.' : ` — not restocked (${disposition}).`)
        );
      } else {
        const result = await apiFetch<any>(`/api/returns/${reviewing.row.id}/reject`, { body: { notes: notes.trim() } });
        await refreshCacheAfterCommit(async () => {
          await db.customer_returns.put(result.return);
          await db.sales.put(result.sale);
        });
        setNotice(`Rejected return request for ${reviewing.row.medicine_name}. No stock or refund change.`);
      }
      setReviewing(null);
      setTimeout(() => setNotice(null), 6000);
      await load();
    } catch (err: any) {
      setReviewError(err?.message || 'The review could not be completed.');
    } finally {
      setSubmitting(false);
    }
  };

  const tabs: Status[] = ['PENDING', 'APPROVED', 'REJECTED'];

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      <div className="p-4 bg-white border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 shrink-0">
        <div>
          <h1 className="text-base font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <RotateCcw className="w-4 h-4 text-teal-700" />
            {isAdmin ? 'Returns Review' : 'My Return Requests'}
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {isAdmin
              ? 'Approve or reject return requests. Stock and refunds change only when you approve.'
              : 'Return requests you submitted from Sales History. An administrator approves or rejects them.'}
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="px-4 pt-3 flex gap-1.5">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded text-xs font-bold border cursor-pointer flex items-center gap-1.5 ${
              tab === t ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
            }`}
          >
            {t === 'PENDING' ? 'Pending' : t === 'APPROVED' ? 'Approved' : 'Rejected'}
            <span
              className={`min-w-5 px-1.5 rounded-full text-[10px] ${
                t === 'PENDING' && counts.PENDING > 0 ? 'bg-amber-500 text-white' : tab === t ? 'bg-white/20' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {counts[t]}
            </span>
          </button>
        ))}
      </div>

      {error && (
        <div className="mx-4 mt-3 p-2 rounded border border-rose-200 bg-rose-50 text-rose-800 text-xs">{error}</div>
      )}
      {notice && (
        <div className="mx-4 mt-3 p-2 rounded border border-emerald-200 bg-emerald-50 text-emerald-800 text-xs flex items-center gap-1.5">
          <CheckCircle2 className="w-4 h-4" />
          {notice}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4">
        <div className="bg-white rounded border border-slate-200 overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-700">
            <thead className="bg-slate-50 uppercase text-[10px] font-semibold text-slate-600 border-b border-slate-200">
              <tr>
                <th className="py-2.5 px-3">Receipt / Sale Date</th>
                <th className="py-2.5 px-3">Requested By</th>
                <th className="py-2.5 px-3">Customer</th>
                <th className="py-2.5 px-3">Medicine / Batch</th>
                <th className="py-2.5 px-3 text-right">Qty Requested</th>
                <th className="py-2.5 px-3 text-right">Sold / Already Returned</th>
                <th className="py-2.5 px-3 text-right">Unit Price / Discount</th>
                <th className="py-2.5 px-3 text-right">Paid (line)</th>
                <th className="py-2.5 px-3 text-right">{tab === 'APPROVED' ? 'Refunded' : 'Requested Refund'}</th>
                <th className="py-2.5 px-3">Reason</th>
                <th className="py-2.5 px-3">Status</th>
                {isAdmin && tab === 'PENDING' && <th className="py-2.5 px-3 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-10 text-center text-slate-400">
                    {loading ? 'Loading…' : `No ${tab.toLowerCase()} return requests.`}
                  </td>
                </tr>
              ) : (
                visible.map((r) => (
                  <tr key={r.id} className={r.status === 'PENDING' ? 'bg-amber-50/40' : ''}>
                    <td className="py-2 px-3 font-mono">
                      <div className="font-bold text-slate-900">{r.receipt_number}</div>
                      <div className="text-[10px] text-slate-500">
                        {r.sale_date} {r.sale_time}
                        {r.sale_price_mode === 'WHOLESALE' && <span className="ml-1 font-bold text-amber-700">WHOLESALE</span>}
                      </div>
                    </td>
                    <td className="py-2 px-3">
                      <div>{r.user_name}</div>
                      <div className="text-[10px] text-slate-500">{new Date(r.timestamp).toLocaleString()}</div>
                    </td>
                    <td className="py-2 px-3">{r.customer_name || 'Walk-in'}</td>
                    <td className="py-2 px-3">
                      <div className="font-semibold text-slate-900">{r.medicine_name}</div>
                      <div className="text-[10px] font-mono text-slate-500">{r.batch_number}</div>
                    </td>
                    <td className="py-2 px-3 text-right font-mono font-bold">{r.quantity}</td>
                    <td className="py-2 px-3 text-right font-mono">
                      {r.sold_quantity} / {r.other_approved_quantity}
                    </td>
                    <td className="py-2 px-3 text-right font-mono">
                      <div>{money(r.unit_price)}</div>
                      <div className="text-[10px] text-slate-500">
                        {r.sale_discount_percent > 0 ? `${r.sale_discount_percent}% (−${money(r.sold_line_discount)})` : 'no discount'}
                      </div>
                    </td>
                    <td className="py-2 px-3 text-right font-mono">
                      <div>{money(r.sold_total)}</div>
                      <div className="text-[10px] text-slate-500">{money(r.effective_unit_price)} / unit</div>
                    </td>
                    <td className="py-2 px-3 text-right font-mono font-bold">
                      {money(r.status === 'APPROVED' ? r.refund_amount : r.requested_refund)}
                    </td>
                    <td className="py-2 px-3 max-w-[180px]">
                      <div className="truncate" title={r.reason}>{r.reason}</div>
                      {r.review_notes && (
                        <div className="text-[10px] text-slate-500 truncate" title={r.review_notes}>
                          Admin: {r.review_notes}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-3">
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-bold ${STATUS_STYLE[r.status]}`}>
                        {r.status === 'PENDING' ? <Clock className="w-3 h-3" /> : r.status === 'APPROVED' ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                        {r.status === 'PENDING' ? 'PENDING ADMIN APPROVAL' : r.status}
                      </span>
                      {r.status === 'APPROVED' && (
                        <div className="text-[10px] text-slate-500 mt-0.5">{r.restocked ? 'Returned to stock' : `Not restocked (${r.action})`}</div>
                      )}
                      {r.reviewed_by_name && <div className="text-[10px] text-slate-500">by {r.reviewed_by_name}</div>}
                    </td>
                    {isAdmin && tab === 'PENDING' && (
                      <td className="py-2 px-3 text-right whitespace-nowrap">
                        <button
                          onClick={() => openReview(r, 'approve')}
                          className="px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-800 text-white text-[11px] font-bold mr-1 cursor-pointer"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => openReview(r, 'reject')}
                          className="px-2 py-1 rounded border border-rose-300 text-rose-700 hover:bg-rose-50 text-[11px] font-bold cursor-pointer"
                        >
                          Reject
                        </button>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {reviewing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" role="dialog" aria-modal="true">
          <form onSubmit={submitReview} className="w-full max-w-md bg-white rounded border border-slate-300 shadow-lg overflow-hidden text-slate-800 text-xs">
            <div className={`px-4 py-3 text-white font-bold uppercase tracking-wider ${reviewing.mode === 'approve' ? 'bg-emerald-700' : 'bg-rose-700'}`}>
              {reviewing.mode === 'approve' ? 'Approve Return' : 'Reject Return'}
            </div>
            <div className="p-4 space-y-3">
              <div className="p-2.5 rounded bg-slate-50 border border-slate-200 space-y-0.5">
                <div>
                  <strong>{reviewing.row.quantity}x {reviewing.row.medicine_name}</strong> — receipt {reviewing.row.receipt_number}
                </div>
                <div>Requested by {reviewing.row.user_name}. Reason: {reviewing.row.reason}</div>
                <div>
                  Refund basis (price actually paid): <strong>{money(reviewing.row.requested_refund)}</strong>
                </div>
              </div>

              {reviewing.mode === 'approve' && (
                <div className="space-y-2">
                  <div className="font-semibold text-slate-700">Return to sellable stock? *</div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="restock" checked={restock === 'yes'} onChange={() => setRestock('yes')} />
                    <span>YES — sealed and sellable; add {reviewing.row.quantity} unit(s) back to stock</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="restock" checked={restock === 'no'} onChange={() => setRestock('no')} />
                    <span>NO — refund only; stock is not increased</span>
                  </label>
                  {restock === 'no' && (
                    <select
                      value={disposition}
                      onChange={(e) => setDisposition(e.target.value as any)}
                      className="w-full p-2 border border-slate-300 rounded bg-white"
                    >
                      <option value="quarantine">Quarantine for inspection</option>
                      <option value="damaged">Damaged</option>
                      <option value="dispose">Dispose / destroy</option>
                    </select>
                  )}
                </div>
              )}

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  {reviewing.mode === 'approve' ? 'Review notes (optional)' : 'Rejection reason *'}
                </label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                />
              </div>

              {reviewError && (
                <div className="p-2 rounded bg-rose-50 border border-rose-200 text-rose-800 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  {reviewError}
                </div>
              )}
            </div>
            <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
              <button type="button" onClick={() => setReviewing(null)} className="px-3 py-1.5 rounded border border-slate-300 bg-white hover:bg-slate-100 font-semibold cursor-pointer">
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className={`px-4 py-1.5 rounded text-white font-bold cursor-pointer disabled:opacity-50 ${reviewing.mode === 'approve' ? 'bg-emerald-700 hover:bg-emerald-800' : 'bg-rose-700 hover:bg-rose-800'}`}
              >
                {submitting ? 'Saving…' : reviewing.mode === 'approve' ? 'Approve Return' : 'Reject Return'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
