import React, { useCallback, useEffect, useState } from 'react';
import {
  Calendar,
  CheckCircle2,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Filter,
  Layers,
  Loader2,
  Printer,
  RefreshCw,
  Search,
  ShieldAlert,
  User,
  X,
} from 'lucide-react';
import { apiFetch } from '../../services/http';
import { downloadCSV } from '../../services/exportUtils';

export interface StockAdjustmentRecord {
  override_id: string;
  command_id: string;
  shop_id: string;
  shop_name: string;
  medicine_id: string;
  medicine_name: string;
  sku?: string | null;
  barcode?: string | null;
  batch_id?: string | null;
  batch_number?: string | null;
  expiry_date?: string | null;
  admin_user_id?: string | null;
  admin_name: string;
  admin_email: string;
  action: 'ADD' | 'REMOVE' | 'SET' | 'SET_TO_ZERO' | string;
  online_quantity_shown?: number | null;
  actual_quantity_before?: number | null;
  local_quantity_before?: number | null;
  requested_amount?: number | null;
  actual_quantity_after?: number | null;
  local_quantity_after?: number | null;
  difference?: number | null;
  reason: string;
  notes?: string | null;
  date_submitted: string;
  date_delivered?: string | null;
  date_applied?: string | null;
  date_cloud_confirmed?: string | null;
  stock_version_before?: number | null;
  stock_version_after?: number | null;
  result: string;
}

