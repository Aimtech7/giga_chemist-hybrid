import React, { useState, useEffect } from 'react';
import { Pill, X, AlertTriangle, ShieldCheck } from 'lucide-react';
import { db } from '../../db/dexie';
import { apiFetch } from '../../services/http';
import type { Category, Medicine, DosageForm, PharmacySettings, User } from '../../types';

interface MedicineFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  medicine: Medicine | null;
  settings: PharmacySettings;
  currentUser: User | null;
  onSaved: () => void;
}

export const MedicineFormModal: React.FC<MedicineFormModalProps> = ({
  isOpen,
  onClose,
  medicine,
  settings,
  currentUser,
  onSaved,
}) => {
  const [formData, setFormData] = useState<Partial<Medicine>>({
    name: '',
    generic_name: '',
    brand_name: '',
    sku: '',
    barcode: '',
    category: '',
    medicine_type: 'Pain Relief',
    dosage_strength: '500mg',
    dosage_form: 'Tablet',
    manufacturer: '',
    description: '',
    purchase_price: 5,
    selling_price: 15,
    wholesale_price: 12,
    min_selling_price: 10,
    reorder_level: 30,
    unit: 'Strips (10 tabs)',
    prescription_required: false,
    status: 'active',
  });

  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);

  // Category choices are the real PostgreSQL categories hydrated into Dexie.
  useEffect(() => {
    if (isOpen) db.categories.orderBy('name').toArray().then(setCategories).catch(() => setCategories([]));
  }, [isOpen]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (medicine) {
      setFormData(medicine);
    } else {
      setFormData({
        name: '',
        generic_name: '',
        brand_name: '',
        sku: `MED-${Math.floor(1000 + Math.random() * 9000)}`,
        barcode: `6164${Math.floor(10000000 + Math.random() * 90000000)}`,
        category: '',
        medicine_type: 'General Medicine',
        dosage_strength: '500mg',
        dosage_form: 'Tablet',
        manufacturer: 'Cosmos Limited',
        description: '',
        purchase_price: 10,
        selling_price: 25,
        wholesale_price: 20,
        min_selling_price: 18,
        reorder_level: 20,
        unit: 'Strips (10 tabs)',
        prescription_required: false,
        status: 'active',
      });
    }
  }, [medicine, isOpen]);

  if (!isOpen) return null;

  // Strict RBAC UI gate
  if (currentUser?.role !== 'ADMIN') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div className="bg-white p-6 rounded-lg max-w-sm text-center">
          <AlertTriangle className="w-10 h-10 text-rose-500 mx-auto mb-2" />
          <h3 className="font-bold text-sm text-slate-900">Access Restricted</h3>
          <p className="text-xs text-slate-600 mt-1">
            Only users with the <strong className="text-rose-600">ADMIN</strong> role are permitted to create or modify medicine definitions and prices.
          </p>
          <button
            onClick={onClose}
            className="mt-4 px-4 py-2 bg-slate-900 text-white rounded text-xs font-semibold"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  const dosageForms: DosageForm[] = [
    'Tablet',
    'Capsule',
    'Syrup',
    'Suspension',
    'Injection',
    'Cream',
    'Ointment',
    'Drops',
    'Inhaler',
    'Powder',
    'Suppository',
    'Solution',
    'Other',
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!formData.name?.trim()) {
      setError('Medicine name is required.');
      return;
    }

    if (Number(formData.selling_price) <= 0) {
      setError('Selling price must be greater than zero.');
      return;
    }

    setIsSubmitting(true);
    try {
      // PostgreSQL first: the cache only ever receives the committed server record.
      const payload = {
        ...formData,
        purchase_price: Number(formData.purchase_price) || 0,
        selling_price: Number(formData.selling_price) || 0,
        wholesale_price: Number(formData.wholesale_price) || 0,
        min_selling_price: Number(formData.min_selling_price) || 0,
        reorder_level: Number(formData.reorder_level) || 0,
      };
      // Stock is never edited from this form (use Stock Management / Physical Count).
      delete (payload as any).current_stock;
      const { medicine: saved } = medicine
        ? await apiFetch<{ medicine: Medicine }>(`/api/medicines/${medicine.id}`, { method: 'PUT', body: payload })
        : await apiFetch<{ medicine: Medicine }>('/api/medicines', { method: 'POST', body: payload });
      await db.medicines.put(saved);

      onSaved();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to save medicine.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="w-full max-w-2xl bg-white rounded-lg shadow-2xl border border-slate-200 overflow-hidden text-slate-800 animate-in fade-in zoom-in-95 duration-150">
        <div className="bg-slate-900 px-5 py-3 text-white flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Pill className="w-4 h-4 text-teal-400" />
            <span className="font-bold text-xs uppercase tracking-wider">
              {medicine ? 'Edit Medicine Master Record' : 'Add New Pharmacy Medicine'}
            </span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white p-1 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 max-h-[78vh] overflow-y-auto">
          {error && (
            <div className="p-2.5 rounded bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-500" />
              <span>{error}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 text-xs">
            {/* Commercial Name */}
            <div>
              <label className="block font-bold text-slate-700 mb-1">Medicine Name *</label>
              <input
                type="text"
                required
                placeholder="e.g. Paracetamol 500mg"
                value={formData.name || ''}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="w-full p-2 border border-slate-300 rounded focus:ring-2 focus:ring-teal-500 focus:outline-hidden"
              />
            </div>

            {/* Generic Name */}
            <div>
              <label className="block font-bold text-slate-700 mb-1">Generic Name / Molecule *</label>
              <input
                type="text"
                required
                placeholder="e.g. Paracetamol (Acetaminophen)"
                value={formData.generic_name || ''}
                onChange={(e) => setFormData({ ...formData, generic_name: e.target.value })}
                className="w-full p-2 border border-slate-300 rounded focus:ring-2 focus:ring-teal-500 focus:outline-hidden"
              />
            </div>

            {/* Brand Name */}
            <div>
              <label className="block font-bold text-slate-700 mb-1">Brand Name</label>
              <input
                type="text"
                placeholder="e.g. Panadol"
                value={formData.brand_name || ''}
                onChange={(e) => setFormData({ ...formData, brand_name: e.target.value })}
                className="w-full p-2 border border-slate-300 rounded"
              />
            </div>

            {/* Category */}
            <div>
              <label className="block font-bold text-slate-700 mb-1">Pharmacological Category</label>
              <select
                value={formData.category || ''}
                onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                className="w-full p-2 border border-slate-300 rounded bg-white"
              >
                <option value="">— Select category —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
                {formData.category && !categories.some((c) => c.name === formData.category) && (
                  <option value={formData.category}>{formData.category}</option>
                )}
              </select>
            </div>

            {/* Dosage Form */}
            <div>
              <label className="block font-bold text-slate-700 mb-1">Dosage Form</label>
              <select
                value={formData.dosage_form || 'Tablet'}
                onChange={(e) => setFormData({ ...formData, dosage_form: e.target.value as DosageForm })}
                className="w-full p-2 border border-slate-300 rounded bg-white"
              >
                {dosageForms.map((df) => (
                  <option key={df} value={df}>
                    {df}
                  </option>
                ))}
              </select>
            </div>

            {/* Dosage Strength */}
            <div>
              <label className="block font-bold text-slate-700 mb-1">Dosage Strength</label>
              <input
                type="text"
                placeholder="e.g. 500mg, 10mg, 125mg/5ml"
                value={formData.dosage_strength || ''}
                onChange={(e) => setFormData({ ...formData, dosage_strength: e.target.value })}
                className="w-full p-2 border border-slate-300 rounded"
              />
            </div>

            {/* Barcode */}
            <div>
              <label className="block font-bold text-slate-700 mb-1">Barcode (EAN-13 / UPC)</label>
              <input
                type="text"
                placeholder="e.g. 616400010012"
                value={formData.barcode || ''}
                onChange={(e) => setFormData({ ...formData, barcode: e.target.value })}
                className="w-full p-2 border border-slate-300 rounded font-mono"
              />
            </div>

            {/* SKU */}
            <div>
              <label className="block font-bold text-slate-700 mb-1">SKU / Item Code</label>
              <input
                type="text"
                placeholder="e.g. MED-PCM-500"
                value={formData.sku || ''}
                onChange={(e) => setFormData({ ...formData, sku: e.target.value })}
                className="w-full p-2 border border-slate-300 rounded font-mono"
              />
            </div>

            {/* Manufacturer */}
            <div>
              <label className="block font-bold text-slate-700 mb-1">Manufacturer</label>
              <input
                type="text"
                placeholder="e.g. GlaxoSmithKline"
                value={formData.manufacturer || ''}
                onChange={(e) => setFormData({ ...formData, manufacturer: e.target.value })}
                className="w-full p-2 border border-slate-300 rounded"
              />
            </div>

            {/* Unit */}
            <div>
              <label className="block font-bold text-slate-700 mb-1">Unit of Measure</label>
              <input
                type="text"
                placeholder="e.g. Strips (10 tabs)"
                value={formData.unit || ''}
                onChange={(e) => setFormData({ ...formData, unit: e.target.value })}
                className="w-full p-2 border border-slate-300 rounded"
              />
            </div>

            {/* Purchase Price (Admin Only) */}
            <div className="bg-slate-50 p-2.5 rounded border border-slate-200">
              <label className="block font-bold text-slate-800 mb-1">
                Purchase Cost Price ({settings.currency}) *
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                required
                value={formData.purchase_price || ''}
                onChange={(e) => setFormData({ ...formData, purchase_price: parseFloat(e.target.value) || 0 })}
                className="w-full p-2 border border-slate-300 rounded font-mono font-bold bg-white"
              />
            </div>

            {/* Selling Price (Admin Only) */}
            <div className="bg-teal-50 p-2.5 rounded border border-teal-200">
              <label className="block font-bold text-teal-950 mb-1">
                Retail Selling Price ({settings.currency}) *
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                required
                value={formData.selling_price || ''}
                onChange={(e) => setFormData({ ...formData, selling_price: parseFloat(e.target.value) || 0 })}
                className="w-full p-2 border border-teal-300 rounded font-mono font-black text-teal-900 bg-white"
              />
            </div>

            {/* Reorder Level */}
            <div>
              <label className="block font-bold text-slate-700 mb-1">Reorder Level (Alert Threshold)</label>
              <input
                type="number"
                min="0"
                value={formData.reorder_level || ''}
                onChange={(e) => setFormData({ ...formData, reorder_level: parseInt(e.target.value) || 0 })}
                className="w-full p-2 border border-slate-300 rounded font-mono"
              />
            </div>

            {/* Prescription Check */}
            <div className="flex items-center gap-2 pt-5">
              <input
                type="checkbox"
                id="rx_req"
                checked={!!formData.prescription_required}
                onChange={(e) => setFormData({ ...formData, prescription_required: e.target.checked })}
                className="w-4 h-4 text-teal-600 rounded focus:ring-teal-500"
              />
              <label htmlFor="rx_req" className="font-bold text-rose-700">
                Prescription Mandatory (Rx)
              </label>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-5 py-2 rounded bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold shadow-xs cursor-pointer"
            >
              {isSubmitting ? 'Saving...' : medicine ? 'Save Price & Details' : 'Create Medicine'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
