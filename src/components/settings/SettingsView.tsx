import React, { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Save, Download, RotateCcw, AlertTriangle, CheckCircle, ShieldCheck, Printer } from 'lucide-react';
import { db, getDeviceId, getSettings, saveSettings, seedInitialData } from '../../db/dexie';
import { apiUrl } from '../../services/api';
import type { PharmacySettings, User } from '../../types';

interface SettingsViewProps {
  currentUser: User | null;
  settings: PharmacySettings;
  onSettingsUpdated: (updated: PharmacySettings) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ currentUser, settings, onSettingsUpdated }) => {
  const [formData, setFormData] = useState<PharmacySettings>(settings);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const isAdmin = currentUser?.role === 'ADMIN';

  useEffect(() => {
    setFormData(settings);
  }, [settings]);

  if (!isAdmin) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-center">
        <div className="max-w-md p-6 bg-white rounded-lg border border-slate-200 shadow-xs">
          <AlertTriangle className="w-10 h-10 text-rose-500 mx-auto mb-2" />
          <h2 className="text-base font-bold text-slate-900">Admin Only Access</h2>
          <p className="text-xs text-slate-600 mt-1">
            System configuration and thermal printer settings are restricted to Administrators.
          </p>
        </div>
      </div>
    );
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const updated: PharmacySettings = {
        ...formData,
        updated_at: new Date().toISOString(),
      };
      await saveSettings(updated);
      onSettingsUpdated(updated);

      // Audit log
      const deviceId = await getDeviceId();
      await db.audit_logs.put({
        id: `aud-set-${Date.now()}`,
        user_id: currentUser?.id || 'admin',
        user_name: currentUser?.name || 'Admin',
        role: 'ADMIN',
        action: 'PHARMACY_SETTINGS_UPDATED',
        entity: 'settings',
        entity_id: 'pharmacy_settings',
        new_value: JSON.stringify({ name: updated.pharmacy_name, printer: updated.printer_type }),
        device_id: deviceId,
        timestamp: Date.now(),
        date: new Date().toISOString().split('T')[0],
      });

      // Call server PUT /api/settings if online
      try {
        await fetch(apiUrl('/api/settings'), {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'x-user-role': 'ADMIN',
          },
          body: JSON.stringify(updated),
        });
      } catch (e) {}

      setSuccessMessage('Pharmacy settings updated successfully.');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: any) {
      alert(err?.message || 'Failed to save settings.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleExportFullBackup = async () => {
    const [medicines, batches, movements, sales, held, returns, suppliers, purchases, customers, expenses, logs, setRec] =
      await Promise.all([
        db.medicines.toArray(),
        db.medicine_batches.toArray(),
        db.inventory_movements.toArray(),
        db.sales.toArray(),
        db.held_sales.toArray(),
        db.customer_returns.toArray(),
        db.suppliers.toArray(),
        db.purchases.toArray(),
        db.customers.toArray(),
        db.expenses.toArray(),
        db.audit_logs.toArray(),
        db.settings.get('pharmacy_settings'),
      ]);

    const backupDump = {
      version: '1.0.0-pwa',
      exported_at: new Date().toISOString(),
      system: 'GIGA CHEMIST Backup',
      data: {
        medicines,
        batches,
        movements,
        sales,
        held,
        returns,
        suppliers,
        purchases,
        customers,
        expenses,
        audit_logs: logs,
        settings: setRec?.value || settings,
      },
    };

    const blob = new Blob([JSON.stringify(backupDump, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `giga-chemist-full-backup-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleResetDemoData = async () => {
    if (
      !confirm(
        'Are you sure you want to reset all records to the clean initial demo dataset? This will clear all transactions.'
      )
    ) {
      return;
    }

    setIsResetting(true);
    try {
      await seedInitialData(true);
      window.location.reload();
    } catch (err: any) {
      alert(err?.message || 'Reset failed.');
      setIsResetting(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      <div className="p-4 bg-white border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 shrink-0">
        <div>
          <h1 className="text-base font-bold text-slate-900 tracking-tight">
            Settings
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Store identity, currency, thermal receipt layout, and database backups.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleExportFullBackup}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-medium transition cursor-pointer"
          >
            <Download className="w-3.5 h-3.5 text-slate-600" />
            <span>Download Database Backup</span>
          </button>
        </div>
      </div>

      {successMessage && (
        <div className="mx-4 mt-3 p-3 bg-emerald-50 border border-emerald-300 text-emerald-800 rounded text-xs flex items-center gap-2">
          <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}

      <form onSubmit={handleSave} className="flex-1 overflow-auto p-4 md:p-6 space-y-4 text-xs max-w-4xl">
        {/* Pharmacy Details */}
        <div className="bg-white p-5 rounded border border-slate-200 space-y-4">
          <div className="font-semibold text-xs text-slate-900 border-b border-slate-100 pb-2">
            Pharmacy Store Identity
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-slate-700 mb-1">Pharmacy Business Name *</label>
              <input
                type="text"
                required
                value={formData.pharmacy_name}
                onChange={(e) => setFormData({ ...formData, pharmacy_name: e.target.value })}
                className="w-full p-2 border border-slate-300 rounded font-semibold text-slate-900 focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">Tagline / Motto</label>
              <input
                type="text"
                value={formData.tagline}
                onChange={(e) => setFormData({ ...formData, tagline: e.target.value })}
                className="w-full p-2 border border-slate-300 rounded text-slate-700 focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">Physical Location Address *</label>
              <input
                type="text"
                required
                value={formData.address}
                onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">Telephone Contact *</label>
              <input
                type="text"
                required
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                className="w-full p-2 border border-slate-300 rounded font-mono focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">Official Email</label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">Currency Code *</label>
              <input
                type="text"
                required
                value={formData.currency}
                onChange={(e) => setFormData({ ...formData, currency: e.target.value.toUpperCase() })}
                className="w-full p-2 border border-slate-300 rounded font-mono font-bold uppercase focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
              />
            </div>
          </div>
        </div>

        {/* Printer & Receipt Configuration */}
        <div className="bg-white p-5 rounded border border-slate-200 space-y-4">
          <div className="font-semibold text-xs text-slate-900 border-b border-slate-100 pb-2">
            Thermal Receipt Printer Setup
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-slate-700 mb-1">Thermal Paper Roll Width *</label>
              <select
                value={formData.printer_type}
                onChange={(e) => setFormData({ ...formData, printer_type: e.target.value as any })}
                className="w-full p-2 border border-slate-300 rounded bg-white font-medium focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
              >
                <option value="80mm">80mm Thermal Receipt (Standard Desktop POS)</option>
                <option value="58mm">58mm Thermal Receipt (Compact / Mobile Bluetooth)</option>
              </select>
            </div>

            <div className="flex items-center gap-2 pt-6">
              <input
                type="checkbox"
                id="autoprint"
                checked={formData.auto_print_receipt}
                onChange={(e) => setFormData({ ...formData, auto_print_receipt: e.target.checked })}
                className="w-4 h-4 text-teal-700 rounded"
              />
              <label htmlFor="autoprint" className="font-semibold text-slate-800">
                Automatically trigger print dialog upon sale tender
              </label>
            </div>

            <div className="md:col-span-2">
              <label className="block font-semibold text-slate-700 mb-1">Custom Receipt Footer Message</label>
              <textarea
                rows={3}
                value={formData.receipt_footer}
                onChange={(e) => setFormData({ ...formData, receipt_footer: e.target.value })}
                className="w-full p-2 border border-slate-300 rounded font-mono focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
              />
            </div>
          </div>
        </div>

        {/* Clinical Thresholds */}
        <div className="bg-white p-5 rounded border border-slate-200 space-y-4">
          <div className="font-semibold text-xs text-slate-900 border-b border-slate-100 pb-2">
            Stock Safety &amp; Expiry Thresholds
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-slate-700 mb-1">Default Low Stock Alert Level</label>
              <input
                type="number"
                min="1"
                value={formData.low_stock_threshold}
                onChange={(e) => setFormData({ ...formData, low_stock_threshold: parseInt(e.target.value) || 20 })}
                className="w-full p-2 border border-slate-300 rounded font-mono font-bold focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">Expiry Warning Lead Time (Days)</label>
              <input
                type="number"
                min="15"
                max="365"
                value={formData.expiry_warning_days}
                onChange={(e) => setFormData({ ...formData, expiry_warning_days: parseInt(e.target.value) || 90 })}
                className="w-full p-2 border border-slate-300 rounded font-mono font-bold focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
              />
            </div>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={handleResetDemoData}
            disabled={isResetting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-rose-300 text-rose-700 hover:bg-rose-50 text-xs font-semibold transition cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Database to Clean Demo Records</span>
          </button>

          <button
            type="submit"
            disabled={isSaving}
            className="flex items-center gap-2 px-5 py-2 rounded bg-teal-700 hover:bg-teal-800 text-white font-semibold text-xs transition cursor-pointer disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            <span>{isSaving ? 'Saving...' : 'Save Configuration'}</span>
          </button>
        </div>
      </form>
    </div>
  );
};
