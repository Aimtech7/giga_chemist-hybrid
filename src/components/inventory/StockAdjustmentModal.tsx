import React, { useState, useEffect } from 'react';
import {
  PackageSearch,
  X,
  AlertTriangle,
  ShieldAlert,
  Plus,
  Minus,
  Sliders,
  Calendar,
  Layers,
  CheckCircle2,
} from 'lucide-react';
import { db, getDeviceId } from '../../db/dexie';
import { apiUrl } from '../../services/api';
import { getAuthHeaders } from '../../services/auth';
import { applyServerStockResult, refreshCacheAfterCommit } from '../../services/stockCache';
import { MedicineSelector } from '../common/MedicineSelector';
import type { Medicine, MedicineBatch, PharmacySettings, User, Supplier } from '../../types';
import { apiFetch } from '../../services/http';

export type StockOperationTab = 'SET_STOCK' | 'ADD_STOCK' | 'REMOVE_STOCK' | 'EDIT_EXPIRY';

interface StockAdjustmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  medicine: Medicine | null;
  settings: PharmacySettings;
  currentUser: User | null;
  onAdjusted: () => void;
  initialTab?: StockOperationTab;
}

export const StockAdjustmentModal: React.FC<StockAdjustmentModalProps> = ({
  isOpen,
  onClose,
  medicine: initialMedicine,
  settings,
  currentUser,
  onAdjusted,
  initialTab = 'SET_STOCK',
}) => {
  const [activeTab, setActiveTab] = useState<StockOperationTab>(initialTab);
  const [activeMedicine, setActiveMedicine] = useState<Medicine | null>(initialMedicine);
  const [allMedicines, setAllMedicines] = useState<Medicine[]>([]);
  const [batches, setBatches] = useState<MedicineBatch[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);

  // Form states
  // 1. SET STOCK
  const [selectedBatchId, setSelectedBatchId] = useState<string>('');
  const [exactStock, setExactStock] = useState<string>('');
  const [setStockReason, setSetStockReason] = useState<string>('Physical stock count correction');
  const [setStockNotes, setSetStockNotes] = useState<string>('');

  // 2. ADD STOCK
  const [addQty, setAddQty] = useState<string>('');
  const [addBatchNum, setAddBatchNum] = useState<string>('');
  const [addExpiry, setAddExpiry] = useState<string>('');
  const [addSupplierId, setAddSupplierId] = useState<string>('');
  const [addPurchasePrice, setAddPurchasePrice] = useState<string>('');
  const [addSellingPrice, setAddSellingPrice] = useState<string>('');
  const [addNotes, setAddNotes] = useState<string>('');

  // 3. REMOVE STOCK
  const [removeBatchId, setRemoveBatchId] = useState<string>('');
  const [removeQty, setRemoveQty] = useState<string>('');
  const [removeReason, setRemoveReason] = useState<string>('Damaged');
  const [removeNotes, setRemoveNotes] = useState<string>('');

  // 4. EDIT EXPIRY
  const [expiryBatchId, setExpiryBatchId] = useState<string>('');
  const [newExpiryDate, setNewExpiryDate] = useState<string>('');
  const [isExpiryUnknown, setIsExpiryUnknown] = useState<boolean>(false);

  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Load all medicines and suppliers for searchable selection
  useEffect(() => {
    async function loadData() {
      try {
        const meds = await db.medicines.where('status').equals('active').toArray();
        setAllMedicines(meds);
        const supps = await db.suppliers.toArray();
        setSuppliers(supps);
      } catch (e) {}
    }
    if (isOpen) {
      loadData();
    }
  }, [isOpen]);

  // Sync active medicine with props or reset
  useEffect(() => {
    if (isOpen) {
      setActiveMedicine(initialMedicine);
      setActiveTab(initialTab);
      setError(null);
      setSuccessMsg(null);
    }
  }, [initialMedicine, isOpen, initialTab]);

  // Load batches whenever active medicine changes
  useEffect(() => {
    async function loadBatches() {
      if (activeMedicine) {
        const b = await db.medicine_batches
          .where('medicine_id')
          .equals(activeMedicine.id)
          .toArray();
        setBatches(b);
        if (b.length > 0) {
          setSelectedBatchId(b[0].id);
          setRemoveBatchId(b[0].id);
          setExpiryBatchId(b[0].id);
          setNewExpiryDate(b[0].expiry_date || '');
          setIsExpiryUnknown(!b[0].expiry_date);
          setExactStock(String(b[0].quantity_available));
        } else {
          setSelectedBatchId('');
          setRemoveBatchId('');
          setExpiryBatchId('');
          setExactStock(String(activeMedicine.current_stock || 0));
        }
      }
    }
    if (isOpen && activeMedicine) {
      loadBatches();
    }
  }, [activeMedicine, isOpen]);

  // When selected batch changes for Set Stock, sync default value
  const handleBatchSelectForSetStock = (batchId: string) => {
    setSelectedBatchId(batchId);
    const b = batches.find((x) => x.id === batchId);
    if (b) {
      setExactStock(String(b.quantity_available));
    }
  };

  // When selected batch changes for Expiry, sync date
  const handleBatchSelectForExpiry = (batchId: string) => {
    setExpiryBatchId(batchId);
    const b = batches.find((x) => x.id === batchId);
    if (b) {
      setNewExpiryDate(b.expiry_date || '');
      setIsExpiryUnknown(!b.expiry_date);
    }
  };

  if (!isOpen) return null;

  // Strict RBAC gate: Only ADMIN can edit stock or expiry
  if (currentUser?.role !== 'ADMIN') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div className="bg-white p-6 rounded-lg max-w-sm text-center">
          <ShieldAlert className="w-10 h-10 text-rose-500 mx-auto mb-2" />
          <h3 className="font-bold text-sm text-slate-900">Permission Denied</h3>
          <p className="text-xs text-slate-600 mt-1">
            Manual stock editing and expiry management are strictly restricted to the{' '}
            <strong className="text-rose-600">ADMIN</strong> role. Cashiers and attendants cannot modify stock quantities.
          </p>
          <button
            onClick={onClose}
            className="mt-4 px-4 py-2 bg-slate-900 text-white rounded text-xs font-semibold cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  // --- SUBMIT HANDLERS ---

  // 1. SET EXACT STOCK
  const handleSetStockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!activeMedicine) {
      setError('Please select a medicine.');
      return;
    }

    const qty = parseInt(exactStock, 10);
    if (isNaN(qty) || qty < 0) {
      setError('Stock quantity must be a non-negative whole number (0 or higher).');
      return;
    }

    setIsSubmitting(true);
    try {
      // 1. Call server API
      const res: any = await apiFetch('/api/inventory/set-stock', { method: 'POST', body: {
          medicine_id: activeMedicine.id,
          batch_id: selectedBatchId || undefined,
          new_stock: qty,
          reason: setStockReason,
          notes: setStockNotes.trim() || `Admin set stock to ${qty}`,
        } });

      // 2. Apply the committed server result to the Dexie cache
      const data = res;
      const cacheWarning = await refreshCacheAfterCommit(() => applyServerStockResult(data));

      setSuccessMsg(`Stock successfully updated to exactly ${qty} units (medicine total: ${data.medicine?.current_stock ?? qty}).${cacheWarning ? ` ${cacheWarning}` : ''}`);
      setTimeout(() => {
        onAdjusted();
        onClose();
      }, cacheWarning ? 8000 : 1000);
    } catch (err: any) {
      setError(err?.message || 'Failed to update stock quantity.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // 2. ADD STOCK
  const handleAddStockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!activeMedicine) {
      setError('Please select a medicine.');
      return;
    }

    const qty = parseInt(addQty, 10);
    if (isNaN(qty) || qty <= 0) {
      setError('Quantity to add must be a positive whole number greater than 0.');
      return;
    }

    if (!addBatchNum.trim()) {
      setError('Batch Number is required.');
      return;
    }

    setIsSubmitting(true);
    try {
      const res: any = await apiFetch('/api/inventory/add-stock', { method: 'POST', body: {
          medicine_id: activeMedicine.id,
          quantity: qty,
          batch_number: addBatchNum.trim(),
          expiry_date: addExpiry || undefined,
          supplier_id: addSupplierId || undefined,
          purchase_price: addPurchasePrice ? parseFloat(addPurchasePrice) : undefined,
          selling_price_override: addSellingPrice ? parseFloat(addSellingPrice) : undefined,
          notes: addNotes.trim() || undefined,
        } });

      // Apply the committed server result to the Dexie cache
      const data = res;
      const cacheWarning = await refreshCacheAfterCommit(() => applyServerStockResult(data));
      const cleanBatch = data.batch?.batch_number || addBatchNum.trim().toUpperCase();

      setSuccessMsg(`Added ${qty} units to batch ${cleanBatch} successfully.${cacheWarning ? ` ${cacheWarning}` : ''}`);
      setTimeout(() => {
        onAdjusted();
        onClose();
      }, cacheWarning ? 8000 : 1000);
    } catch (err: any) {
      setError(err?.message || 'Failed to add stock.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // 3. REMOVE STOCK
  const handleRemoveStockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!activeMedicine) {
      setError('Please select a medicine.');
      return;
    }

    const qty = parseInt(removeQty, 10);
    if (isNaN(qty) || qty <= 0) {
      setError('Quantity to remove must be a positive whole number.');
      return;
    }

    const targetBatch = batches.find((b) => b.id === removeBatchId);
    if (!targetBatch) {
      setError('Please select a batch.');
      return;
    }

    if (qty > targetBatch.quantity_available) {
      setError(`Cannot remove ${qty} units. Batch only has ${targetBatch.quantity_available} units available.`);
      return;
    }

    setIsSubmitting(true);
    try {
      const res: any = await apiFetch('/api/inventory/remove-stock', { method: 'POST', body: {
          medicine_id: activeMedicine.id,
          batch_id: targetBatch.id,
          quantity: qty,
          reason: removeReason,
          notes: removeNotes.trim() || undefined,
        } });

      // Apply the committed server result to the Dexie cache
      const cacheWarning = await refreshCacheAfterCommit(async () => applyServerStockResult(res));

      setSuccessMsg(`Removed ${qty} units from batch ${targetBatch.batch_number}.${cacheWarning ? ` ${cacheWarning}` : ''}`);
      setTimeout(() => {
        onAdjusted();
        onClose();
      }, cacheWarning ? 8000 : 1000);
    } catch (err: any) {
      setError(err?.message || 'Failed to remove stock.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // 4. EDIT EXPIRY
  const handleEditExpirySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!activeMedicine) {
      setError('Please select a medicine.');
      return;
    }

    const targetBatch = batches.find((b) => b.id === expiryBatchId);
    if (!targetBatch) {
      setError('Please select a batch to edit expiry.');
      return;
    }

    const expiryToSend = isExpiryUnknown ? null : newExpiryDate.trim() || null;

    setIsSubmitting(true);
    try {
      const res: any = await apiFetch(`/api/batches/${targetBatch.id}/expiry`, { method: 'PATCH', body: {
          expiry_date: expiryToSend,
        } });

      // Apply the committed server result to the Dexie cache
      const cacheWarning = await refreshCacheAfterCommit(async () => applyServerStockResult(res));

      setSuccessMsg(`Expiry date updated for batch ${targetBatch.batch_number}.${cacheWarning ? ` ${cacheWarning}` : ''}`);
      setTimeout(() => {
        onAdjusted();
        onClose();
      }, cacheWarning ? 8000 : 1000);
    } catch (err: any) {
      setError(err?.message || 'Failed to update expiry date.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
      <div className="w-full max-w-xl bg-white rounded border border-slate-300 shadow-xl overflow-hidden text-slate-800 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="bg-slate-900 px-5 py-3 text-white flex justify-between items-center shrink-0">
          <div className="flex items-center gap-2">
            <PackageSearch className="w-4 h-4 text-teal-400" />
            <span className="font-bold text-xs uppercase tracking-wider">
              Inventory & Batch Control [Admin RBAC]
            </span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white p-1 rounded cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Global Searchable Medicine Selector */}
        <div className="p-4 bg-slate-50 border-b border-slate-200 shrink-0">
          <MedicineSelector
            medicines={allMedicines}
            batches={batches}
            selectedMedicineId={activeMedicine?.id || null}
            onSelect={(m) => setActiveMedicine(m)}
            label="Select Medicine (Search 2,000+ Items)"
            placeholder="Type medicine name, generic, brand, strength, barcode..."
            currency={settings.currency}
          />

          {activeMedicine && (
            <div className="mt-2.5 p-2 bg-white rounded border border-slate-200 flex items-center justify-between text-xs">
              <div>
                <span className="font-bold text-slate-900">{activeMedicine.name}</span>
                <span className="text-slate-500 ml-2">({activeMedicine.generic_name})</span>
              </div>
              <div className="font-mono">
                Stock: <strong className="text-teal-800">{activeMedicine.current_stock}</strong> {activeMedicine.unit}
              </div>
            </div>
          )}
        </div>

        {/* Action Tabs */}
        <div className="flex border-b border-slate-200 bg-white text-xs shrink-0">
          {[
            { id: 'SET_STOCK', label: 'Set Exact Stock', icon: Sliders },
            { id: 'ADD_STOCK', label: 'Add Stock', icon: Plus },
            { id: 'REMOVE_STOCK', label: 'Remove Stock', icon: Minus },
            { id: 'EDIT_EXPIRY', label: 'Edit Expiry', icon: Calendar },
          ].map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setActiveTab(tab.id as StockOperationTab);
                  setError(null);
                  setSuccessMsg(null);
                }}
                className={`flex-1 py-2.5 px-3 flex items-center justify-center gap-1.5 font-semibold transition border-b-2 cursor-pointer ${
                  active
                    ? 'border-teal-700 text-teal-800 bg-teal-50/40'
                    : 'border-transparent text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Modal Body & Forms */}
        <div className="p-5 overflow-y-auto flex-1 text-xs space-y-4">
          {error && (
            <div className="p-2.5 rounded bg-rose-50 border border-rose-200 text-rose-800 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600" />
              <span>{error}</span>
            </div>
          )}

          {successMsg && (
            <div className="p-2.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
              <span>{successMsg}</span>
            </div>
          )}

          {!activeMedicine ? (
            <div className="py-8 text-center text-slate-400">
              Please search and select a medicine above to manage stock or expiry.
            </div>
          ) : (
            <>
              {/* TAB 1: SET EXACT STOCK */}
              {activeTab === 'SET_STOCK' && (
                <form onSubmit={handleSetStockSubmit} className="space-y-3.5">
                  <div className="p-3 bg-amber-50/70 border border-amber-200 rounded text-amber-900 text-[11px] leading-relaxed">
                    <strong>Set Stock Level:</strong> Entering an exact quantity will automatically calculate the difference (delta), adjust the chosen batch, update the medicine's total stock, and log an audit movement.
                  </div>

                  {batches.length > 1 && (
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">
                        Select Batch to Adjust ({batches.length} batches found) *
                      </label>
                      <select
                        value={selectedBatchId}
                        onChange={(e) => handleBatchSelectForSetStock(e.target.value)}
                        className="w-full p-2 border border-slate-300 rounded bg-white font-mono"
                      >
                        {batches.map((b) => (
                          <option key={b.id} value={b.id}>
                            Batch: {b.batch_number} | Current: {b.quantity_available} | Exp: {b.expiry_date}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Current Quantity</label>
                      <input
                        type="text"
                        disabled
                        value={
                          batches.length > 0
                            ? batches.find((b) => b.id === selectedBatchId)?.quantity_available ?? activeMedicine.current_stock
                            : activeMedicine.current_stock
                        }
                        className="w-full p-2 border border-slate-200 rounded bg-slate-100 font-mono text-slate-600 font-semibold"
                      />
                    </div>

                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">New Desired Quantity *</label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        required
                        value={exactStock}
                        onChange={(e) => setExactStock(e.target.value)}
                        placeholder="e.g. 350"
                        className="w-full p-2 border border-slate-300 rounded bg-white font-mono font-bold text-slate-900 focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Reason for Set Stock</label>
                    <select
                      value={setStockReason}
                      onChange={(e) => setSetStockReason(e.target.value)}
                      className="w-full p-2 border border-slate-300 rounded bg-white"
                    >
                      <option value="Physical stock count correction">Physical stock count correction</option>
                      <option value="Audited stock reconciliation">Audited stock reconciliation</option>
                      <option value="Opening stock entry">Opening stock entry</option>
                      <option value="Supplier recount">Supplier recount</option>
                    </select>
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Audit Notes</label>
                    <input
                      type="text"
                      value={setStockNotes}
                      onChange={(e) => setSetStockNotes(e.target.value)}
                      placeholder="e.g. Verified by pharmacist on annual physical count"
                      className="w-full p-2 border border-slate-300 rounded bg-white"
                    />
                  </div>

                  <div className="pt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={onClose}
                      className="px-3.5 py-2 border border-slate-300 rounded text-slate-700 font-semibold hover:bg-slate-50 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isSubmitting || !!successMsg}
                      className="px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white font-bold rounded shadow-xs transition disabled:opacity-50 cursor-pointer"
                    >
                      {isSubmitting ? 'Saving...' : 'Set Exact Stock'}
                    </button>
                  </div>
                </form>
              )}

              {/* TAB 2: ADD STOCK */}
              {activeTab === 'ADD_STOCK' && (
                <form onSubmit={handleAddStockSubmit} className="space-y-3.5">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Batch Number *</label>
                      <input
                        type="text"
                        required
                        value={addBatchNum}
                        onChange={(e) => setAddBatchNum(e.target.value.toUpperCase())}
                        placeholder="e.g. BATCH-2026-01"
                        className="w-full p-2 border border-slate-300 rounded font-mono font-bold uppercase"
                      />
                    </div>

                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Quantity to Add *</label>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        required
                        value={addQty}
                        onChange={(e) => setAddQty(e.target.value)}
                        placeholder="e.g. 100"
                        className="w-full p-2 border border-slate-300 rounded font-mono font-bold"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Expiry Date</label>
                      <input
                        type="date"
                        value={addExpiry}
                        onChange={(e) => setAddExpiry(e.target.value)}
                        className="w-full p-2 border border-slate-300 rounded font-mono"
                      />
                    </div>

                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Supplier</label>
                      <select
                        value={addSupplierId}
                        onChange={(e) => setAddSupplierId(e.target.value)}
                        className="w-full p-2 border border-slate-300 rounded bg-white truncate"
                      >
                        <option value="">-- None / Direct --</option>
                        {suppliers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">
                        Purchase Cost ({settings.currency})
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={addPurchasePrice}
                        onChange={(e) => setAddPurchasePrice(e.target.value)}
                        placeholder={String(activeMedicine.purchase_price || 0)}
                        className="w-full p-2 border border-slate-300 rounded font-mono"
                      />
                    </div>

                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">
                        Selling Price Override ({settings.currency})
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={addSellingPrice}
                        onChange={(e) => setAddSellingPrice(e.target.value)}
                        placeholder={String(activeMedicine.selling_price || 0)}
                        className="w-full p-2 border border-slate-300 rounded font-mono"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Notes / Invoice Ref</label>
                    <input
                      type="text"
                      value={addNotes}
                      onChange={(e) => setAddNotes(e.target.value)}
                      placeholder="e.g. Delivered under PO-1029"
                      className="w-full p-2 border border-slate-300 rounded bg-white"
                    />
                  </div>

                  <div className="pt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={onClose}
                      className="px-3.5 py-2 border border-slate-300 rounded text-slate-700 font-semibold hover:bg-slate-50 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isSubmitting || !!successMsg}
                      className="px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white font-bold rounded shadow-xs transition disabled:opacity-50 cursor-pointer"
                    >
                      {isSubmitting ? 'Adding...' : 'Add Stock'}
                    </button>
                  </div>
                </form>
              )}

              {/* TAB 3: REMOVE STOCK */}
              {activeTab === 'REMOVE_STOCK' && (
                <form onSubmit={handleRemoveStockSubmit} className="space-y-3.5">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Target Batch *</label>
                    {batches.length === 0 ? (
                      <div className="p-2 bg-amber-50 border border-amber-200 text-amber-800 rounded">
                        No active batches to remove stock from.
                      </div>
                    ) : (
                      <select
                        value={removeBatchId}
                        onChange={(e) => setRemoveBatchId(e.target.value)}
                        className="w-full p-2 border border-slate-300 rounded bg-white font-mono"
                      >
                        {batches.map((b) => (
                          <option key={b.id} value={b.id}>
                            Batch: {b.batch_number} | Available: {b.quantity_available} | Exp: {b.expiry_date}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Quantity to Remove *</label>
                      <input
                        type="number"
                        min="1"
                        max={batches.find((b) => b.id === removeBatchId)?.quantity_available || 1}
                        step="1"
                        required
                        value={removeQty}
                        onChange={(e) => setRemoveQty(e.target.value)}
                        placeholder="e.g. 5"
                        className="w-full p-2 border border-slate-300 rounded font-mono font-bold"
                      />
                    </div>

                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Reason *</label>
                      <select
                        value={removeReason}
                        onChange={(e) => setRemoveReason(e.target.value)}
                        className="w-full p-2 border border-slate-300 rounded bg-white"
                      >
                        <option value="Damaged">Damaged / Broken Bottle</option>
                        <option value="Expired">Expired</option>
                        <option value="Lost">Lost / Shrinkage</option>
                        <option value="Physical stock correction">Physical Stock Correction</option>
                        <option value="Other">Other (Specify in Notes)</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Audit Justification Notes</label>
                    <input
                      type="text"
                      value={removeNotes}
                      onChange={(e) => setRemoveNotes(e.target.value)}
                      placeholder="e.g. Dropped during shelf restocking"
                      className="w-full p-2 border border-slate-300 rounded bg-white"
                    />
                  </div>

                  <div className="pt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={onClose}
                      className="px-3.5 py-2 border border-slate-300 rounded text-slate-700 font-semibold hover:bg-slate-50 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isSubmitting || !!successMsg || batches.length === 0}
                      className="px-4 py-2 bg-rose-700 hover:bg-rose-800 text-white font-bold rounded shadow-xs transition disabled:opacity-50 cursor-pointer"
                    >
                      {isSubmitting ? 'Removing...' : 'Remove Stock'}
                    </button>
                  </div>
                </form>
              )}

              {/* TAB 4: EDIT EXPIRY */}
              {activeTab === 'EDIT_EXPIRY' && (
                <form onSubmit={handleEditExpirySubmit} className="space-y-3.5">
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Select Batch *</label>
                    {batches.length === 0 ? (
                      <div className="p-2 bg-amber-50 border border-amber-200 text-amber-800 rounded">
                        No active batches found for this product.
                      </div>
                    ) : (
                      <select
                        value={expiryBatchId}
                        onChange={(e) => handleBatchSelectForExpiry(e.target.value)}
                        className="w-full p-2 border border-slate-300 rounded bg-white font-mono"
                      >
                        {batches.map((b) => (
                          <option key={b.id} value={b.id}>
                            Batch: {b.batch_number} | Available: {b.quantity_available} | Exp: {b.expiry_date}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  <div className="p-3 bg-slate-50 border border-slate-200 rounded space-y-2">
                    <label className="flex items-center gap-2 cursor-pointer font-medium text-slate-700">
                      <input
                        type="checkbox"
                        checked={isExpiryUnknown}
                        onChange={(e) => setIsExpiryUnknown(e.target.checked)}
                        className="rounded text-teal-700 focus:ring-teal-700"
                      />
                      <span>Expiry date is unknown (Mark status as UNKNOWN)</span>
                    </label>

                    {!isExpiryUnknown && (
                      <div>
                        <label className="block font-semibold text-slate-700 mb-1">New Expiry Date *</label>
                        <input
                          type="date"
                          required={!isExpiryUnknown}
                          value={newExpiryDate}
                          onChange={(e) => setNewExpiryDate(e.target.value)}
                          className="w-full p-2 border border-slate-300 rounded bg-white font-mono"
                        />
                      </div>
                    )}
                  </div>

                  <div className="pt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={onClose}
                      className="px-3.5 py-2 border border-slate-300 rounded text-slate-700 font-semibold hover:bg-slate-50 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isSubmitting || !!successMsg || batches.length === 0}
                      className="px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white font-bold rounded shadow-xs transition disabled:opacity-50 cursor-pointer"
                    >
                      {isSubmitting ? 'Updating...' : 'Save Expiry Date'}
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
