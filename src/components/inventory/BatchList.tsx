import React, { useState, useEffect } from 'react';
import { Boxes, Search, AlertTriangle, ShieldCheck, Filter, FileSpreadsheet, Edit3, Sliders, Plus } from 'lucide-react';
import { db } from '../../db/dexie';
import { downloadCSV } from '../../services/exportUtils';
import { StockAdjustmentModal, type StockOperationTab } from './StockAdjustmentModal';
import type { MedicineBatch, PharmacySettings, User, Medicine } from '../../types';

interface BatchListProps {
  currentUser: User | null;
  settings: PharmacySettings;
}

export const BatchList: React.FC<BatchListProps> = ({ currentUser, settings }) => {
  const [batches, setBatches] = useState<MedicineBatch[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'exhausted' | 'quarantined'>('all');

  // Stock Adjustment Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMedicine, setModalMedicine] = useState<Medicine | null>(null);
  const [modalTab, setModalTab] = useState<StockOperationTab>('SET_STOCK');

  const isAdmin = currentUser?.role === 'ADMIN';

  const loadBatches = async () => {
    const list = await db.medicine_batches.toArray();
    setBatches(list);
  };

  const handleOpenBatchModal = async (batch: MedicineBatch, tab: StockOperationTab) => {
    const med = await db.medicines.get(batch.medicine_id);
    setModalMedicine(med || null);
    setModalTab(tab);
    setModalOpen(true);
  };

  useEffect(() => {
    loadBatches();
  }, []);

  const todayStr = new Date().toISOString().split('T')[0];

  const handleExportCSV = () => {
    const headers = [
      'Batch Number',
      'Medicine Name',
      'Supplier',
      'Qty Received',
      'Qty Available',
      'Cost Price',
      'Manufacturing Date',
      'Expiry Date',
      'Invoice #',
      'Status',
    ];

    const rows = batches.map((b) => [
      b.batch_number,
      b.medicine_name,
      b.supplier_name,
      b.quantity_received,
      b.quantity_available,
      b.purchase_price,
      b.manufacturing_date,
      b.expiry_date,
      b.purchase_invoice,
      b.status,
    ]);

    downloadCSV(
      `giga-chemist-batches-${new Date().toISOString().split('T')[0]}.csv`,
      headers,
      rows
    );
  };

  const filtered = batches.filter((b) => {
    if (statusFilter !== 'all' && b.status !== statusFilter) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      b.batch_number.toLowerCase().includes(q) ||
      b.medicine_name.toLowerCase().includes(q) ||
      b.supplier_name.toLowerCase().includes(q) ||
      b.purchase_invoice.toLowerCase().includes(q)
    );
  });

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      <div className="p-4 bg-white border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 shrink-0">
        <div>
          <h1 className="text-base font-bold text-slate-900 tracking-tight">
            Batches
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Batch tracking, manufacturer lot numbers, and First Expiry First Out (FEFO) dispensing.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isAdmin && (
            <button
              onClick={() => {
                setModalMedicine(null);
                setModalTab('ADD_STOCK');
                setModalOpen(true);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold transition cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Add Batch / Stock</span>
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

      {/* Filter and search */}
      <div className="p-3 bg-white border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
        <div className="relative w-full max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search batch number, medicine, supplier..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
          />
        </div>

        <div className="flex border border-slate-300 rounded overflow-hidden">
          <button
            onClick={() => setStatusFilter('all')}
            className={`px-3 py-1 text-xs font-semibold ${
              statusFilter === 'all' ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'
            }`}
          >
            All ({batches.length})
          </button>
          <button
            onClick={() => setStatusFilter('active')}
            className={`px-3 py-1 text-xs font-semibold ${
              statusFilter === 'active' ? 'bg-emerald-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'
            }`}
          >
            Active Stock
          </button>
          <button
            onClick={() => setStatusFilter('exhausted')}
            className={`px-3 py-1 text-xs font-semibold ${
              statusFilter === 'exhausted' ? 'bg-slate-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'
            }`}
          >
            Depleted
          </button>
          <button
            onClick={() => setStatusFilter('quarantined')}
            className={`px-3 py-1 text-xs font-semibold ${
              statusFilter === 'quarantined' ? 'bg-rose-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'
            }`}
          >
            Quarantined
          </button>
        </div>
      </div>

      {/* Batch Table */}
      <div className="flex-1 overflow-auto p-4">
        <div className="bg-white rounded border border-slate-200 overflow-hidden">
          <table className="w-full text-left text-xs text-slate-700">
            <thead className="bg-slate-50 text-slate-600 uppercase font-semibold text-[10px] tracking-wider border-b border-slate-200">
              <tr>
                <th className="py-2.5 px-3 font-mono">Batch Number</th>
                <th className="py-2.5 px-3">Medicine Formulation</th>
                <th className="py-2.5 px-3">Supplier & Invoice</th>
                <th className="py-2.5 px-3 text-right">Received Qty</th>
                <th className="py-2.5 px-3 text-right">Available Qty</th>
                <th className="py-2.5 px-3 text-right">Unit Cost</th>
                <th className="py-2.5 px-3">Mfg Date</th>
                <th className="py-2.5 px-3">Expiry Date</th>
                <th className="py-2.5 px-3 text-center">Batch Status</th>
                {isAdmin && <th className="py-2.5 px-3 text-right">Admin Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={isAdmin ? 10 : 9} className="py-12 text-center text-slate-400">
                    No batches found.
                  </td>
                </tr>
              ) : (
                filtered.map((b) => {
                  const isExpired = b.expiry_date <= todayStr;
                  const daysToExpiry = Math.ceil(
                    (new Date(b.expiry_date).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
                  );
                  const isExpiringSoon = daysToExpiry > 0 && daysToExpiry <= 30;

                  return (
                    <tr key={b.id} className="hover:bg-slate-50 transition">
                      <td className="py-2 px-3 font-mono font-semibold text-slate-900">
                        {b.batch_number}
                      </td>

                      <td className="py-2 px-3 font-medium text-slate-900">
                        {b.medicine_name}
                      </td>

                      <td className="py-2 px-3">
                        <div className="text-slate-800">{b.supplier_name}</div>
                        <div className="text-[10px] text-slate-400 font-mono">Inv: {b.purchase_invoice}</div>
                      </td>

                      <td className="py-2 px-3 text-right font-mono text-slate-600">
                        {b.quantity_received}
                      </td>

                      <td className="py-2 px-3 text-right font-mono font-bold text-slate-900">
                        {b.quantity_available}
                      </td>

                      <td className="py-2 px-3 text-right font-mono text-slate-600">
                        {settings.currency} {b.purchase_price.toFixed(2)}
                      </td>

                      <td className="py-2 px-3 font-mono text-[11px] text-slate-500">
                        {b.manufacturing_date}
                      </td>

                      <td className="py-2 px-3 font-mono text-[11px]">
                        <span
                          className={`font-semibold ${
                            isExpired
                              ? 'text-rose-700'
                              : isExpiringSoon
                              ? 'text-amber-700'
                              : 'text-slate-800'
                          }`}
                        >
                          {b.expiry_date}
                        </span>
                        {isExpired && (
                          <span className="ml-1 text-[10px] font-bold text-rose-700">
                            (Expired)
                          </span>
                        )}
                        {isExpiringSoon && (
                          <span className="ml-1 text-[10px] text-amber-700">
                            ({daysToExpiry}d)
                          </span>
                        )}
                      </td>

                      <td className="py-2 px-3 text-center">
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              isExpired
                                ? 'bg-rose-600'
                                : b.status === 'active'
                                ? 'bg-emerald-600'
                                : b.status === 'quarantined'
                                ? 'bg-purple-600'
                                : 'bg-slate-400'
                            }`}
                          />
                          <span className="capitalize text-slate-700">
                            {isExpired ? 'Expired' : b.status}
                          </span>
                        </span>
                      </td>

                      {isAdmin && (
                        <td className="py-2 px-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              onClick={() => handleOpenBatchModal(b, 'SET_STOCK')}
                              className="px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 text-slate-700 font-semibold text-[10px] flex items-center gap-1 cursor-pointer"
                              title="Set / Adjust Batch Stock"
                            >
                              <Sliders className="w-3 h-3 text-teal-700" />
                              <span>Set Stock</span>
                            </button>

                            <button
                              onClick={() => handleOpenBatchModal(b, 'EDIT_EXPIRY')}
                              className="px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 text-slate-700 font-semibold text-[10px] flex items-center gap-1 cursor-pointer"
                              title="Edit Batch Expiry"
                            >
                              <Edit3 className="w-3 h-3 text-sky-700" />
                              <span>Edit Expiry</span>
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Stock & Expiry Modal */}
      <StockAdjustmentModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        medicine={modalMedicine}
        settings={settings}
        currentUser={currentUser}
        initialTab={modalTab}
        onAdjusted={() => loadBatches()}
      />
    </div>
  );
};
