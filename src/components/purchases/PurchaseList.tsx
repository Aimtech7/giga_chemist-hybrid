import React, { useState, useEffect } from 'react';
import { Truck, Plus, PackageCheck, AlertTriangle, FileSpreadsheet, X, Check } from 'lucide-react';
import { db } from '../../db/dexie';
import { downloadCSV } from '../../services/exportUtils';
import { apiFetch } from '../../services/http';
import { applyServerStockResult, refreshCacheAfterCommit } from '../../services/stockCache';
import { MedicineSelector } from '../common/MedicineSelector';
import type { Purchase, PurchaseItem, Supplier, Medicine, PharmacySettings, User } from '../../types';

interface PurchaseListProps {
  currentUser: User | null;
  settings: PharmacySettings;
}

export const PurchaseList: React.FC<PurchaseListProps> = ({ currentUser, settings }) => {
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [isNewOpen, setIsNewOpen] = useState(false);

  // Form state for creating and receiving stock
  const [supplierId, setSupplierId] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [items, setItems] = useState<PurchaseItem[]>([]);
  
  // Single item addition line
  const [selectedMedId, setSelectedMedId] = useState('');
  const [batchNumber, setBatchNumber] = useState('');
  const [manufacturingDate, setManufacturingDate] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [quantity, setQuantity] = useState<number>(50);
  const [purchasePrice, setPurchasePrice] = useState<number>(0);

  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadData = async () => {
    setPurchases(await db.purchases.toArray());
    const sups = await db.suppliers.where('status').equals('active').toArray();
    setSuppliers(sups);
    if (sups.length > 0 && !supplierId) setSupplierId(sups[0].id);

    const meds = await db.medicines.where('status').equals('active').toArray();
    setMedicines(meds);
    if (meds.length > 0 && !selectedMedId) {
      setSelectedMedId(meds[0].id);
      setPurchasePrice(meds[0].purchase_price);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleMedChange = (id: string) => {
    setSelectedMedId(id);
    const m = medicines.find((x) => x.id === id);
    if (m) {
      setPurchasePrice(m.purchase_price);
    }
  };

  const handleAddItemToPO = () => {
    if (!selectedMedId || !batchNumber.trim() || !expiryDate || quantity <= 0) {
      setError('Please provide medicine, batch number, expiry date, and valid quantity.');
      return;
    }

    const med = medicines.find((m) => m.id === selectedMedId);
    if (!med) return;

    setItems([
      ...items,
      {
        medicine_id: med.id,
        medicine_name: med.name,
        batch_number: batchNumber.trim().toUpperCase(),
        manufacturing_date: manufacturingDate || new Date().toISOString().split('T')[0],
        expiry_date: expiryDate,
        quantity,
        purchase_price: purchasePrice,
        total: quantity * purchasePrice,
      },
    ]);

    // Reset item line inputs
    setBatchNumber('');
    setQuantity(50);
    setError(null);
  };

  const handleRemoveItem = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
  };

  // Receiving is ONE server transaction: purchase + items, batch create-or-increment, stock,
  // movements and audit. The cache is updated only from the committed result.
  const handleReceiveStockPO = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (items.length === 0) {
      setError('Please add at least one medicine item to the purchase receipt.');
      return;
    }
    if (!suppliers.some((s) => s.id === supplierId)) {
      setError('Supplier required.');
      return;
    }
    if (!invoiceNumber.trim()) {
      setError('Enter the supplier invoice number.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await apiFetch<{ purchase: Purchase; medicines: any[]; batches: any[] }>('/api/purchases', {
        body: {
          supplier_id: supplierId,
          invoice_number: invoiceNumber.trim(),
          payment_status: 'paid',
          items: items.map((i) => ({
            medicine_id: i.medicine_id,
            batch_number: i.batch_number,
            manufacturing_date: i.manufacturing_date || null,
            expiry_date: i.expiry_date || null,
            quantity: i.quantity,
            purchase_price: i.purchase_price,
          })),
        },
      });
      const cacheWarning = await refreshCacheAfterCommit(async () => {
        await db.purchases.put(result.purchase);
        await applyServerStockResult({ batches: result.batches });
        for (const m of result.medicines) await applyServerStockResult({ medicine: m });
      });
      if (cacheWarning) setError(cacheWarning);
      setIsNewOpen(false);
      setItems([]);
      setInvoiceNumber('');
      await loadData();
    } catch (err: any) {
      setError(err?.message || 'Failed to receive purchase.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleExportCSV = () => {
    const headers = ['Order #', 'Invoice #', 'Supplier', 'Date', 'Status', 'Total (KES)', 'Items Count'];
    const rows = purchases.map((p) => [
      p.order_number,
      p.invoice_number,
      p.supplier_name,
      p.order_date,
      p.status.toUpperCase(),
      p.total_amount.toFixed(2),
      p.items.length,
    ]);
    downloadCSV(`giga-chemist-purchases-${new Date().toISOString().split('T')[0]}.csv`, headers, rows);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      <div className="p-4 bg-white border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 shrink-0">
        <div>
          <h1 className="text-base font-bold text-slate-900 tracking-tight">
            Purchases
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Supplier orders, goods receipts, and medicine batch intake.
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

          <button
            onClick={() => setIsNewOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Receive Goods</span>
          </button>
        </div>
      </div>

      {/* Purchases List */}
      <div className="flex-1 overflow-auto p-4">
        <div className="bg-white rounded border border-slate-200 overflow-hidden">
          <table className="w-full text-left text-xs text-slate-700">
            <thead className="bg-slate-50 text-slate-600 uppercase font-semibold text-[10px] tracking-wider border-b border-slate-200">
              <tr>
                <th className="py-2.5 px-3 font-mono">Order Number</th>
                <th className="py-2.5 px-3">Invoice Number</th>
                <th className="py-2.5 px-3">Supplier Name</th>
                <th className="py-2.5 px-3">Received Date</th>
                <th className="py-2.5 px-3 text-right">Items Count</th>
                <th className="py-2.5 px-3 text-right">Invoice Total</th>
                <th className="py-2.5 px-3 text-center">Status</th>
                <th className="py-2.5 px-3">Received By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {purchases.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400">
                    No purchase orders or goods receipts recorded yet. Click "Receive Goods" to intake stock.
                  </td>
                </tr>
              ) : (
                purchases.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50 transition">
                    <td className="py-2 px-3 font-mono font-semibold text-slate-900">{p.order_number}</td>
                    <td className="py-2 px-3 font-mono text-slate-700">{p.invoice_number}</td>
                    <td className="py-2 px-3 font-medium text-slate-900">{p.supplier_name}</td>
                    <td className="py-2 px-3 font-mono text-slate-600">{p.order_date}</td>
                    <td className="py-2 px-3 text-right font-mono">{p.items.length} items</td>
                    <td className="py-2 px-3 text-right font-mono font-bold text-slate-900">
                      {settings.currency} {p.total_amount.toFixed(2)}
                    </td>
                    <td className="py-2 px-3 text-center">
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
                        <span className="capitalize text-slate-700">{p.status}</span>
                      </span>
                    </td>
                    <td className="py-2 px-3 text-slate-500">{p.created_by}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* RECEIVE GOODS MODAL */}
      {isNewOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="w-full max-w-3xl bg-white rounded border border-slate-300 shadow-lg overflow-hidden text-slate-800">
            <div className="bg-slate-900 px-5 py-3 text-white flex justify-between items-center">
              <span className="font-bold text-xs">
                Receive Goods &amp; Create Medicine Batches
              </span>
              <button onClick={() => setIsNewOpen(false)} className="text-slate-400 hover:text-white p-1 rounded cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleReceiveStockPO} className="p-5 space-y-4 max-h-[80vh] overflow-y-auto text-xs">

              {error && (
                <div className="p-2.5 rounded bg-rose-50 border border-rose-200 text-rose-700 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-rose-500" />
                  <span>{error}</span>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Select Supplier *</label>
                  <select
                    value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded bg-white"
                  >
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-bold text-slate-700 mb-1">Supplier Invoice Number *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. INV-HRL-9801"
                    value={invoiceNumber}
                    onChange={(e) => setInvoiceNumber(e.target.value.toUpperCase())}
                    className="w-full p-2 border border-slate-300 rounded font-mono uppercase"
                  />
                </div>
              </div>

              {/* Item Line Inputs */}
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
                <div className="font-bold text-slate-800 uppercase tracking-wider text-[11px]">
                  Add Medicine Batch to Receipt
                </div>

                <div className="space-y-2">
                  <MedicineSelector
                    medicines={medicines}
                    selectedMedicineId={selectedMedId}
                    onSelect={(m) => {
                      if (m) {
                        setSelectedMedId(m.id);
                        setPurchasePrice(m.purchase_price);
                      }
                    }}
                    label="Medicine Item (Search 2,000+ Items) *"
                    placeholder="Search by name, generic, brand, strength, barcode..."
                    currency={settings.currency}
                  />

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] font-bold text-slate-600 mb-0.5">Batch Number *</label>
                      <input
                        type="text"
                        placeholder="e.g. PCM-2603-A"
                        value={batchNumber}
                        onChange={(e) => setBatchNumber(e.target.value.toUpperCase())}
                        className="w-full p-1.5 border border-slate-300 rounded font-mono uppercase text-xs"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-slate-600 mb-0.5">Expiry Date *</label>
                      <input
                        type="date"
                        value={expiryDate}
                        onChange={(e) => setExpiryDate(e.target.value)}
                        className="w-full p-1.5 border border-slate-300 rounded text-xs"
                      />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 items-end">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-600 mb-0.5">Quantity Received *</label>
                    <input
                      type="number"
                      min="1"
                      value={quantity}
                      onChange={(e) => setQuantity(parseInt(e.target.value) || 0)}
                      className="w-full p-1.5 border border-slate-300 rounded font-mono text-xs"
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold text-slate-600 mb-0.5">Purchase Unit Cost ({settings.currency})</label>
                    <input
                      type="number"
                      step="0.01"
                      value={purchasePrice}
                      onChange={(e) => setPurchasePrice(parseFloat(e.target.value) || 0)}
                      className="w-full p-1.5 border border-slate-300 rounded font-mono text-xs"
                    />
                  </div>

                  <div>
                    <button
                      type="button"
                      onClick={handleAddItemToPO}
                      className="w-full py-1.5 px-3 rounded bg-slate-800 hover:bg-slate-900 text-white font-bold text-xs"
                    >
                      + Add Batch Item
                    </button>
                  </div>
                </div>
              </div>

              {/* Items Table */}
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-left text-xs text-slate-700">
                  <thead className="bg-slate-100 font-bold text-[10px] uppercase text-slate-600">
                    <tr>
                      <th className="py-2 px-3">Medicine</th>
                      <th className="py-2 px-3">Batch #</th>
                      <th className="py-2 px-3">Expiry</th>
                      <th className="py-2 px-3 text-right">Qty</th>
                      <th className="py-2 px-3 text-right">Cost</th>
                      <th className="py-2 px-3 text-right">Total</th>
                      <th className="py-2 px-3 text-center">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-4 text-center text-slate-400">
                          No items added yet. Fill out the batch row above and click "+ Add Batch Item".
                        </td>
                      </tr>
                    ) : (
                      items.map((it, idx) => (
                        <tr key={idx}>
                          <td className="py-2 px-3 font-semibold">{it.medicine_name}</td>
                          <td className="py-2 px-3 font-mono">{it.batch_number}</td>
                          <td className="py-2 px-3 font-mono">{it.expiry_date}</td>
                          <td className="py-2 px-3 text-right font-mono">{it.quantity}</td>
                          <td className="py-2 px-3 text-right font-mono">{settings.currency} {it.purchase_price.toFixed(2)}</td>
                          <td className="py-2 px-3 text-right font-mono font-bold">{settings.currency} {it.total.toFixed(2)}</td>
                          <td className="py-2 px-3 text-center">
                            <button
                              type="button"
                              onClick={() => handleRemoveItem(idx)}
                              className="text-rose-600 hover:text-rose-800 font-bold"
                            >
                              &times;
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-slate-200">
                <div className="font-bold text-sm">
                  Total Order Amount: <span className="text-teal-900 font-mono font-black">{settings.currency} {items.reduce((s, i) => s + i.total, 0).toFixed(2)}</span>
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setIsNewOpen(false)}
                    className="px-4 py-2 rounded border border-slate-300 font-semibold text-slate-700"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting || items.length === 0}
                    className="px-5 py-2 rounded bg-teal-600 hover:bg-teal-700 text-white font-bold cursor-pointer disabled:opacity-50"
                  >
                    {isSubmitting ? 'Receiving Stock...' : 'Confirm Goods Intake & Update Batches'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
