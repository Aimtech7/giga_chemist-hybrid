import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  ClipboardCheck,
  Search,
  CheckCircle2,
  AlertTriangle,
  Boxes,
  Plus,
  Trash2,
  Printer,
  Download,
  History,
  RefreshCw,
  Lock,
  ArrowRight,
  Pill,
  ShieldCheck,
  AlertCircle,
  FileSpreadsheet,
} from 'lucide-react';
import { db, getDeviceId } from '../../db/dexie';
import { getAuthHeaders } from '../../services/auth';
import { apiUrl } from '../../services/api';
import { applyServerStockResult, refreshCacheAfterCommit } from '../../services/stockCache';
import { MedicineSelector } from '../common/MedicineSelector';
import { normalizeExpiryDate, isExpired, isExpiringSoon } from '../../utils/expiry';
import type { Medicine, MedicineBatch, PharmacySettings, User, InventoryMovement } from '../../types';

interface BatchCountRow {
  batch_id?: string;
  batch_number: string;
  previous_quantity: number;
  quantity: string;
  expiry_date: string;
  is_unknown_expiry: boolean;
  purchase_price?: number;
  selling_price_override?: number;
}

interface PhysicalStockCountProps {
  currentUser: User | null;
  settings: PharmacySettings;
}

interface CountHistoryItem {
  id: string;
  medicine_id: string;
  medicine_name: string;
  batch_number: string;
  previous_quantity: number;
  new_quantity: number;
  delta: number;
  expiry_date?: string;
  date: string;
  timestamp: number;
  admin_name: string;
}

