import React, { useState, useEffect } from 'react';
import {
  X,
  Tag,
  DollarSign,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  ShieldAlert,
  Search,
  ArrowRight,
  Package,
} from 'lucide-react';
import { db } from '../../db/dexie';
import { apiUrl } from '../../services/api';
import { MedicineSelector } from '../common/MedicineSelector';
import type { Medicine, PharmacySettings, User } from '../../types';

interface PriceEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  medicine?: Medicine | null;
  medicinesList?: Medicine[];
  settings: PharmacySettings;
  currentUser: User | null;
  onPriceUpdated?: (updated: Medicine) => void;
}

export const PriceEditModal: React.FC<PriceEditModalProps> = ({
  isOpen,
  onClose,
  medicine,
  medicinesList = [],
  settings,
  currentUser,
  onPriceUpdated,
}) => {
  const [allMedicines, setAllMedicines] = useState<Medicine[]>(medicinesList);
  const [selectedMed, setSelectedMed] = useState<Medicine | null>(medicine || null);

  const [sellingPrice, setSellingPrice] = useState<string>('');
  const [purchasePrice, setPurchasePrice] = useState<string>('');
  const [reorderLevel, setReorderLevel] = useState<string>('');
  const [minSellingPrice, setMinSellingPrice] = useState<string>('');

  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isAdmin = currentUser?.role === 'ADMIN';

  // Load medicines if not provided
  useEffect(() => {
    if (isOpen) {
      if (medicinesList.length > 0) {
        setAllMedicines(medicinesList);
      } else {
        db.medicines.toArray().then(setAllMedicines);
      }
    }
  }, [isOpen, medicinesList]);

  // Sync state when medicine prop or selectedMed changes
  useEffect(() => {
    if (medicine) {
      setSelectedMed(medicine);
    }
  }, [medicine]);

  useEffect(() => {
    if (selectedMed) {
      setSellingPrice(selectedMed.selling_price.toString());
      setPurchasePrice(selectedMed.purchase_price ? selectedMed.purchase_price.toString() : '0');
      setReorderLevel(selectedMed.reorder_level ? selectedMed.reorder_level.toString() : '20');
      setMinSellingPrice(selectedMed.min_selling_price ? selectedMed.min_selling_price.toString() : selectedMed.selling_price.toString());
      setError(null);
      setSuccessMsg(null);
    }
  }, [selectedMed]);

  if (!isOpen) return null;

  // Strict RBAC gate
  if (!isAdmin) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
        <div className="bg-white p-6 rounded-lg max-w-sm text-center shadow-xl border border-slate-200">
          <ShieldAlert className="w-12 h-12 text-rose-600 mx-auto mb-3" />
          <h3 className="font-bold text-sm text-slate-900">Access Restricted — Admin Only</h3>
          <p className="text-xs text-slate-600 mt-2">
            Only users with the <strong className="text-rose-600 font-semibold">ADMIN</strong> role are authorized to view or edit purchase/cost prices, retail selling prices, and inventory reorder levels.
          </p>
          <button
            onClick={onClose}
            className="mt-5 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded text-xs font-semibold transition"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  // Live financial metrics
  const numSelling = parseFloat(sellingPrice);
  const numPurchase = parseFloat(purchasePrice);
  const numReorder = parseInt(reorderLevel, 10);

  const isValidSelling = !isNaN(numSelling) && isFinite(numSelling) && numSelling >= 0;
  const isValidPurchase = !isNaN(numPurchase) && isFinite(numPurchase) && numPurchase >= 0;

  const currentMarkup =
    selectedMed && selectedMed.purchase_price > 0
      ? (((selectedMed.selling_price - selectedMed.purchase_price) / selectedMed.purchase_price) * 100).toFixed(1)
      : '0.0';

  const newMarkup =
    isValidSelling && isValidPurchase && numPurchase > 0
      ? (((numSelling - numPurchase) / numPurchase) * 100).toFixed(1)
      : '0.0';

  const newUnitProfit = isValidSelling && isValidPurchase ? (numSelling - numPurchase).toFixed(2) : '0.00';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedMed) {
      setError('Please select a medicine to edit its price.');
      return;
    }

    if (!isValidSelling) {
      setError('Selling price must be a valid non-negative number.');
      return;
    }

    if (!isValidPurchase) {
      setError('Purchase/cost price must be a valid non-negative number.');
      return;
    }

    if (isNaN(numReorder) || numReorder < 0) {
      setError('Reorder level must be a valid positive integer.');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const roundedSelling = Math.round(numSelling * 100) / 100;
      const roundedPurchase = Math.round(numPurchase * 100) / 100;
      const roundedMinSelling = minSellingPrice ? Math.round(parseFloat(minSellingPrice) * 100) / 100 : roundedSelling;

      // 1. Send update to Backend API
      const res = await fetch(apiUrl(`/api/medicines/${selectedMed.id}/pricing`), {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': currentUser?.id || '',
          'x-user-role': currentUser?.role || 'ADMIN',
          'x-user-name': currentUser?.name || 'Admin',
        },
        body: JSON.stringify({
          selling_price: roundedSelling,
          purchase_price: roundedPurchase,
          reorder_level: numReorder,
          min_selling_price: roundedMinSelling,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}: Failed to update medicine pricing.`);
      }

      const resData = await res.json();
      const updatedMedicine: Medicine = resData.medicine || {
        ...selectedMed,
        selling_price: roundedSelling,
        purchase_price: roundedPurchase,
        reorder_level: numReorder,
        min_selling_price: roundedMinSelling,
        version: (selectedMed.version || 1) + 1,
        updated_at: new Date().toISOString(),
        updated_by: currentUser?.name || 'Admin',
      };

      // 2. Immediately update Dexie IndexedDB cache for POS & UI instantaneous sync
      await db.medicines.update(selectedMed.id, {
        selling_price: roundedSelling,
        purchase_price: roundedPurchase,
        reorder_level: numReorder,
        min_selling_price: roundedMinSelling,
        version: updatedMedicine.version,
        updated_at: updatedMedicine.updated_at,
        updated_by: updatedMedicine.updated_by,
      });

      // 3. Update in-memory list
      setAllMedicines((prev) =>
        prev.map((m) => (m.id === selectedMed.id ? updatedMedicine : m))
      );
      setSelectedMed(updatedMedicine);

      setSuccessMsg(`Price updated successfully for "${updatedMedicine.name}".`);
      onPriceUpdated?.(updatedMedicine);

      // Auto-close if this was opened for a single item
      if (medicine) {
        setTimeout(() => {
          onClose();
        }, 1200);
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred while updating price.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="p-4 bg-slate-900 text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded bg-teal-700 text-white">
              <Tag className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold tracking-wide">Edit Medicine Pricing (Admin Only)</h2>
              <p className="text-[11px] text-slate-300">
                Authoritatively adjust retail selling price, cost price, and reorder levels.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-4 overflow-y-auto space-y-4 flex-1 text-xs">
          {/* Universal Search Selector (if no preselected medicine or switching) */}
          {!medicine && (
            <div>
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                Select Medicine to Adjust:
              </label>
              <MedicineSelector
                medicines={allMedicines}
                selectedMedicineId={selectedMed?.id}
                onSelect={(med) => setSelectedMed(med)}
                placeholder="Search by name, generic, brand, strength, barcode, or SKU..."
                currency={settings.currency}
              />
            </div>
          )}

          {selectedMed && (
            <>
              {/* Medicine Identity Card */}
              <div className="p-3 bg-slate-50 border border-slate-200 rounded space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-bold text-sm text-slate-900 flex items-center gap-1.5">
                      <span>{selectedMed.name}</span>
                      {selectedMed.dosage_strength && (
                        <span className="text-slate-500 font-normal text-xs">
                          ({selectedMed.dosage_strength})
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-600 mt-0.5">
                      <span className="font-medium">Generic:</span> {selectedMed.generic_name}
                      {selectedMed.brand_name && ` · Brand: ${selectedMed.brand_name}`}
                    </div>
                  </div>
                  <span className="px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-700 font-mono text-[10px] font-semibold">
                    {selectedMed.category}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 pt-2 mt-2 border-t border-slate-200 text-[11px] font-mono">
                  <div>
                    <span className="text-slate-500 block text-[10px]">Barcode / SKU:</span>
                    <span className="text-slate-800">{selectedMed.barcode || selectedMed.sku}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-[10px]">Dosage Form:</span>
                    <span className="text-slate-800">{selectedMed.dosage_form}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-[10px]">Available Stock:</span>
                    <span className="text-slate-800 font-bold">{selectedMed.current_stock} {selectedMed.unit}</span>
                  </div>
                </div>
              </div>

              {/* Current vs New Pricing Grid */}
              <div className="grid grid-cols-2 gap-3">
                {/* Current Benchmark Card */}
                <div className="p-3 rounded border border-slate-200 bg-slate-50/70 space-y-2">
                  <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                    Current Pricing Benchmark
                  </div>
                  <div className="space-y-1.5 font-mono text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Cost / Purchase:</span>
                      <span className="font-semibold text-slate-700">
                        {settings.currency} {selectedMed.purchase_price.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Selling Price:</span>
                      <span className="font-bold text-slate-900">
                        {settings.currency} {selectedMed.selling_price.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between pt-1 border-t border-slate-200 text-[11px]">
                      <span className="text-slate-500">Current Margin:</span>
                      <span className="font-semibold text-teal-700">+{currentMarkup}%</span>
                    </div>
                    <div className="flex justify-between text-[11px]">
                      <span className="text-slate-500">Reorder Level:</span>
                      <span className="font-semibold text-slate-700">{selectedMed.reorder_level}</span>
                    </div>
                  </div>
                </div>

                {/* Live Projected Card */}
                <div className="p-3 rounded border border-teal-200 bg-teal-50/30 space-y-2">
                  <div className="text-[10px] font-bold text-teal-800 uppercase tracking-wider flex items-center gap-1">
                    <TrendingUp className="w-3 h-3 text-teal-700" />
                    <span>Projected Margin</span>
                  </div>
                  <div className="space-y-1.5 font-mono text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-500">New Profit / Unit:</span>
                      <span className={`font-bold ${parseFloat(newUnitProfit) < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>
                        {settings.currency} {newUnitProfit}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">New Markup:</span>
                      <span className={`font-bold ${parseFloat(newMarkup) < 0 ? 'text-rose-600' : 'text-teal-800'}`}>
                        {parseFloat(newMarkup) >= 0 ? `+${newMarkup}%` : `${newMarkup}%`}
                      </span>
                    </div>
                    <div className="flex justify-between pt-1 border-t border-teal-100 text-[11px]">
                      <span className="text-slate-500">Immediate POS Update:</span>
                      <span className="font-semibold text-teal-700">YES</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Pricing Edit Form */}
              <form onSubmit={handleSubmit} className="space-y-3 pt-2">
                <div className="grid grid-cols-2 gap-3">
                  {/* Selling Price */}
                  <div>
                    <label className="block text-xs font-bold text-slate-800 mb-1 flex items-center gap-1">
                      <DollarSign className="w-3.5 h-3.5 text-teal-700" />
                      <span>New Selling Price ({settings.currency}) *</span>
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      required
                      value={sellingPrice}
                      onChange={(e) => setSellingPrice(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded font-mono font-bold text-sm text-slate-900 bg-white focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                      placeholder="e.g. 100.00"
                      autoFocus
                    />
                    <span className="text-[10px] text-slate-400 mt-0.5 block">
                      Price billed at register / POS.
                    </span>
                  </div>

                  {/* Purchase Price */}
                  <div>
                    <label className="block text-xs font-bold text-slate-800 mb-1 flex items-center gap-1">
                      <Package className="w-3.5 h-3.5 text-slate-600" />
                      <span>New Cost / Purchase Price ({settings.currency}) *</span>
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      required
                      value={purchasePrice}
                      onChange={(e) => setPurchasePrice(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded font-mono font-bold text-sm text-slate-900 bg-white focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                      placeholder="e.g. 65.00"
                    />
                    <span className="text-[10px] text-slate-400 mt-0.5 block">
                      Cost basis for gross margin reports.
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {/* Reorder Level */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Reorder Threshold (Units)
                    </label>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      value={reorderLevel}
                      onChange={(e) => setReorderLevel(e.target.value)}
                      className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono text-xs text-slate-800 bg-white focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                      placeholder="e.g. 20"
                    />
                    <span className="text-[10px] text-slate-400 mt-0.5 block">
                      Flags "Low Stock" when stock &le; threshold.
                    </span>
                  </div>

                  {/* Min Selling Price */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Minimum Selling Price ({settings.currency})
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={minSellingPrice}
                      onChange={(e) => setMinSellingPrice(e.target.value)}
                      className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono text-xs text-slate-800 bg-white focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                      placeholder="Floor price for discounts"
                    />
                    <span className="text-[10px] text-slate-400 mt-0.5 block">
                      Lowest allowable discounted price.
                    </span>
                  </div>
                </div>

                {/* Loss-Leader Warning */}
                {isValidSelling && isValidPurchase && numSelling < numPurchase && (
                  <div className="p-2 rounded bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2 animate-fadeIn">
                    <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                    <span>
                      <strong>Warning:</strong> Selling price ({settings.currency} {numSelling.toFixed(2)}) is lower than cost price ({settings.currency} {numPurchase.toFixed(2)}), resulting in a loss of {settings.currency} {(numPurchase - numSelling).toFixed(2)} per unit.
                    </span>
                  </div>
                )}

                {error && (
                  <div className="p-2.5 rounded bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2 animate-fadeIn">
                    <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                {successMsg && (
                  <div className="p-2.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2 animate-fadeIn">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span>{successMsg}</span>
                  </div>
                )}

                <div className="pt-3 border-t border-slate-200 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-3.5 py-2 rounded border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold transition cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting || !isValidSelling || !isValidPurchase}
                    className="px-4 py-2 rounded bg-teal-700 hover:bg-teal-800 text-white text-xs font-bold transition flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
                  >
                    {isSubmitting ? (
                      <span>Saving Price...</span>
                    ) : (
                      <>
                        <CheckCircle2 className="w-4 h-4" />
                        <span>Save Pricing (Immediate)</span>
                      </>
                    )}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
