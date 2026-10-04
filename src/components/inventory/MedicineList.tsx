import React, { useState, useEffect } from 'react';
import {
  Pill,
  Search,
  Plus,
  SlidersHorizontal,
  Edit2,
  PackagePlus,
  AlertTriangle,
  CheckCircle,
  FileSpreadsheet,
  Lock,
  Eye,
  Tag,
} from 'lucide-react';
import { db } from '../../db/dexie';
import { MedicineFormModal } from './MedicineFormModal';
import { StockAdjustmentModal } from './StockAdjustmentModal';
import { PriceEditModal } from '../medicines/PriceEditModal';
import { downloadCSV } from '../../services/exportUtils';
import { searchMedicines } from '../../services/searchEngine';
import { canViewCostData, isCashier } from '../../services/permissions';
import type { Category, Medicine, PharmacySettings, User } from '../../types';

interface MedicineListProps {
  currentUser: User | null;
  settings: PharmacySettings;
}

export const MedicineList: React.FC<MedicineListProps> = ({ currentUser, settings }) => {
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [categories, setCategories] = useState<Category[]>([]);
  const [stockFilter, setStockFilter] = useState<'all' | 'low' | 'out'>('all');

  // Modals
  const [editingMedicine, setEditingMedicine] = useState<Medicine | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [adjustingMedicine, setAdjustingMedicine] = useState<Medicine | null>(null);
  const [pricingMedicine, setPricingMedicine] = useState<Medicine | null>(null);
  const [isPriceEditOpen, setIsPriceEditOpen] = useState(false);

  const isAdmin = currentUser?.role === 'ADMIN';
  const showCost = canViewCostData(currentUser);
  const isCashierUser = isCashier(currentUser);

  const loadMedicines = async () => {
    const [list, cats] = await Promise.all([db.medicines.toArray(), db.categories.orderBy('name').toArray()]);
    setMedicines(list);
    setCategories(cats);
  };

  useEffect(() => {
    loadMedicines();
  }, []);

  const handleExportCSV = () => {
    const headers = [
      'Medicine Name',
      'Generic Name',
      'Brand',
      'Category',
      'Dosage Form',
      'Strength',
      'Barcode',
      'SKU',
      ...(showCost ? ['Cost Price'] : []),
      'Selling Price',
      'Current Stock',
      'Reorder Level',
      'Unit',
      'Status',
    ];

    const rows = medicines.map((m) => {
      const row = [
        m.name,
        m.generic_name,
        m.brand_name || '',
        m.category,
        m.dosage_form,
        m.dosage_strength,
        m.barcode,
        m.sku,
        ...(showCost ? [m.purchase_price] : []),
        m.selling_price,
        m.current_stock,
        m.reorder_level,
        m.unit,
        m.status,
      ];
      return row;
    });

    downloadCSV(
      `giga-chemist-medicines-${new Date().toISOString().split('T')[0]}.csv`,
      headers,
      rows
    );
  };

  const filtered = React.useMemo(() => {
    let pool = medicines;
    if (selectedCategory !== 'All') {
      pool = pool.filter((m) => m.category === selectedCategory);
    }
    if (stockFilter === 'out') {
      pool = pool.filter((m) => m.current_stock <= 0);
    } else if (stockFilter === 'low') {
      pool = pool.filter((m) => m.current_stock > 0 && m.current_stock <= m.reorder_level);
    }

    if (!search.trim()) return pool;
    return searchMedicines(search, pool);
  }, [medicines, selectedCategory, stockFilter, search]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      {/* Top action header */}
      <div className="p-4 bg-white border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold text-slate-900 tracking-tight">
              {isCashierUser ? 'Medicine Lookup' : 'Medicines Catalog'}
            </h1>
            {isCashierUser && (
              <span className="px-2 py-0.5 rounded bg-slate-100 border border-slate-200 text-slate-600 text-[10px] font-semibold">
                Read-Only Formulary
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            {isCashierUser
              ? 'Search available medicines, strength, active molecule, and retail selling price.'
              : 'Formulary, dosage strengths, manufacturer catalog, and pricing management.'}
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

          {isAdmin ? (
            <>
              <button
                onClick={() => {
                  setPricingMedicine(null);
                  setIsPriceEditOpen(true);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-teal-700 bg-teal-50 hover:bg-teal-100 text-teal-800 text-xs font-semibold transition cursor-pointer"
                title="Search and adjust retail selling price or cost price"
              >
                <Tag className="w-3.5 h-3.5 text-teal-700" />
                <span>Edit Prices</span>
              </button>

              <button
                onClick={() => {
                  setEditingMedicine(null);
                  setIsFormOpen(true);
                }}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold transition cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Add Medicine</span>
              </button>
            </>
          ) : isCashierUser ? (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-teal-50 text-teal-800 text-xs font-medium border border-teal-200">
              <Eye className="w-3.5 h-3.5 text-teal-700" />
              <span>Cashier View</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-slate-100 text-slate-500 text-xs font-medium border border-slate-200">
              <Lock className="w-3.5 h-3.5 text-slate-400" />
              <span>Catalog Read-Only</span>
            </div>
          )}
        </div>
      </div>

      {/* Filter and search bar */}
      <div className="p-3 bg-white border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
        <div className="flex items-center gap-2 flex-1 max-w-md">
          <div className="relative w-full">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search by name, generic, brand, barcode, SKU, or strength (e.g. PCM, 500mg)..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Category Filter */}
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="py-1.5 px-2.5 border border-slate-300 rounded bg-white text-xs text-slate-700 font-medium"
          >
            <option value="All">All Categories</option>
            {/* Hydrated from PostgreSQL categories; medicines carry the category name */}
            {categories.map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>

          {/* Stock state filter */}
          <div className="flex border border-slate-300 rounded overflow-hidden">
            <button
              onClick={() => setStockFilter('all')}
              className={`px-2.5 py-1 text-xs font-semibold ${
                stockFilter === 'all' ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'
              }`}
            >
              All ({medicines.length})
            </button>
            <button
              onClick={() => setStockFilter('low')}
              className={`px-2.5 py-1 text-xs font-semibold ${
                stockFilter === 'low' ? 'bg-amber-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'
              }`}
            >
              Low Stock
            </button>
            <button
              onClick={() => setStockFilter('out')}
              className={`px-2.5 py-1 text-xs font-semibold ${
                stockFilter === 'out' ? 'bg-rose-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'
              }`}
            >
              Out of Stock
            </button>
          </div>
        </div>
      </div>

      {/* Medicines Table */}
      <div className="flex-1 overflow-auto p-4">
        <div className="bg-white rounded border border-slate-200 overflow-hidden">
          <table className="w-full text-left text-xs text-slate-700">
            <thead className="bg-slate-50 text-slate-600 uppercase font-semibold text-[10px] tracking-wider border-b border-slate-200">
              <tr>
                <th className="py-2.5 px-3">Medicine &amp; Strength</th>
                <th className="py-2.5 px-3">Molecule / Generic</th>
                <th className="py-2.5 px-3">Category &amp; Form</th>
                <th className="py-2.5 px-3 font-mono">Barcode / SKU</th>
                {showCost && <th className="py-2.5 px-3 text-right">Cost Price</th>}
                <th className="py-2.5 px-3 text-right">Selling Price</th>
                <th className="py-2.5 px-3 text-right">Available Stock</th>
                <th className="py-2.5 px-3 text-center">Status</th>
                {!isCashierUser && <th className="py-2.5 px-3 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={showCost ? 9 : 8} className="py-12 text-center text-slate-400">
                    No medicines match the selected filter.
                  </td>
                </tr>
              ) : (
                filtered.map((m) => {
                  const isOut = m.current_stock <= 0;
                  const isLow = m.current_stock > 0 && m.current_stock <= m.reorder_level;

                  return (
                    <tr key={m.id} className="hover:bg-slate-50 transition">
                      <td className="py-2 px-3">
                        <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                          <span>{m.name}</span>
                          {m.dosage_strength && (
                            <span className="text-slate-500 font-normal">({m.dosage_strength})</span>
                          )}
                          {m.prescription_required && (
                            <span className="text-[10px] font-bold text-rose-700 bg-rose-50 px-1 rounded border border-rose-200">
                              Rx
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-slate-400">{m.manufacturer}</div>
                      </td>

                      <td className="py-2 px-3 text-slate-600">
                        {m.generic_name}
                      </td>

                      <td className="py-2 px-3">
                        <div className="text-slate-800 font-medium">{m.category}</div>
                        <div className="text-[10px] text-slate-400">{m.dosage_form}</div>
                      </td>

                      <td className="py-2 px-3 font-mono text-[11px]">
                        <div className="text-slate-700">{m.barcode}</div>
                        <div className="text-[10px] text-slate-400">{m.sku}</div>
                      </td>

                      {showCost && (
                        <td className="py-2 px-3 text-right font-mono text-slate-600">
                          {settings.currency} {m.purchase_price.toFixed(2)}
                        </td>
                      )}

                      <td className="py-2 px-3 text-right font-mono font-bold text-slate-900">
                        {settings.currency} {m.selling_price.toFixed(2)}
                      </td>

                      <td className="py-2 px-3 text-right font-mono">
                        <span
                          className={`font-semibold ${
                            isOut
                              ? 'text-rose-700'
                              : isLow
                              ? 'text-amber-700'
                              : 'text-slate-800'
                          }`}
                        >
                          {m.current_stock}
                        </span>
                        <div className="text-[10px] text-slate-400">{m.unit}</div>
                      </td>

                      <td className="py-2 px-3 text-center">
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <span className={`w-1.5 h-1.5 rounded-full ${m.status === 'active' ? 'bg-emerald-600' : 'bg-slate-400'}`} />
                          <span className="capitalize text-slate-700">{m.status}</span>
                        </span>
                      </td>

                      {!isCashierUser && (
                        <td className="py-2 px-3 text-right">
                          {isAdmin ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() => {
                                  setPricingMedicine(m);
                                  setIsPriceEditOpen(true);
                                }}
                                className="p-1 rounded border border-teal-200 hover:bg-teal-50 text-teal-700 transition cursor-pointer"
                                title="Edit Price & Cost (Admin)"
                              >
                                <Tag className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => {
                                  setEditingMedicine(m);
                                  setIsFormOpen(true);
                                }}
                                className="p-1 rounded border border-slate-200 hover:bg-slate-100 text-slate-700 transition cursor-pointer"
                                title="Edit Full Details (Admin)"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => setAdjustingMedicine(m)}
                                className="p-1 rounded bg-slate-800 hover:bg-slate-900 text-white transition cursor-pointer"
                                title="Controlled Stock Adjustment (Admin)"
                              >
                                <PackagePlus className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ) : (
                            <span className="text-[10px] text-slate-400 italic">Read-only</span>
                          )}
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

      {/* Modals */}
      {isAdmin && (
        <>
          <PriceEditModal
            isOpen={isPriceEditOpen}
            onClose={() => {
              setIsPriceEditOpen(false);
              setPricingMedicine(null);
            }}
            medicine={pricingMedicine}
            medicinesList={medicines}
            settings={settings}
            currentUser={currentUser}
            onPriceUpdated={() => loadMedicines()}
          />

          <MedicineFormModal
            isOpen={isFormOpen}
            onClose={() => setIsFormOpen(false)}
            medicine={editingMedicine}
            settings={settings}
            currentUser={currentUser}
            onSaved={loadMedicines}
          />

          <StockAdjustmentModal
            isOpen={!!adjustingMedicine}
            onClose={() => setAdjustingMedicine(null)}
            medicine={adjustingMedicine}
            settings={settings}
            currentUser={currentUser}
            onAdjusted={loadMedicines}
          />
        </>
      )}
    </div>
  );
};