export const PhysicalStockCount: React.FC<PhysicalStockCountProps> = ({ currentUser, settings }) => {
  const isAdmin = currentUser?.role === 'ADMIN';

  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [batches, setBatches] = useState<MedicineBatch[]>([]);
  const [selectedMedicine, setSelectedMedicine] = useState<Medicine | null>(null);
  const [batchRows, setBatchRows] = useState<BatchCountRow[]>([]);
  const [notes, setNotes] = useState<string>('');

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Session Progress Tracking (Medicine IDs counted during current stocktake)
  const [countedMedicineIds, setCountedMedicineIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('giga_stocktake_counted_ids');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });

  // Recent stocktake history
  const [historyItems, setHistoryItems] = useState<CountHistoryItem[]>([]);
  const [showHistoryModal, setShowHistoryModal] = useState<boolean>(false);
  const [historyFilter, setHistoryFilter] = useState<'ALL' | 'COUNTED' | 'REMAINING'>('ALL');

  // Print/Export sheet modal
  const [showExportModal, setShowExportModal] = useState<boolean>(false);

  const firstCountInputRef = useRef<HTMLInputElement>(null);

  // Load medicines, batches, and recent movements from local Dexie & Server
  const loadData = async () => {
    setIsLoading(true);
    try {
      const [allMeds, allBatches, movements] = await Promise.all([
        db.medicines.where('status').equals('active').toArray(),
        db.medicine_batches.toArray(),
        db.inventory_movements.where('reason').equals('PHYSICAL_STOCK_COUNT').reverse().limit(100).toArray(),
      ]);

      setMedicines(allMeds);
      setBatches(allBatches);

      if (movements && movements.length > 0) {
        setHistoryItems(
          movements.map((m) => ({
            id: m.id,
            medicine_id: m.medicine_id,
            medicine_name: m.medicine_name || 'Medicine',
            batch_number: m.batch_number || 'BATCH',
            previous_quantity: m.previous_quantity || 0,
            new_quantity: m.new_quantity || 0,
            delta: m.adjustment_quantity || 0,
            date: m.date || new Date().toISOString().split('T')[0],
            timestamp: m.timestamp || Date.now(),
            admin_name: m.user_name || 'Admin',
          }))
        );
      }
    } catch (err: any) {
      console.warn('[PhysicalStockCount] Load error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isAdmin) {
      loadData();
    }
  }, [isAdmin]);

  // When selected medicine changes, prepare batch count rows
  useEffect(() => {
    if (!selectedMedicine) {
      setBatchRows([]);
      setNotes('');
      return;
    }

    const medBatches = batches.filter((b) => b.medicine_id === selectedMedicine.id);

    if (medBatches.length > 0) {
      // Initialize rows with existing batches
      setBatchRows(
        medBatches.map((b) => ({
          batch_id: b.id,
          batch_number: b.batch_number,
          previous_quantity: b.quantity_available,
          quantity: String(b.quantity_available),
          expiry_date: b.expiry_date || '',
          is_unknown_expiry: !b.expiry_date || b.expiry_status === 'UNKNOWN',
          purchase_price: b.purchase_price,
          selling_price_override: b.selling_price_override,
        }))
      );
    } else {
      // Medicine has no batch record yet -> create default initial row
      const now = new Date();
      const defaultBatchNum = `BAT-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      setBatchRows([
        {
          batch_number: defaultBatchNum,
          previous_quantity: selectedMedicine.current_stock || 0,
          quantity: String(selectedMedicine.current_stock || 0),
          expiry_date: '',
          is_unknown_expiry: true,
          purchase_price: selectedMedicine.purchase_price || 0,
        },
      ]);
    }

    // Auto-focus the first physical count input field
    setTimeout(() => {
      firstCountInputRef.current?.focus();
      firstCountInputRef.current?.select();
    }, 100);
  }, [selectedMedicine, batches]);

  // Save session counted list to localStorage
  const markAsCounted = (medId: string) => {
    setCountedMedicineIds((prev) => {
      if (prev.includes(medId)) return prev;
      const updated = [...prev, medId];
      try {
        localStorage.setItem('giga_stocktake_counted_ids', JSON.stringify(updated));
      } catch (e) {}
      return updated;
    });
  };

  const handleResetCountProgress = () => {
    if (window.confirm('Reset the counted items session tracker? (Database stock numbers remain untouched).')) {
      setCountedMedicineIds([]);
      try {
        localStorage.removeItem('giga_stocktake_counted_ids');
      } catch (e) {}
    }
  };

  // Add extra batch row if Admin discovers an unrecorded batch on physical shelf
  const handleAddNewBatchRow = () => {
    const now = new Date();
    const batchIndex = batchRows.length + 1;
    const newBatchNum = `LOT-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-${String(batchIndex).padStart(2, '0')}`;
    setBatchRows((prev) => [
      ...prev,
      {
        batch_number: newBatchNum,
        previous_quantity: 0,
        quantity: '0',
        expiry_date: '',
        is_unknown_expiry: true,
        purchase_price: selectedMedicine?.purchase_price || 0,
      },
    ]);
  };

  const handleRemoveBatchRow = (index: number) => {
    if (batchRows.length <= 1) {
      alert('At least one batch row must be retained.');
      return;
    }
    setBatchRows((prev) => prev.filter((_, i) => i !== index));
  };

  const handleRowChange = (index: number, field: keyof BatchCountRow, value: any) => {
    setBatchRows((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [field]: value };
      return copy;
    });
  };

  // Calculate live total new physical stock from all batch inputs
  const calculatedTotalPhysicalStock = useMemo(() => {
    return batchRows.reduce((sum, r) => {
      const q = parseInt(r.quantity, 10);
      return sum + (isNaN(q) || q < 0 ? 0 : q);
    }, 0);
  }, [batchRows]);

  // Handle immediate Physical Stock Count Save
  const handleSaveStock = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!selectedMedicine || batchRows.length === 0) return;

    setErrorMessage(null);
    setSuccessBanner(null);

    // Validate inputs
    for (let i = 0; i < batchRows.length; i++) {
      const row = batchRows[i];
      if (!row.batch_number.trim()) {
        setErrorMessage(`Batch number for item #${i + 1} cannot be empty.`);
        return;
      }
      const parsedQty = parseInt(row.quantity, 10);
      if (isNaN(parsedQty) || parsedQty < 0) {
        setErrorMessage(`Physical quantity for batch "${row.batch_number}" must be a non-negative whole number (0 or higher).`);
        return;
      }
    }

    setIsSaving(true);

    try {
      const payload = {
        medicine_id: selectedMedicine.id,
        notes: notes.trim() || `Physical stock count by ${currentUser?.name || 'Admin'}`,
        counts: batchRows.map((r) => ({
          batch_id: r.batch_id || undefined,
          batch_number: r.batch_number.trim().toUpperCase(),
          quantity: parseInt(r.quantity, 10),
          expiry_date: r.is_unknown_expiry ? null : (r.expiry_date.trim() || null),
          expiry_status: r.is_unknown_expiry ? 'UNKNOWN' : (r.expiry_date ? 'KNOWN' : 'UNKNOWN'),
          purchase_price: r.purchase_price,
          selling_price_override: r.selling_price_override,
        })),
      };

      const res = await fetch(apiUrl('/api/inventory/physical-count'), {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Server responded with ${res.status}`);
      }

      // PostgreSQL has COMMITTED from here on. Nothing below may report the count as failed.
      const data = await res.json();
      const movements: any[] = data.movements || [];
      const prevStock = Number(data.previous_stock ?? selectedMedicine.current_stock ?? 0);
      const newStock = Number(data.total_stock);
      const delta = newStock - prevStock;

      // Refresh the Dexie cache from the server result. The device lookup reads db.devices, so it
      // must run OUTSIDE the transaction below — its scope does not include that store.
      const cacheWarning = await refreshCacheAfterCommit(async () => {
        const deviceId = await getDeviceId();
        await applyServerStockResult(data);
        await db.inventory_movements.bulkPut(
          movements.map((m) => ({
            id: m.id,
            medicine_id: selectedMedicine.id,
            medicine_name: selectedMedicine.name,
            batch_id: m.batch_id,
            batch_number: m.batch_number,
            previous_quantity: m.previous_quantity,
            adjustment_quantity: m.delta,
            new_quantity: m.new_quantity,
            reason: 'PHYSICAL_STOCK_COUNT',
            notes: notes.trim() || 'Direct physical count',
            user_id: currentUser?.id || 'admin',
            user_name: currentUser?.name || 'Administrator',
            date: new Date().toLocaleDateString('en-CA'),
            device_id: deviceId,
            timestamp: Date.now(),
          }))
        );
      });

      // Update state & progress
      markAsCounted(selectedMedicine.id);

      setSuccessBanner(
        `✓ ${selectedMedicine.name} stock saved: ${prevStock} → ${newStock} units (${delta >= 0 ? `+${delta}` : delta}).`
      );
      if (cacheWarning) setErrorMessage(cacheWarning);

      // Add to in-memory history
      setHistoryItems((prev) => [
        {
          id: `hist-${Date.now()}`,
          medicine_id: selectedMedicine.id,
          medicine_name: selectedMedicine.name,
          batch_number: batchRows.map((b) => b.batch_number).join(', '),
          previous_quantity: prevStock,
          new_quantity: newStock,
          delta,
          date: new Date().toISOString().split('T')[0],
          timestamp: Date.now(),
          admin_name: currentUser?.name || 'Admin',
        },
        ...prev,
      ]);

      // Refresh catalog data in background
      await loadData();

      // Clear selected medicine so user can immediately scan or type next medicine
      setSelectedMedicine(null);
      setBatchRows([]);
      setNotes('');
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to save physical stock count.');
    } finally {
      setIsSaving(false);
    }
  };

  // Export Physical Count Sheet (CSV)
  const handleExportCSV = () => {
    const rows = [
      ['Medicine Name', 'Generic Name', 'Strength', 'Category', 'SKU', 'Barcode', 'Current System Stock', 'Batch Number', 'Expiry Date', 'Physical Count (Actual)'],
    ];

    for (const med of medicines) {
      const medBatches = batches.filter((b) => b.medicine_id === med.id);
      if (medBatches.length > 0) {
        for (const b of medBatches) {
          rows.push([
            `"${med.name.replace(/"/g, '""')}"`,
            `"${(med.generic_name || '').replace(/"/g, '""')}"`,
            `"${(med.dosage_strength || '').replace(/"/g, '""')}"`,
            `"${(med.category || '').replace(/"/g, '""')}"`,
            `"${med.sku || ''}"`,
            `"${med.barcode || ''}"`,
            String(b.quantity_available),
            `"${b.batch_number}"`,
            b.expiry_date || 'UNKNOWN',
            '', // Blank for physical count writing
          ]);
        }
      } else {
        rows.push([
          `"${med.name.replace(/"/g, '""')}"`,
          `"${(med.generic_name || '').replace(/"/g, '""')}"`,
          `"${(med.dosage_strength || '').replace(/"/g, '""')}"`,
          `"${(med.category || '').replace(/"/g, '""')}"`,
          `"${med.sku || ''}"`,
          `"${med.barcode || ''}"`,
          String(med.current_stock || 0),
          'DEFAULT-BATCH',
          'UNKNOWN',
          '',
        ]);
      }
    }

    const csvContent = 'data:text/csv;charset=utf-8,' + rows.map((e) => e.join(',')).join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `GIGA_CHEMIST_Stocktake_Sheet_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Filtered medicines for review or sheet
  const filteredMedicines = useMemo(() => {
    if (historyFilter === 'COUNTED') {
      return medicines.filter((m) => countedMedicineIds.includes(m.id));
    }
    if (historyFilter === 'REMAINING') {
      return medicines.filter((m) => !countedMedicineIds.includes(m.id));
    }
    return medicines;
  }, [medicines, countedMedicineIds, historyFilter]);

  // RBAC Guard
  if (!isAdmin) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-center">
        <div className="max-w-md p-6 bg-white rounded-lg border border-slate-200 shadow-xs">
          <Lock className="w-10 h-10 text-rose-500 mx-auto mb-2" />
          <h2 className="text-base font-bold text-slate-900">Restricted Module — Admin Only</h2>
          <p className="text-xs text-slate-600 mt-1">
            Physical stock counting, batch reconciliation, and inventory adjustments are strictly restricted to system Administrators.
          </p>
        </div>
      </div>
    );
  }

  const totalCount = medicines.length;
  const countedCount = countedMedicineIds.length;
  const remainingCount = Math.max(0, totalCount - countedCount);
  const percentComplete = totalCount > 0 ? Math.round((countedCount / totalCount) * 100) : 0;

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      {/* Top Header */}
      <div className="p-4 bg-white border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <ClipboardCheck className="w-5 h-5 text-teal-700 shrink-0" />
            <h1 className="text-base font-bold text-slate-900 tracking-tight">
              Physical Stock Count (Fast Stocktake)
            </h1>
            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-800 border border-purple-200">
              ADMIN ONLY
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Immediate authoritative count. Saving replaces database and POS stock instantly without variance approval steps.
          </p>
        </div>

        {/* Action Controls */}
        <div className="flex items-center flex-wrap gap-2">
          <button
            onClick={() => setShowExportModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold transition cursor-pointer"
            title="Export or Print Physical Counting Sheet"
          >
            <Printer className="w-3.5 h-3.5 text-slate-600" />
            <span>Count Sheet / Print</span>
          </button>

          <button
            onClick={() => setShowHistoryModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold transition cursor-pointer"
          >
            <History className="w-3.5 h-3.5 text-slate-600" />
            <span>Audit History ({historyItems.length})</span>
          </button>

          <button
            onClick={loadData}
            disabled={isLoading}
            className="p-1.5 rounded border border-slate-300 hover:bg-slate-50 text-slate-600 transition cursor-pointer"
            title="Refresh database catalogs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Count Progress Bar Banner */}
      <div className="bg-slate-900 text-white px-4 py-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-slate-400 font-medium">Session Progress:</span>
            <span className="font-bold font-mono text-teal-300">{countedCount} / {totalCount} Counted</span>
            <span className="text-slate-400 font-mono">({remainingCount} Remaining)</span>
          </div>

          <div className="w-32 bg-slate-800 rounded-full h-2 overflow-hidden border border-slate-700 hidden md:block">
            <div
              className="bg-teal-500 h-full transition-all duration-300"
              style={{ width: `${percentComplete}%` }}
            />
          </div>
          <span className="text-[11px] font-bold text-slate-300 hidden md:inline">{percentComplete}%</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleResetCountProgress}
            className="text-[11px] text-slate-400 hover:text-rose-300 underline cursor-pointer"
          >
            Reset Count Tracker
          </button>
        </div>
      </div>

      {/* Notifications */}
      {successBanner && (
        <div className="m-4 p-3 bg-emerald-50 border border-emerald-300 text-emerald-900 text-xs rounded flex items-center justify-between gap-2 shadow-xs animate-in fade-in duration-150 shrink-0">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span className="font-medium">{successBanner}</span>
          </div>
          <button
            onClick={() => setSuccessBanner(null)}
            className="text-emerald-700 hover:text-emerald-900 font-bold px-1 text-sm cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {errorMessage && (
        <div className="m-4 p-3 bg-rose-50 border border-rose-300 text-rose-800 text-xs rounded flex items-center justify-between gap-2 shadow-xs animate-in fade-in duration-150 shrink-0">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
            <span className="font-medium">{errorMessage}</span>
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="text-rose-700 hover:text-rose-900 font-bold px-1 text-sm cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* Main Stocktake Workspace */}
      <div className="flex-1 overflow-auto p-4 max-w-5xl mx-auto w-full space-y-4">
        {/* Rapid Search & Medicine Selection Bar */}
        <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-xs">
          <label className="block text-xs font-bold text-slate-800 mb-1.5">
            1. Search Medicine for Physical Stock Count (Supports Barcode Scanner)
          </label>
          <MedicineSelector
            medicines={medicines}
            batches={batches}
            selectedMedicineId={selectedMedicine?.id}
            onSelect={(med) => setSelectedMedicine(med)}
            autoFocus={true}
            placeholder="Type medicine name, brand, generic, strength, barcode, or scan with USB scanner..."
          />
        </div>

        {/* Active Physical Count Panel */}
        {selectedMedicine ? (
          <form onSubmit={handleSaveStock} className="bg-white rounded-lg border border-slate-300 shadow-md overflow-hidden animate-in fade-in-50 duration-150">
            {/* Medicine Summary Header */}
            <div className="p-4 bg-slate-900 text-white flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded bg-teal-800/80 border border-teal-600 flex items-center justify-center shrink-0">
                  <Pill className="w-5 h-5 text-teal-200" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-bold text-white">{selectedMedicine.name}</h2>
                    {selectedMedicine.dosage_strength && (
                      <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">
                        {selectedMedicine.dosage_strength}
                      </span>
                    )}
                    {countedMedicineIds.includes(selectedMedicine.id) && (
                      <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800 font-bold">
                        COUNTED IN SESSION
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-2">
                    <span>{selectedMedicine.generic_name}</span>
                    {selectedMedicine.brand_name && <span>· Brand: {selectedMedicine.brand_name}</span>}
                    {selectedMedicine.barcode && <span>· Barcode: {selectedMedicine.barcode}</span>}
                  </div>
                </div>
              </div>

              {/* Reference Stats */}
              <div className="flex items-center gap-4 bg-slate-800/80 px-3 py-2 rounded border border-slate-700 shrink-0 text-right">
                <div>
                  <div className="text-[10px] text-slate-400 font-semibold uppercase">Current System Stock</div>
                  <div className="text-sm font-black font-mono text-amber-300">
                    {selectedMedicine.current_stock} {selectedMedicine.unit || 'units'}
                  </div>
                </div>
                <div className="border-l border-slate-700 pl-3">
                  <div className="text-[10px] text-slate-400 font-semibold uppercase">Selling Price</div>
                  <div className="text-sm font-bold font-mono text-emerald-400">
                    {settings.currency_symbol || 'KES'} {selectedMedicine.selling_price.toFixed(2)}
                  </div>
                </div>
              </div>
            </div>

            {/* Batch Entry Table */}
            <div className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                    2. Actual Physical Count by Batch / Lot
                  </h3>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Count each batch physically. You can also edit expiry dates or add newly discovered batches.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleAddNewBatchRow}
                  className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold transition cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Batch Lot</span>
                </button>
              </div>

              <div className="border border-slate-200 rounded overflow-hidden">
                <table className="w-full text-left text-xs text-slate-700">
                  <thead className="bg-slate-50 uppercase text-[10px] font-semibold text-slate-600 border-b border-slate-200">
                    <tr>
                      <th className="py-2 px-3">Batch Number</th>
                      <th className="py-2 px-3">Expiry Date</th>
                      <th className="py-2 px-3 text-right">System Previous</th>
                      <th className="py-2 px-3 w-40 text-right">Actual Physical Count *</th>
                      <th className="py-2 px-3 text-center">Batch Status</th>
                      <th className="py-2 px-3 text-center w-12">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {batchRows.map((row, idx) => {
                      const qtyNum = parseInt(row.quantity, 10);
                      const isZero = qtyNum === 0;
                      const hasExpiry = Boolean(row.expiry_date && !row.is_unknown_expiry);
                      const expired = hasExpiry && isExpired(row.expiry_date);
                      const expiringSoon = hasExpiry && !expired && isExpiringSoon(row.expiry_date, 60);

                      return (
                        <tr key={idx} className="hover:bg-slate-50/80 transition">
                          {/* Batch Number */}
                          <td className="py-2.5 px-3">
                            <input
                              type="text"
                              required
                              value={row.batch_number}
                              onChange={(e) => handleRowChange(idx, 'batch_number', e.target.value.toUpperCase())}
                              className="w-full p-1.5 border border-slate-300 rounded font-mono font-bold text-xs uppercase focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                              placeholder="e.g. BATCH-2026-01"
                            />
                          </td>

                          {/* Expiry Date */}
                          <td className="py-2.5 px-3">
                            <div className="space-y-1">
                              {!row.is_unknown_expiry ? (
                                <input
                                  type="date"
                                  value={row.expiry_date}
                                  onChange={(e) => handleRowChange(idx, 'expiry_date', e.target.value)}
                                  className="w-full p-1.5 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                                />
                              ) : (
                                <span className="inline-block p-1.5 bg-slate-100 text-slate-500 text-[11px] font-mono rounded w-full text-center">
                                  UNKNOWN EXPIRY
                                </span>
                              )}
                              <label className="flex items-center gap-1.5 text-[10px] text-slate-500 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={row.is_unknown_expiry}
                                  onChange={(e) => {
                                    handleRowChange(idx, 'is_unknown_expiry', e.target.checked);
                                    if (e.target.checked) handleRowChange(idx, 'expiry_date', '');
                                  }}
                                  className="rounded border-slate-300 text-teal-700"
                                />
                                <span>Expiry date unknown</span>
                              </label>
                            </div>
                          </td>

                          {/* Previous System Stock */}
                          <td className="py-2.5 px-3 text-right font-mono text-slate-500">
                            {row.previous_quantity} units
                          </td>

                          {/* Physical Count Input */}
                          <td className="py-2.5 px-3 text-right">
                            <div className="relative">
                              <input
                                ref={idx === 0 ? firstCountInputRef : undefined}
                                type="number"
                                min={0}
                                step={1}
                                required
                                value={row.quantity}
                                onChange={(e) => handleRowChange(idx, 'quantity', e.target.value)}
                                placeholder="0"
                                className="w-full p-2 border-2 border-teal-700 rounded font-mono font-black text-sm text-right text-slate-900 bg-teal-50/30 focus:bg-white focus:ring-2 focus:ring-teal-700 focus:outline-hidden"
                              />
                            </div>
                            {isZero && (
                              <div className="text-[10px] text-rose-600 font-bold mt-0.5 text-right">
                                Confirmed 0 (Zero Stock)
                              </div>
                            )}
                          </td>

                          {/* Status Badge */}
                          <td className="py-2.5 px-3 text-center">
                            {expired ? (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-800 border border-rose-200">
                                EXPIRED
                              </span>
                            ) : expiringSoon ? (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">
                                EXPIRING SOON
                              </span>
                            ) : row.is_unknown_expiry ? (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-700">
                                UNKNOWN
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">
                                VALID
                              </span>
                            )}
                          </td>

                          {/* Delete Row */}
                          <td className="py-2.5 px-3 text-center">
                            <button
                              type="button"
                              onClick={() => handleRemoveBatchRow(idx)}
                              className="text-slate-400 hover:text-rose-600 p-1 rounded cursor-pointer"
                              title="Remove batch row"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Optional Notes */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Optional Audit Notes
                </label>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. Verified by Administrator on annual physical stock count"
                  className="w-full p-2 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                />
              </div>

              {/* Summary and Save Action Footer */}
              <div className="pt-4 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div>
                    <span className="text-xs text-slate-500 font-medium">Calculated New Total Stock: </span>
                    <span className="text-base font-black font-mono text-teal-800">
                      {calculatedTotalPhysicalStock} {selectedMedicine.unit || 'units'}
                    </span>
                  </div>
                  {calculatedTotalPhysicalStock <= (selectedMedicine.reorder_level || 0) && (
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" />
                      <span>LOW STOCK (≤ {selectedMedicine.reorder_level})</span>
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedMedicine(null);
                      setBatchRows([]);
                    }}
                    className="px-3.5 py-2 rounded border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-semibold transition cursor-pointer"
                  >
                    Cancel / Skip
                  </button>

                  <button
                    type="submit"
                    disabled={isSaving}
                    className="flex items-center gap-2 px-5 py-2 rounded bg-teal-700 hover:bg-teal-800 text-white text-xs font-bold shadow-md transition cursor-pointer disabled:opacity-50"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>{isSaving ? 'Updating Stock...' : 'SAVE STOCK (IMMEDIATE)'}</span>
                  </button>
                </div>
              </div>
            </div>
          </form>
        ) : (
          <div className="p-8 bg-white border border-dashed border-slate-300 rounded-lg text-center text-slate-500">
            <ClipboardCheck className="w-10 h-10 mx-auto text-slate-400 mb-2" />
            <h3 className="text-sm font-bold text-slate-800">No Medicine Currently Selected</h3>
            <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
              Use the search bar above or scan a barcode with your barcode scanner to immediately begin entering physical stock counts.
            </p>
          </div>
        )}

        {/* Quick Recent Stocktake Stream */}
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden shadow-xs">
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
              <History className="w-3.5 h-3.5 text-teal-700" />
              <span>Recent Physical Count Records (Last 10)</span>
            </h3>
            <span className="text-[11px] text-slate-500 font-mono">
              Live audit stream
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-700">
              <thead className="bg-slate-100 uppercase text-[10px] font-semibold text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="py-2 px-3">Medicine</th>
                  <th className="py-2 px-3">Batch / Lot</th>
                  <th className="py-2 px-3 text-right">Previous</th>
                  <th className="py-2 px-3 text-right">Physical Count</th>
                  <th className="py-2 px-3 text-right">Delta</th>
                  <th className="py-2 px-3">Admin</th>
                  <th className="py-2 px-3 text-right">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {historyItems.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-slate-400 text-xs">
                      No physical count adjustments recorded in this session yet.
                    </td>
                  </tr>
                ) : (
                  historyItems.slice(0, 10).map((h) => (
                    <tr key={h.id} className="hover:bg-slate-50 transition">
                      <td className="py-2 px-3 font-semibold text-slate-900">{h.medicine_name}</td>
                      <td className="py-2 px-3 font-mono text-slate-600">{h.batch_number}</td>
                      <td className="py-2 px-3 text-right font-mono text-slate-500">{h.previous_quantity}</td>
                      <td className="py-2 px-3 text-right font-mono font-bold text-teal-800">{h.new_quantity}</td>
                      <td className="py-2 px-3 text-right font-mono font-bold">
                        <span className={h.delta > 0 ? 'text-emerald-700' : h.delta < 0 ? 'text-rose-700' : 'text-slate-500'}>
                          {h.delta > 0 ? `+${h.delta}` : h.delta}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-slate-700">{h.admin_name}</td>
                      <td className="py-2 px-3 text-right text-slate-500 text-[11px]">
                        {new Date(h.timestamp).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* History Modal */}
      {showHistoryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="w-full max-w-4xl bg-white rounded-lg border border-slate-300 shadow-xl overflow-hidden flex flex-col max-h-[85vh]">
            <div className="bg-slate-900 px-4 py-3 text-white flex justify-between items-center">
              <span className="font-bold text-xs flex items-center gap-1.5">
                <History className="w-4 h-4 text-teal-400" />
                Physical Stocktake Audit Log History
              </span>
              <button
                onClick={() => setShowHistoryModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-auto p-4">
              <table className="w-full text-left text-xs text-slate-700">
                <thead className="bg-slate-50 uppercase text-[10px] font-semibold text-slate-600 border-b border-slate-200">
                  <tr>
                    <th className="py-2 px-3">Date &amp; Time</th>
                    <th className="py-2 px-3">Medicine</th>
                    <th className="py-2 px-3">Batch</th>
                    <th className="py-2 px-3 text-right">Previous Qty</th>
                    <th className="py-2 px-3 text-right">Physical Count</th>
                    <th className="py-2 px-3 text-right">Adjustment Delta</th>
                    <th className="py-2 px-3">Admin</th>
                    <th className="py-2 px-3 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {historyItems.map((h) => (
                    <tr key={h.id} className="hover:bg-slate-50">
                      <td className="py-2 px-3 text-slate-500 text-[11px]">
                        {new Date(h.timestamp).toLocaleString()}
                      </td>
                      <td className="py-2 px-3 font-semibold text-slate-900">{h.medicine_name}</td>
                      <td className="py-2 px-3 font-mono text-slate-600">{h.batch_number}</td>
                      <td className="py-2 px-3 text-right font-mono text-slate-500">{h.previous_quantity}</td>
                      <td className="py-2 px-3 text-right font-mono font-bold text-teal-800">{h.new_quantity}</td>
                      <td className="py-2 px-3 text-right font-mono font-bold">
                        <span className={h.delta > 0 ? 'text-emerald-700' : h.delta < 0 ? 'text-rose-700' : 'text-slate-500'}>
                          {h.delta > 0 ? `+${h.delta}` : h.delta}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-slate-700">{h.admin_name}</td>
                      <td className="py-2 px-3 text-center">
                        <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-bold">
                          APPLIED
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="p-3 bg-slate-50 border-t border-slate-200 flex justify-end">
              <button
                onClick={() => setShowHistoryModal(false)}
                className="px-4 py-1.5 rounded bg-slate-900 text-white text-xs font-semibold cursor-pointer"
              >
                Close History
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Export / Print Count Sheet Modal */}
      {showExportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="w-full max-w-4xl bg-white rounded-lg border border-slate-300 shadow-xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="bg-slate-900 px-4 py-3 text-white flex justify-between items-center print:hidden">
              <span className="font-bold text-xs flex items-center gap-1.5">
                <Printer className="w-4 h-4 text-teal-400" />
                Physical Stock Count Sheet (Print / Export)
              </span>
              <button
                onClick={() => setShowExportModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Modal Toolbar */}
            <div className="p-3 bg-slate-100 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs print:hidden">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-700">Filter Scope:</span>
                <button
                  onClick={() => setHistoryFilter('ALL')}
                  className={`px-2 py-1 rounded text-xs font-semibold cursor-pointer ${
                    historyFilter === 'ALL' ? 'bg-teal-700 text-white' : 'bg-white border border-slate-300 text-slate-700'
                  }`}
                >
                  All Formulary ({medicines.length})
                </button>
                <button
                  onClick={() => setHistoryFilter('REMAINING')}
                  className={`px-2 py-1 rounded text-xs font-semibold cursor-pointer ${
                    historyFilter === 'REMAINING' ? 'bg-teal-700 text-white' : 'bg-white border border-slate-300 text-slate-700'
                  }`}
                >
                  Remaining Uncounted ({remainingCount})
                </button>
                <button
                  onClick={() => setHistoryFilter('COUNTED')}
                  className={`px-2 py-1 rounded text-xs font-semibold cursor-pointer ${
                    historyFilter === 'COUNTED' ? 'bg-teal-700 text-white' : 'bg-white border border-slate-300 text-slate-700'
                  }`}
                >
                  Counted in Session ({countedCount})
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleExportCSV}
                  className="flex items-center gap-1.5 px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download CSV</span>
                </button>
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-1.5 px-3 py-1 rounded bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print Sheet</span>
                </button>
              </div>
            </div>

            {/* Printable Content Table */}
            <div className="flex-1 overflow-auto p-4 print:p-0">
              <div className="mb-4 text-center">
                <h2 className="text-base font-black text-slate-900 uppercase tracking-tight">
                  {settings.pharmacy_name || 'GIGA CHEMIST'} — PHYSICAL STOCK COUNT SHEET
                </h2>
                <p className="text-xs text-slate-500">
                  Date Generated: {new Date().toLocaleDateString()} | Admin Counted By: __________________________
                </p>
              </div>

              <table className="w-full text-left text-xs text-slate-800 border-collapse border border-slate-300">
                <thead className="bg-slate-100 uppercase text-[10px] font-bold text-slate-700 border-b border-slate-300">
                  <tr>
                    <th className="py-2 px-2 border border-slate-300 w-8 text-center">#</th>
                    <th className="py-2 px-2 border border-slate-300">Medicine &amp; Strength</th>
                    <th className="py-2 px-2 border border-slate-300">Generic / Brand</th>
                    <th className="py-2 px-2 border border-slate-300">Batch Number</th>
                    <th className="py-2 px-2 border border-slate-300">Expiry</th>
                    <th className="py-2 px-2 border border-slate-300 text-right w-24">System Qty</th>
                    <th className="py-2 px-2 border border-slate-300 text-center w-36 bg-amber-50">Physical Count</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filteredMedicines.map((med, idx) => {
                    const medBatches = batches.filter((b) => b.medicine_id === med.id);
                    const batchList = medBatches.length > 0 ? medBatches : [{ id: 'def', batch_number: '—', quantity_available: med.current_stock, expiry_date: '' }];

                    return batchList.map((b, bIdx) => (
                      <tr key={`${med.id}-${bIdx}`} className="hover:bg-slate-50">
                        {bIdx === 0 && (
                          <td rowSpan={batchList.length} className="py-1.5 px-2 border border-slate-300 text-center font-mono text-slate-500 text-[10px]">
                            {idx + 1}
                          </td>
                        )}
                        {bIdx === 0 && (
                          <td rowSpan={batchList.length} className="py-1.5 px-2 border border-slate-300 font-semibold">
                            {med.name} {med.dosage_strength && <span className="font-normal text-slate-500">({med.dosage_strength})</span>}
                          </td>
                        )}
                        {bIdx === 0 && (
                          <td rowSpan={batchList.length} className="py-1.5 px-2 border border-slate-300 text-slate-600 text-[11px]">
                            {med.generic_name}
                          </td>
                        )}
                        <td className="py-1.5 px-2 border border-slate-300 font-mono text-[11px]">{b.batch_number}</td>
                        <td className="py-1.5 px-2 border border-slate-300 font-mono text-[11px]">{b.expiry_date || 'UNKNOWN'}</td>
                        <td className="py-1.5 px-2 border border-slate-300 text-right font-mono text-slate-600">{b.quantity_available}</td>
                        <td className="py-1.5 px-2 border border-slate-300 text-center bg-amber-50/40">
                          <div className="h-6 w-full border-b border-dashed border-slate-400"></div>
                        </td>
                      </tr>
                    ));
                  })}
                </tbody>
              </table>
            </div>

            <div className="p-3 bg-slate-50 border-t border-slate-200 flex justify-end print:hidden">
              <button
                onClick={() => setShowExportModal(false)}
                className="px-4 py-1.5 rounded bg-slate-800 text-white text-xs font-semibold cursor-pointer"
              >
                Close Sheet
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
