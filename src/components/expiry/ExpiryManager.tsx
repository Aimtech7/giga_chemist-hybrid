import React, { useState, useEffect } from 'react';
import {
  AlertTriangle,
  Flame,
  Archive,
  RotateCcw,
  ShieldAlert,
  CheckCircle,
  FileSpreadsheet,
  AlertCircle,
  Clock,
  Calendar,
  Search,
} from 'lucide-react';
import { db } from '../../db/dexie';
import { disposeOrQuarantineBatch } from '../../services/inventoryEngine';
import { isExpired, getDaysUntilExpiry, normalizeExpiryDate } from '../../utils/expiry';
import { downloadCSV } from '../../services/exportUtils';
import { StockAdjustmentModal } from '../inventory/StockAdjustmentModal';
import type { MedicineBatch, PharmacySettings, User, Medicine } from '../../types';

interface ExpiryManagerProps {
  currentUser: User | null;
  settings: PharmacySettings;
}

type ExpiryCategory = 'all' | 'expired' | 'within30' | 'within90' | 'safe' | 'unknown';

export const ExpiryManager: React.FC<ExpiryManagerProps> = ({ currentUser, settings }) => {
  const [batches, setBatches] = useState<MedicineBatch[]>([]);
  const [activeTab, setActiveTab] = useState<ExpiryCategory>('expired');
  const [search, setSearch] = useState('');
  const [selectedBatch, setSelectedBatch] = useState<MedicineBatch | null>(null);
  const [disposalAction, setDisposalAction] = useState<'destroy' | 'quarantine' | 'return_to_supplier' | 'remove'>('destroy');
  const [disposalNotes, setDisposalNotes] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Stock Adjustment / Expiry Modal State
  const [expiryModalOpen, setExpiryModalOpen] = useState(false);
  const [selectedMedicineForExpiry, setSelectedMedicineForExpiry] = useState<Medicine | null>(null);

  const isAdmin = currentUser?.role === 'ADMIN';

  const loadBatches = async () => {
    const list = await db.medicine_batches.toArray();
    setBatches(list);
  };

  useEffect(() => {
    loadBatches();
  }, []);

  const today = new Date();

  // Categorize batches using normalized expiry logic
  const categorizeBatch = (b: MedicineBatch): ExpiryCategory => {
    if (!b.expiry_date || b.expiry_status === 'UNKNOWN' || b.expiry_date === 'UNKNOWN' || b.expiry_date === '2099-12-31') {
      return 'unknown';
    }
    const diffDays = getDaysUntilExpiry(b.expiry_date, today);

    if (diffDays <= 0) return 'expired';
    if (diffDays <= 30) return 'within30';
    if (diffDays <= 90) return 'within90';
    return 'safe';
  };

  const categorizedBatches = {
    all: batches.filter((b) => b.quantity_available > 0),
    expired: batches.filter((b) => b.quantity_available > 0 && categorizeBatch(b) === 'expired'),
    within30: batches.filter((b) => b.quantity_available > 0 && categorizeBatch(b) === 'within30'),
    within90: batches.filter((b) => b.quantity_available > 0 && categorizeBatch(b) === 'within90'),
    safe: batches.filter((b) => b.quantity_available > 0 && categorizeBatch(b) === 'safe'),
    unknown: batches.filter((b) => b.quantity_available > 0 && categorizeBatch(b) === 'unknown'),
  };

  const handleOpenExpiryModal = async (batch?: MedicineBatch) => {
    if (batch) {
      const med = await db.medicines.get(batch.medicine_id);
      setSelectedMedicineForExpiry(med || null);
    } else {
      setSelectedMedicineForExpiry(null);
    }
    setExpiryModalOpen(true);
  };

  const handleExecuteDisposal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBatch || !currentUser) return;
    if (!isAdmin) {
      alert('Only administrators can quarantine or dispose of expired medicine.');
      return;
    }

    setIsProcessing(true);
    try {
      await disposeOrQuarantineBatch({
        batchId: selectedBatch.id,
        action: disposalAction,
        reasonNotes: disposalNotes.trim() || `Marked as ${disposalAction} via Expiry Manager`,
        user: currentUser,
      });

      setActionSuccess(`Batch ${selectedBatch.batch_number} successfully processed as ${disposalAction}.`);
      setSelectedBatch(null);
      setDisposalNotes('');
      await loadBatches();
      setTimeout(() => setActionSuccess(null), 3500);
    } catch (err: any) {
      alert(err?.message || 'Failed to process batch.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleExportCSV = () => {
    const targetBatches = categorizedBatches[activeTab];
    const headers = [
      'Batch Number',
      'Medicine Name',
      'Supplier',
      'Available Qty',
      'Expiry Date',
      'Category',
      'Loss Value (KES)',
    ];

    const rows = targetBatches.map((b) => [
      b.batch_number,
      b.medicine_name,
      b.supplier_name,
      b.quantity_available,
      b.expiry_date,
      activeTab.toUpperCase(),
      (b.quantity_available * b.purchase_price).toFixed(2),
    ]);

    downloadCSV(`giga-chemist-expiry-report-${activeTab}-${new Date().toISOString().split('T')[0]}.csv`, headers, rows);
  };

  const filteredBatches = React.useMemo(() => {
    let pool = categorizedBatches[activeTab];
    if (!search.trim()) return pool;
    const q = search.toLowerCase();
    return pool.filter(
      (b) =>
        b.batch_number.toLowerCase().includes(q) ||
        b.medicine_name.toLowerCase().includes(q) ||
        (b.supplier_name && b.supplier_name.toLowerCase().includes(q))
    );
  }, [categorizedBatches, activeTab, search]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      {/* Header */}
      <div className="p-4 bg-white border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 shrink-0">
        <div>
          <h1 className="text-base font-bold text-slate-900 tracking-tight">
            Expiry Management & Tracking
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Strict POS block on expired medicines, 30/90-day alert thresholds, unknown expiry management, and disposal audit trail.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isAdmin && (
            <button
              onClick={() => handleOpenExpiryModal()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold transition cursor-pointer"
            >
              <Calendar className="w-4 h-4" />
              <span>Edit Batch Expiry</span>
            </button>
          )}

          <button
            onClick={handleExportCSV}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-medium transition cursor-pointer"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-slate-600" />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {actionSuccess && (
        <div className="mx-4 mt-3 p-3 bg-emerald-50 border border-emerald-300 text-emerald-800 rounded text-xs flex items-center gap-2">
          <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{actionSuccess}</span>
        </div>
      )}

      {/* Prominent Search Bar & Category Filter Tabs */}
      <div className="p-3 bg-white border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
        <div className="relative w-full max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search medicine name, batch number..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
          />
        </div>

        {/* Expiry Category Tabs */}
        <div className="flex border border-slate-300 rounded overflow-hidden text-xs">
          <button
            onClick={() => setActiveTab('expired')}
            className={`px-3 py-1.5 font-semibold transition whitespace-nowrap cursor-pointer ${
              activeTab === 'expired'
                ? 'bg-rose-700 text-white'
                : 'bg-white text-slate-600 hover:bg-slate-100'
            }`}
          >
            <span>Expired ({categorizedBatches.expired.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('within30')}
            className={`px-3 py-1.5 font-semibold transition whitespace-nowrap cursor-pointer ${
              activeTab === 'within30'
                ? 'bg-amber-700 text-white'
                : 'bg-white text-slate-600 hover:bg-slate-100'
            }`}
          >
            <span>Expiring Soon ({categorizedBatches.within30.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('within90')}
            className={`px-3 py-1.5 font-semibold transition whitespace-nowrap cursor-pointer ${
              activeTab === 'within90'
                ? 'bg-slate-800 text-white'
                : 'bg-white text-slate-600 hover:bg-slate-100'
            }`}
          >
            <span>&le; 90 Days ({categorizedBatches.within90.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('safe')}
            className={`px-3 py-1.5 font-semibold transition whitespace-nowrap cursor-pointer ${
              activeTab === 'safe'
                ? 'bg-teal-700 text-white'
                : 'bg-white text-slate-600 hover:bg-slate-100'
            }`}
          >
            <span>Valid Stock ({categorizedBatches.safe.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('unknown')}
            className={`px-3 py-1.5 font-semibold transition whitespace-nowrap cursor-pointer ${
              activeTab === 'unknown'
                ? 'bg-purple-700 text-white'
                : 'bg-white text-slate-600 hover:bg-slate-100'
            }`}
          >
            <span>Unknown Expiry ({categorizedBatches.unknown.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('all')}
            className={`px-3 py-1.5 font-semibold transition whitespace-nowrap cursor-pointer ${
              activeTab === 'all'
                ? 'bg-slate-900 text-white'
                : 'bg-white text-slate-600 hover:bg-slate-100'
            }`}
          >
            <span>All ({categorizedBatches.all.length})</span>
          </button>
        </div>
      </div>

      {/* Main Table */}
      <div className="flex-1 overflow-auto p-4">
        <div className="bg-white rounded border border-slate-200 overflow-hidden">
          <table className="w-full text-left text-xs text-slate-700">
            <thead className="bg-slate-50 text-slate-600 uppercase font-semibold text-[10px] tracking-wider border-b border-slate-200">
              <tr>
                <th className="py-2.5 px-3 font-mono">Batch Number</th>
                <th className="py-2.5 px-3">Medicine Formulation</th>
                <th className="py-2.5 px-3">Supplier Name</th>
                <th className="py-2.5 px-3 text-right">Available Qty</th>
                <th className="py-2.5 px-3 text-right">Cost Value</th>
                <th className="py-2.5 px-3">Expiry Date</th>
                <th className="py-2.5 px-3 text-center">POS Status</th>
                <th className="py-2.5 px-3 text-right">Admin Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredBatches.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400">
                    No batches match the selected criteria.
                  </td>
                </tr>
              ) : (
                filteredBatches.map((b) => {
                  const isUnknown = !b.expiry_date || b.expiry_status === 'UNKNOWN' || b.expiry_date === 'UNKNOWN' || b.expiry_date === '2099-12-31';
                  const daysToExpiry = isUnknown
                    ? null
                    : Math.ceil((new Date(b.expiry_date).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
                  const isExpired = daysToExpiry !== null && daysToExpiry <= 0;

                  return (
                    <tr key={b.id} className="hover:bg-slate-50 transition">
                      <td className="py-2 px-3 font-mono font-semibold text-slate-900">
                        {b.batch_number}
                      </td>

                      <td className="py-2 px-3 font-medium text-slate-900">
                        {b.medicine_name}
                      </td>

                      <td className="py-2 px-3 text-slate-600">
                        {b.supplier_name || '—'}
                      </td>

                      <td className="py-2 px-3 text-right font-mono font-bold text-slate-900">
                        {b.quantity_available}
                      </td>

                      <td className="py-2 px-3 text-right font-mono text-slate-600">
                        {settings.currency} {(b.quantity_available * b.purchase_price).toFixed(2)}
                      </td>

                      <td className="py-2 px-3 font-mono">
                        {isUnknown ? (
                          <span className="px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200 text-[10px] font-semibold">
                            UNKNOWN
                          </span>
                        ) : (
                          <>
                            <span
                              className={`font-semibold ${
                                isExpired
                                  ? 'text-rose-700'
                                  : (daysToExpiry ?? 999) <= 30
                                  ? 'text-amber-700'
                                  : 'text-slate-800'
                              }`}
                            >
                              {b.expiry_date}
                            </span>
                            <span className="ml-1 text-[10px] text-slate-500">
                              ({isExpired ? `${Math.abs(daysToExpiry!)}d ago` : `${daysToExpiry}d left`})
                            </span>
                          </>
                        )}
                      </td>

                      <td className="py-2 px-3 text-center">
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <span className={`w-1.5 h-1.5 rounded-full ${isExpired ? 'bg-rose-600' : isUnknown ? 'bg-purple-600' : 'bg-emerald-600'}`} />
                          <span className={isExpired ? 'text-rose-700 font-semibold' : isUnknown ? 'text-purple-700 font-semibold' : 'text-slate-700'}>
                            {isExpired ? 'Blocked from sale' : isUnknown ? 'Unknown Expiry' : 'FEFO Active'}
                          </span>
                        </span>
                      </td>

                      <td className="py-2 px-3 text-right">
                        {isAdmin ? (
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              onClick={() => handleOpenExpiryModal(b)}
                              className="px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 text-slate-700 font-semibold text-[10px] transition cursor-pointer"
                              title="Edit Expiry Date"
                            >
                              Edit Expiry
                            </button>

                            <button
                              onClick={() => setSelectedBatch(b)}
                              className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-900 text-white font-medium text-[10px] transition cursor-pointer"
                              title="Quarantine / Dispose"
                            >
                              Dispose
                            </button>
                          </div>
                        ) : (
                          <span className="text-[10px] text-slate-400 italic">Admin only</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Expiry Modal */}
      <StockAdjustmentModal
        isOpen={expiryModalOpen}
        onClose={() => setExpiryModalOpen(false)}
        medicine={selectedMedicineForExpiry}
        settings={settings}
        currentUser={currentUser}
        initialTab="EDIT_EXPIRY"
        onAdjusted={() => loadBatches()}
      />

      {/* DISPOSAL / QUARANTINE MODAL */}
      {selectedBatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="w-full max-w-md bg-white rounded border border-slate-300 shadow-lg overflow-hidden text-slate-800">
            <div className="bg-slate-900 px-4 py-3 text-white flex justify-between items-center">
              <span className="font-bold text-xs">
                Quarantine &amp; Disposal Action
              </span>
              <button
                onClick={() => setSelectedBatch(null)}
                className="text-slate-400 hover:text-white p-1 rounded cursor-pointer"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleExecuteDisposal} className="p-4 space-y-3 text-xs">
              <div className="p-3 bg-slate-50 rounded border border-slate-200">
                <div className="font-bold text-slate-900">{selectedBatch.medicine_name}</div>
                <div className="text-[11px] font-mono text-slate-600 mt-0.5">
                  Batch: {selectedBatch.batch_number} · Quantity: {selectedBatch.quantity_available} units
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  Expiry Date: {selectedBatch.expiry_date}
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1.5">Select Action *</label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: 'quarantine', label: 'Quarantine Batch' },
                    { id: 'destroy', label: 'Destroy / Incinerate' },
                    { id: 'return_to_supplier', label: 'Return to Supplier' },
                    { id: 'remove', label: 'Remove from Inventory' },
                  ].map((act) => (
                    <button
                      key={act.id}
                      type="button"
                      onClick={() => setDisposalAction(act.id as any)}
                      className={`p-2 rounded border text-center font-medium text-xs transition cursor-pointer ${
                        disposalAction === act.id
                          ? 'bg-teal-700 text-white border-teal-700 font-semibold'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      {act.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Disposal / Quarantine Audit Justification *
                </label>
                <textarea
                  required
                  rows={2}
                  value={disposalNotes}
                  onChange={(e) => setDisposalNotes(e.target.value)}
                  placeholder="e.g. Returned to supplier under credit agreement"
                  className="w-full p-2 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setSelectedBatch(null)}
                  className="px-3 py-1.5 rounded border border-slate-300 text-slate-700 font-medium cursor-pointer hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isProcessing}
                  className="px-4 py-1.5 rounded bg-rose-700 hover:bg-rose-800 text-white font-semibold cursor-pointer disabled:opacity-50"
                >
                  {isProcessing ? 'Executing...' : 'Confirm Action'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