export const StockAdjustmentRegister: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [adjustments, setAdjustments] = useState<StockAdjustmentRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [actionFilter, setActionFilter] = useState('ALL');
  const [adminFilter, setAdminFilter] = useState('');
  const [selectedRecord, setSelectedRecord] = useState<StockAdjustmentRecord | null>(null);

  const fetchAdjustments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      if (dateFrom) q.append('from', dateFrom);
      if (dateTo) q.append('to', dateTo);
      if (actionFilter !== 'ALL') q.append('operation', actionFilter);
      if (adminFilter) q.append('admin', adminFilter);
      if (search) q.append('medicine', search);

      const qs = q.toString() ? `?${q.toString()}` : '';
      let res: any;
      try {
        res = await apiFetch<any>(`/api/audit/stock-adjustments${qs}`);
      } catch (e: any) {
        // Fallback for online or different endpoint
        res = await apiFetch<any>(`/api/admin/stock-adjustments${qs}`);
      }

      const list = Array.isArray(res?.adjustments) ? res.adjustments : (Array.isArray(res) ? res : []);
      setAdjustments(list);
    } catch (err: any) {
      setError(err?.message || 'Failed to load stock adjustment records.');
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, actionFilter, adminFilter, search]);

  useEffect(() => {
    void fetchAdjustments();
  }, [fetchAdjustments]);

  const handlePrint = () => {
    window.print();
  };

  const handleExportCSV = () => {
    const headers = [
      'Override ID',
      'Command ID',
      'Shop ID',
      'Shop Name',
      'Medicine ID',
      'Medicine Name',
      'SKU',
      'Barcode',
      'Batch ID',
      'Batch Number',
      'Expiry Date',
      'Administrator Name',
      'Administrator Email',
      'Action',
      'Online Qty Shown',
      'Actual Qty Before',
      'Requested Qty',
      'Actual Qty After',
      'Difference',
      'Reason',
      'Notes',
      'Date Submitted',
      'Date Delivered',
      'Date Applied',
      'Date Cloud Confirmed',
      'Stock Version Before',
      'Stock Version After',
      'Result',
    ];

    const rows = adjustments.map((r) => [
      r.override_id,
      r.command_id,
      r.shop_id,
      r.shop_name,
      r.medicine_id,
      r.medicine_name,
      r.sku || '',
      r.barcode || '',
      r.batch_id || '',
      r.batch_number || '',
      r.expiry_date || '',
      r.admin_name,
      r.admin_email,
      r.action,
      r.online_quantity_shown ?? '',
      r.local_quantity_before ?? r.actual_quantity_before ?? '',
      r.requested_amount ?? '',
      r.local_quantity_after ?? r.actual_quantity_after ?? '',
      r.difference ?? '',
      r.reason,
      r.notes || '',
      r.date_submitted,
      r.date_delivered || '',
      r.date_applied || '',
      r.date_cloud_confirmed || '',
      r.stock_version_before ?? '',
      r.stock_version_after ?? '',
      r.result,
    ]);

    downloadCSV(
      `global-admin-stock-adjustments-${new Date().toISOString().slice(0, 10)}.csv`,
      headers,
      rows
    );
  };

  const actionBadge = (act: string) => {
    switch (act) {
      case 'ADD':
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-blue-100 text-blue-800 border border-blue-200">FORCE ADD</span>;
      case 'REMOVE':
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-200">FORCE REMOVE</span>;
      case 'SET':
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-purple-100 text-purple-800 border border-purple-200">FORCE SET</span>;
      case 'SET_TO_ZERO':
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-rose-100 text-rose-800 border border-rose-200">SET TO ZERO</span>;
      default:
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-slate-100 text-slate-800 border border-slate-200">{act}</span>;
    }
  };

  return (
    <div className="space-y-4">
      {/* Printable Stylesheet */}
      <style>{`
        @media print {
          body * {
            visibility: hidden;
          }
          #printable-stock-adjustments, #printable-stock-adjustments * {
            visibility: visible;
          }
          #printable-stock-adjustments {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
          }
          .no-print {
            display: none !important;
          }
        }
      `}</style>

      {/* Top Banner & Title */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs no-print">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Layers className="w-5 h-5 text-teal-700" />
              <h2 className="text-base font-bold text-slate-900">Stock Adjustment Register</h2>
              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-teal-50 border border-teal-200 text-teal-800">
                GLOBAL ADMIN — AUTHORITATIVE AUDIT
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Permanent immutable record of every stock-changing directive executed under Global Administrator authority.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={fetchAdjustments}
              disabled={loading}
              className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold flex items-center gap-1.5 hover:bg-slate-50 disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              <span>Refresh</span>
            </button>
            <button
              onClick={handlePrint}
              className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold flex items-center gap-1.5 hover:bg-slate-50"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>Print / PDF</span>
            </button>
            <button
              onClick={handleExportCSV}
              className="px-3 py-1.5 rounded-lg bg-teal-800 text-white text-xs font-semibold flex items-center gap-1.5 hover:bg-teal-900"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export CSV</span>
            </button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2 mt-4 pt-4 border-t border-slate-100">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              placeholder="Search medicine or SKU..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-8 pr-2 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-teal-600"
            />
          </div>

          <div>
            <select
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-teal-600"
            >
              <option value="ALL">All Operations</option>
              <option value="ADD">FORCE ADD</option>
              <option value="REMOVE">FORCE REMOVE</option>
              <option value="SET">FORCE SET</option>
              <option value="SET_TO_ZERO">SET TO ZERO</option>
            </select>
          </div>

          <div>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              placeholder="From Date"
              className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-teal-600"
            />
          </div>

          <div>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              placeholder="To Date"
              className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-teal-600"
            />
          </div>

          <div>
            <input
              type="text"
              placeholder="Filter by admin..."
              value={adminFilter}
              onChange={(e) => setAdminFilter(e.target.value)}
              className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-teal-600"
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 no-print">
          {error}
        </div>
      )}

      {/* Main Table Container */}
      <div id="printable-stock-adjustments" className="bg-white border border-slate-200 rounded-xl overflow-x-auto shadow-xs">
        {/* Print Header */}
        <div className="hidden print:block p-4 border-b border-slate-200 mb-2">
          <h1 className="text-lg font-bold text-slate-900">GIGA CHEMIST — STOCK ADJUSTMENT REGISTER</h1>
          <p className="text-xs text-slate-600">Global Administrator Authoritative Stock Audit Trail</p>
          <p className="text-[10px] text-slate-400 mt-1">Generated: {new Date().toLocaleString()}</p>
        </div>

        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
            <tr>
              <th className="px-3 py-2.5 text-left font-semibold">Date & Time</th>
              <th className="px-3 py-2.5 text-left font-semibold">Shop</th>
              <th className="px-3 py-2.5 text-left font-semibold">Medicine & Batch</th>
              <th className="px-3 py-2.5 text-center font-semibold">Operation</th>
              <th className="px-3 py-2.5 text-right font-semibold">Online Seen</th>
              <th className="px-3 py-2.5 text-right font-semibold">Actual Before</th>
              <th className="px-3 py-2.5 text-right font-semibold">Requested</th>
              <th className="px-3 py-2.5 text-right font-semibold">Actual After</th>
              <th className="px-3 py-2.5 text-center font-semibold">Difference</th>
              <th className="px-3 py-2.5 text-left font-semibold">Administrator</th>
              <th className="px-3 py-2.5 text-left font-semibold">Reason</th>
              <th className="px-3 py-2.5 text-center font-semibold no-print">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 font-mono">
            {adjustments.map((rec) => {
              const before = rec.local_quantity_before ?? rec.actual_quantity_before ?? 0;
              const after = rec.local_quantity_after ?? rec.actual_quantity_after ?? 0;
              const diff = rec.difference ?? (after - before);

              return (
                <tr key={rec.override_id || rec.command_id} className="hover:bg-slate-50/50">
                  <td className="px-3 py-2 text-slate-600 text-[11px] whitespace-nowrap">
                    {new Date(rec.date_applied || rec.date_submitted).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 font-sans font-medium text-slate-900 whitespace-nowrap">
                    {rec.shop_name || 'Shop'}
                  </td>
                  <td className="px-3 py-2 font-sans">
                    <div className="font-semibold text-slate-900">{rec.medicine_name}</div>
                    <div className="text-[10px] text-slate-500 font-mono">
                      {rec.batch_number ? `Batch: ${rec.batch_number}` : 'All Batches'}
                      {rec.barcode ? ` | ${rec.barcode}` : ''}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center whitespace-nowrap">
                    {actionBadge(rec.action)}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-500">
                    {rec.online_quantity_shown != null ? rec.online_quantity_shown : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-700 font-bold">
                    {before}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-900">
                    {rec.requested_amount != null ? rec.requested_amount : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-emerald-900 font-bold">
                    {after}
                  </td>
                  <td className="px-3 py-2 text-center whitespace-nowrap">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${diff > 0 ? 'bg-emerald-100 text-emerald-800' : diff < 0 ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-700'}`}>
                      {diff > 0 ? `+${diff}` : diff}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-sans text-slate-700 text-[11px]">
                    <div className="font-medium">{rec.admin_name}</div>
                    <div className="text-[10px] text-slate-400">{rec.admin_email}</div>
                  </td>
                  <td className="px-3 py-2 font-sans text-slate-600 text-[11px] max-w-xs truncate" title={rec.reason}>
                    {rec.reason}
                  </td>
                  <td className="px-3 py-2 text-center no-print">
                    <button
                      onClick={() => setSelectedRecord(rec)}
                      className="p-1 text-slate-400 hover:text-slate-700 rounded hover:bg-slate-100"
                      title="Inspect all 22 audit fields"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              );
            })}

            {adjustments.length === 0 && !loading && (
              <tr>
                <td colSpan={12} className="px-4 py-8 text-center text-slate-400 font-sans">
                  No stock adjustment records found matching your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Record Inspection Modal */}
      {selectedRecord && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 no-print">
          <div className="bg-white rounded-2xl max-w-2xl w-full shadow-2xl border border-slate-200 overflow-hidden max-h-[90vh] flex flex-col">
            <div className="px-4 py-3 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-amber-400" />
                <span className="text-sm font-bold">
                  Stock Adjustment Record — {selectedRecord.override_id.slice(0, 8)}
                </span>
              </div>
              <button onClick={() => setSelectedRecord(null)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-4 overflow-y-auto text-xs font-sans">
              {/* Summary Header */}
              <div className="p-3 bg-teal-50 border border-teal-200 rounded-lg flex items-center justify-between">
                <div>
                  <div className="text-sm font-bold text-teal-950">{selectedRecord.medicine_name}</div>
                  <div className="text-[11px] text-teal-800">
                    {selectedRecord.shop_name} • {actionBadge(selectedRecord.action)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] uppercase font-bold text-teal-600">Result</div>
                  <div className="font-bold text-teal-900">{selectedRecord.result}</div>
                </div>
              </div>

              {/* All 22 Fields Grid */}
              <div className="grid grid-cols-2 gap-3 bg-slate-50 border border-slate-200 rounded-lg p-3">
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">1. Override ID</span>
                  <span className="font-mono text-slate-800 break-all">{selectedRecord.override_id}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">2. Command ID</span>
                  <span className="font-mono text-slate-800 break-all">{selectedRecord.command_id}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">3. Shop</span>
                  <span className="text-slate-800 font-medium">{selectedRecord.shop_name} ({selectedRecord.shop_id.slice(0, 8)})</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">4. Medicine</span>
                  <span className="text-slate-800 font-medium">{selectedRecord.medicine_name}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">5. SKU</span>
                  <span className="font-mono text-slate-800">{selectedRecord.sku || '—'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">6. Barcode</span>
                  <span className="font-mono text-slate-800">{selectedRecord.barcode || '—'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">7. Batch</span>
                  <span className="font-mono text-slate-800">{selectedRecord.batch_number || 'Default Batch'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">8. Expiry Date</span>
                  <span className="font-mono text-slate-800">{selectedRecord.expiry_date || '—'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">9. Administrator Name</span>
                  <span className="text-slate-800 font-medium">{selectedRecord.admin_name}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">10. Administrator Email</span>
                  <span className="text-slate-800 font-mono">{selectedRecord.admin_email}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">11. Action</span>
                  <span className="text-slate-800 font-bold">{selectedRecord.action}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">12. Online Quantity Shown</span>
                  <span className="font-mono text-slate-800">{selectedRecord.online_quantity_shown ?? '—'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">13. Actual Quantity Before</span>
                  <span className="font-mono text-slate-800 font-bold">{selectedRecord.local_quantity_before ?? selectedRecord.actual_quantity_before ?? 0}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">14. Requested Amount</span>
                  <span className="font-mono text-slate-800">{selectedRecord.requested_amount ?? '—'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">15. Actual Quantity After</span>
                  <span className="font-mono text-emerald-800 font-bold">{selectedRecord.local_quantity_after ?? selectedRecord.actual_quantity_after ?? 0}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">16. Difference</span>
                  <span className="font-mono text-slate-800 font-bold">{selectedRecord.difference ?? '—'}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">17. Reason</span>
                  <span className="text-slate-800">{selectedRecord.reason}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">18. Date Submitted</span>
                  <span className="font-mono text-slate-800">{selectedRecord.date_submitted ? new Date(selectedRecord.date_submitted).toLocaleString() : '—'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">19. Date Delivered</span>
                  <span className="font-mono text-slate-800">{selectedRecord.date_delivered ? new Date(selectedRecord.date_delivered).toLocaleString() : '—'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">20. Date Applied</span>
                  <span className="font-mono text-slate-800">{selectedRecord.date_applied ? new Date(selectedRecord.date_applied).toLocaleString() : '—'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">21. Date Cloud Confirmed</span>
                  <span className="font-mono text-slate-800">{selectedRecord.date_cloud_confirmed ? new Date(selectedRecord.date_cloud_confirmed).toLocaleString() : '—'}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">22. Stock Versions</span>
                  <span className="font-mono text-slate-800">
                    v{selectedRecord.stock_version_before ?? 1} → v{selectedRecord.stock_version_after ?? 2}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase font-semibold">Status / Result</span>
                  <span className="font-bold text-emerald-800">{selectedRecord.result}</span>
                </div>
              </div>
            </div>

            <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex justify-end">
              <button
                onClick={() => setSelectedRecord(null)}
                className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold hover:bg-slate-100"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
