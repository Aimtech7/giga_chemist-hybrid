import React, { useState, useEffect } from 'react';
import {
  PackageSearch,
  Boxes,
  FileSpreadsheet,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Plus,
  Search,
  Tag,
} from 'lucide-react';
import { db } from '../../db/dexie';
import { getInventoryValuation } from '../../services/inventoryEngine';
import { downloadCSV } from '../../services/exportUtils';
import { StockAdjustmentModal } from './StockAdjustmentModal';
import { PriceEditModal } from '../medicines/PriceEditModal';
import type { InventoryMovement, Medicine, PharmacySettings, User } from '../../types';

interface InventoryManagerProps {
  currentUser: User | null;
  settings: PharmacySettings;
}

export const InventoryManager: React.FC<InventoryManagerProps> = ({ currentUser, settings }) => {
  const [valuation, setValuation] = useState({
    totalItems: 0,
    totalQuantity: 0,
    purchaseValuation: 0,
    retailValuation: 0,
    lowStockCount: 0,
    outOfStockCount: 0,
  });

  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [search, setSearch] = useState('');
  const [reasonFilter, setReasonFilter] = useState('ALL');
  const [selectedMedForAdjustment, setSelectedMedForAdjustment] = useState<Medicine | null>(null);
  const [isPriceEditOpen, setIsPriceEditOpen] = useState(false);

  const isAdmin = currentUser?.role === 'ADMIN';

  const loadData = async () => {
    const val = await getInventoryValuation();
    setValuation(val);

    const movs = await db.inventory_movements.reverse().sortBy('timestamp');
    setMovements(movs);

    const meds = await db.medicines.where('status').equals('active').toArray();
    setMedicines(meds);
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleExportCSV = () => {
    const headers = [
      'Timestamp',
      'Date',
      'Medicine',
      'Batch #',
      'Previous Qty',
      'Adjustment',
      'New Qty',
      'Reason',
      'User',
      'Device ID',
      'Reference / Notes',
    ];

    const rows = movements.map((m) => [
      new Date(m.timestamp).toISOString(),
      m.date,
      m.medicine_name,
      m.batch_number,
      m.previous_quantity,
      m.adjustment_quantity,
      m.new_quantity,
      m.reason,
      m.user_name,
      m.device_id,
      m.notes || m.reference_id || '',
    ]);

    downloadCSV(
      `giga-chemist-stock-movements-${new Date().toISOString().split('T')[0]}.csv`,
      headers,
      rows
    );
  };

  const filtered = movements.filter((m) => {
    if (reasonFilter !== 'ALL' && m.reason !== reasonFilter) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      m.medicine_name.toLowerCase().includes(q) ||
      m.batch_number.toLowerCase().includes(q) ||
      m.user_name.toLowerCase().includes(q) ||
      (m.notes && m.notes.toLowerCase().includes(q))
    );
  });

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      <div className="p-4 bg-white border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 shrink-0">
        <div>
          <h1 className="text-base font-bold text-slate-900 tracking-tight">
            Inventory Movements
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Audit log of stock movements, purchases, dispensations, and reconciliation adjustments.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-medium transition cursor-pointer"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-slate-600" />
            <span>Export CSV</span>
          </button>

          {isAdmin && (
            <>
              <button
                onClick={() => setIsPriceEditOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-teal-700 bg-teal-50 hover:bg-teal-100 text-teal-800 text-xs font-semibold transition cursor-pointer"
                title="Search and adjust retail selling prices or cost prices"
              >
                <Tag className="w-3.5 h-3.5 text-teal-700" />
                <span>Edit Prices</span>
              </button>

              <button
                onClick={() => {
                  if (medicines.length > 0) setSelectedMedForAdjustment(medicines[0]);
                }}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold transition cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Stock Adjustment</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Valuation Metrics Header */}
      <div className="p-4 bg-white border-b border-slate-200 grid grid-cols-2 md:grid-cols-4 gap-3 shrink-0">
        <div>
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
            Total Inventory Units
          </div>
          <div className="text-lg font-bold font-mono text-slate-900 mt-0.5">
            {valuation.totalQuantity} units
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">{valuation.totalItems} active medicines</div>
        </div>

        <div>
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
            Cost Valuation
          </div>
          <div className="text-lg font-bold font-mono text-slate-800 mt-0.5">
            {settings.currency} {valuation.purchaseValuation.toFixed(2)}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">Cost price basis</div>
        </div>

        <div>
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
            Retail Valuation
          </div>
          <div className="text-lg font-bold font-mono text-teal-800 mt-0.5">
            {settings.currency} {valuation.retailValuation.toFixed(2)}
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5">
            Projected margin: {settings.currency} {(valuation.retailValuation - valuation.purchaseValuation).toFixed(2)}
          </div>
        </div>

        <div>
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
            Stock Health State
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs">
            <span className="text-amber-700 font-semibold">{valuation.lowStockCount} low</span>
            <span className="text-slate-300">·</span>
            <span className="text-rose-700 font-semibold">{valuation.outOfStockCount} depleted</span>
          </div>
        </div>
      </div>

      {/* Movement Table Filters */}
      <div className="p-3 bg-white border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
        <div className="relative w-full max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search medicine, batch, notes, staff..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
          />
        </div>

        <div className="flex items-center gap-2">
          <select
            value={reasonFilter}
            onChange={(e) => setReasonFilter(e.target.value)}
            className="py-1.5 px-2.5 border border-slate-300 rounded bg-white text-xs text-slate-700 font-medium"
          >
            <option value="ALL">All Movement Reasons</option>
            <option value="sale">Sales (POS)</option>
            <option value="purchase_receipt">Purchase Receipts</option>
            <option value="customer_return">Customer Returns</option>
            <option value="supplier_return">Supplier Returns</option>
            <option value="stock_adjustment">Manual Reconciliation</option>
            <option value="damage">Damaged Stock</option>
            <option value="expiry">Expired Stock Removal</option>
            <option value="loss">Loss / Pilferage</option>
            <option value="correction">Audit Correction</option>
          </select>

          <span className="text-slate-500 font-medium">{filtered.length} entries</span>
        </div>
      </div>

      {/* Movements Table */}
      <div className="flex-1 overflow-auto p-4">
        <div className="bg-white rounded border border-slate-200 overflow-hidden">
          <table className="w-full text-left text-xs text-slate-700">
            <thead className="bg-slate-50 uppercase text-[10px] font-semibold text-slate-600 border-b border-slate-200">
              <tr>
                <th className="py-2.5 px-3">Date</th>
                <th className="py-2.5 px-3">Medicine Formulation</th>
                <th className="py-2.5 px-3 font-mono">Batch #</th>
                <th className="py-2.5 px-3">Transaction Reason</th>
                <th className="py-2.5 px-3 text-right">Previous Qty</th>
                <th className="py-2.5 px-3 text-right">Adjustment</th>
                <th className="py-2.5 px-3 text-right">New Qty</th>
                <th className="py-2.5 px-3">Staff Actor</th>
                <th className="py-2.5 px-3">Audit Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-[11px]">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-400">
                    No stock movements recorded matching filter criteria.
                  </td>
                </tr>
              ) : (
                filtered.map((m) => (
                  <tr key={m.id} className="hover:bg-slate-50 transition">
                    <td className="py-2 px-3 font-mono text-slate-600 whitespace-nowrap">
                      <div>{m.date}</div>
                      <div className="text-[10px] text-slate-400">
                        {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </td>

                    <td className="py-2 px-3 font-semibold text-slate-900">{m.medicine_name}</td>

                    <td className="py-2 px-3 font-mono text-slate-700">
                      {m.batch_number}
                    </td>

                    <td className="py-2 px-3 text-slate-700 capitalize">
                      {/* Legacy imported movements may be cached with a NULL reason */}
                      {(m.reason || m.movement_type || 'UNSPECIFIED').replace(/_/g, ' ')}
                    </td>

                    <td className="py-2 px-3 text-right font-mono text-slate-500">
                      {m.previous_quantity}
                    </td>

                    <td className="py-2 px-3 text-right font-mono font-semibold">
                      <span
                        className={
                          m.adjustment_quantity < 0
                            ? 'text-rose-700'
                            : 'text-emerald-700'
                        }
                      >
                        {m.adjustment_quantity > 0 ? `+${m.adjustment_quantity}` : m.adjustment_quantity}
                      </span>
                    </td>

                    <td className="py-2 px-3 text-right font-mono font-bold text-slate-900">
                      {m.new_quantity}
                    </td>

                    <td className="py-2 px-3 text-slate-600">{m.user_name}</td>

                    <td className="py-2 px-3 text-slate-500 max-w-[200px] truncate">
                      {m.notes || m.reference_id || '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isAdmin && (
        <PriceEditModal
          isOpen={isPriceEditOpen}
          onClose={() => setIsPriceEditOpen(false)}
          medicinesList={medicines}
          settings={settings}
          currentUser={currentUser}
          onPriceUpdated={() => loadData()}
        />
      )}

      <StockAdjustmentModal
        isOpen={!!selectedMedForAdjustment}
        onClose={() => setSelectedMedForAdjustment(null)}
        medicine={selectedMedForAdjustment}
        settings={settings}
        currentUser={currentUser}
        onAdjusted={loadData}
      />
    </div>
  );
};
