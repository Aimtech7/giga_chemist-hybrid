import React, { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, Trash2, Archive, X, ShieldAlert, Loader2, RotateCcw } from 'lucide-react';
import type { Medicine } from '../../types';
import { apiFetch } from '../../services/http';

export interface DeletePreviewData {
  medicine: {
    id: string;
    name: string;
    sku: string | null;
    barcode: string | null;
    current_stock: number;
    status: string;
    version: number;
  };
  references: {
    sales: number;
    sale_items: number;
    purchases: number;
    purchase_items: number;
    returns: number;
    inventory_movements: number;
    stocktake_lines: number;
    active_batches: number;
    pending_sync_events: number;
  };
  total_historical_references: number;
  has_stock: boolean;
  has_pending_sync: boolean;
  outcome: 'PERMANENT_DELETE' | 'ARCHIVE_REQUIRED';
  block_reason: string | null;
  shop_update_required?: boolean;
  shop_update_message?: string | null;
  disclaimer?: string;
}

interface DeleteMedicineModalProps {
  isOpen: boolean;
  onClose: () => void;
  medicine: Medicine | null;
  onDeleted: (result: { action: 'DELETED' | 'ARCHIVED'; reason: string }) => void;
  /** When true, runs in remote mode calling online command API */
  isRemote?: boolean;
  shopId?: string;
}

export const DeleteMedicineModal: React.FC<DeleteMedicineModalProps> = ({
  isOpen,
  onClose,
  medicine,
  onDeleted,
  isRemote = false,
  shopId,
}) => {
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<DeletePreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmInput, setConfirmInput] = useState('');
  const [reason, setReason] = useState('');

  const fetchPreview = useCallback(async () => {
    if (!medicine) return;
    setLoading(true);
    setError(null);

    try {
      const url = isRemote && shopId
        ? `/api/admin/medicines/${medicine.id}/delete-preview?shop_id=${shopId}`
        : `/api/medicines/${medicine.id}/delete-preview`;

      const data = await apiFetch<DeletePreviewData>(url);
      setPreview(data);
    } catch (err: any) {
      setPreview(null);
      setError(err?.message || 'DELETION ELIGIBILITY COULD NOT BE DETERMINED');
    } finally {
      setLoading(false);
    }
  }, [medicine, isRemote, shopId]);

  useEffect(() => {
    if (!isOpen || !medicine) {
      setPreview(null);
      setError(null);
      setConfirmInput('');
      setReason('');
      return;
    }

    void fetchPreview();
  }, [isOpen, medicine, fetchPreview]);

  if (!isOpen || !medicine) return null;

  const isPermanent = preview?.outcome === 'PERMANENT_DELETE';
  const hasStock = (preview?.medicine.current_stock || medicine.current_stock || 0) > 0;
  const isConfirmValid = isPermanent
    ? confirmInput.trim().toUpperCase() === 'DELETE' || confirmInput.trim() === medicine.name.trim()
    : true;
  const canSubmit = Boolean(
    preview &&
    !hasStock &&
    !preview.has_pending_sync &&
    !preview.shop_update_required &&
    isConfirmValid &&
    !submitting
  );

  const handleDelete = async () => {
    if (!canSubmit || !preview) return;
    setSubmitting(true);
    setError(null);

    try {
      let data: any;
      if (isRemote && shopId) {
        data = await apiFetch('/api/admin/commands/medicine-delete', {
          method: 'POST',
          body: {
            medicine_id: medicine.id,
            expected_version: preview.medicine.version,
            expected_status: preview.medicine.status,
            expected_current_stock: preview.medicine.current_stock,
            reason: reason.trim() || undefined,
          },
        });
      } else {
        data = await apiFetch(`/api/medicines/${medicine.id}`, {
          method: 'DELETE',
          body: {
            expected_version: preview.medicine.version,
            expected_status: preview.medicine.status,
            expected_current_stock: preview.medicine.current_stock,
            reason: reason.trim() || undefined,
          },
        });
      }

      onDeleted({
        action: data.action || (isPermanent ? 'DELETED' : 'ARCHIVED'),
        reason: data.reason || 'Completed successfully',
      });
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Delete operation failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden animate-in fade-in zoom-in duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50">
          <div className="flex items-center gap-2.5">
            <div className={`p-2 rounded-lg ${
              preview?.outcome === 'PERMANENT_DELETE'
                ? 'bg-rose-100 text-rose-700'
                : preview?.outcome === 'ARCHIVE_REQUIRED'
                  ? 'bg-amber-100 text-amber-700'
                  : 'bg-slate-100 text-slate-700'
            }`}>
              {preview?.outcome === 'PERMANENT_DELETE' ? (
                <Trash2 className="w-5 h-5" />
              ) : preview?.outcome === 'ARCHIVE_REQUIRED' ? (
                <Archive className="w-5 h-5" />
              ) : (
                <ShieldAlert className="w-5 h-5 text-slate-500" />
              )}
            </div>
            <div>
              <h3 className="font-bold text-slate-900 text-base">Delete Medicine</h3>
              <p className="text-xs text-slate-500 font-mono">{medicine.name}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200/50 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
          {loading ? (
            <div className="py-12 flex flex-col items-center justify-center gap-3 text-slate-500">
              <Loader2 className="w-8 h-8 animate-spin text-teal-600" />
              <p className="text-sm font-medium">Auditing historical business references...</p>
            </div>
          ) : (
            <>
              {error && (
                <div className="p-4 bg-rose-50 border border-rose-300 rounded-xl space-y-2 text-rose-900 text-xs">
                  <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-[11px] text-rose-800">
                    <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                    DELETION ELIGIBILITY COULD NOT BE DETERMINED
                  </div>
                  <p className="text-xs text-rose-700">
                    {error}
                  </p>
                  <div>
                    <button
                      type="button"
                      onClick={() => void fetchPreview()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-700 hover:bg-rose-800 text-white font-medium text-xs transition cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Retry Preview
                    </button>
                  </div>
                </div>
              )}

              {/* Medicine & Stock Identity Card */}
              <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2 text-xs">
                <div className="flex justify-between items-center font-medium">
                  <span className="text-slate-500">Medicine:</span>
                  <span className="font-semibold text-slate-900">{medicine.name}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">SKU / Barcode:</span>
                  <span className="font-mono text-slate-700">{medicine.sku || '—'} / {medicine.barcode || '—'}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">Current Stock:</span>
                  <span className={`font-mono font-bold ${hasStock ? 'text-rose-600' : 'text-slate-700'}`}>
                    {preview?.medicine.current_stock ?? medicine.current_stock} {medicine.unit}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">Active Batches:</span>
                  <span className="font-mono text-slate-700">{preview?.references.active_batches ?? '—'}</span>
                </div>
              </div>

              {/* Shop Update Required Alert */}
              {preview?.shop_update_required && (
                <div className="p-3 bg-amber-50 border border-amber-300 rounded-xl flex items-start gap-2.5 text-amber-900 text-xs font-medium">
                  <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
                  <div>
                    <div className="font-bold uppercase tracking-wider text-[10px] text-amber-800">SHOP UPDATE REQUIRED</div>
                    <div className="mt-0.5 leading-relaxed">
                      {preview.shop_update_message || 'Shop 1 must install the current GIGA CHEMIST release before Medicine Delete can be used.'}
                    </div>
                  </div>
                </div>
              )}

              {/* Stock Block Alert */}
              {hasStock && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-2.5 text-rose-800 text-xs font-medium">
                  <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
                  <div>
                    This medicine currently has <strong className="font-bold">{preview?.medicine.current_stock ?? medicine.current_stock} units</strong> of stock.
                    You cannot delete or archive a medicine with active stock. Stock must be reduced to 0 first through physical count or adjustment.
                  </div>
                </div>
              )}

              {/* Pending Sync Block Alert */}
              {preview?.has_pending_sync && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2.5 text-amber-800 text-xs font-medium">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
                  <div>
                    Unsynced events exist in the outbox for this medicine. Wait for sync to complete before deleting.
                  </div>
                </div>
              )}

              {/* Historical References Breakdown */}
              {preview && (
                <div className="border border-slate-200 rounded-xl overflow-hidden text-xs">
                  <div className="px-3.5 py-2 bg-slate-100 font-semibold text-slate-700 flex justify-between items-center">
                    <span>Historical Business References</span>
                    <span className="font-mono bg-white px-2 py-0.5 rounded border border-slate-300">
                      Total: {preview.total_historical_references}
                    </span>
                  </div>
                  <div className="p-3.5 grid grid-cols-2 gap-2 text-slate-600">
                    <div className="flex justify-between py-1 border-b border-slate-100">
                      <span>Sales:</span>
                      <span className="font-mono font-semibold">{preview.references.sales}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-100">
                      <span>Sale Items:</span>
                      <span className="font-mono font-semibold">{preview.references.sale_items}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-100">
                      <span>Purchases:</span>
                      <span className="font-mono font-semibold">{preview.references.purchases}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-100">
                      <span>Purchase Items:</span>
                      <span className="font-mono font-semibold">{preview.references.purchase_items}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-100">
                      <span>Returns:</span>
                      <span className="font-mono font-semibold">{preview.references.returns}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-100">
                      <span>Stock Movements:</span>
                      <span className="font-mono font-semibold">{preview.references.inventory_movements}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-100 col-span-2">
                      <span>Stocktake Lines:</span>
                      <span className="font-mono font-semibold">{preview.references.stocktake_lines}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Decided Outcome Card */}
              {preview && (
                <div className={`p-4 rounded-xl border ${
                  isPermanent ? 'bg-rose-50/50 border-rose-200 text-rose-900' : 'bg-amber-50/50 border-amber-200 text-amber-900'
                }`}>
                  <div className="flex items-center gap-2 mb-1.5 font-bold text-xs uppercase tracking-wider">
                    {isPermanent ? (
                      <span className="px-2 py-0.5 rounded bg-rose-600 text-white font-mono text-[10px]">
                        PERMANENT DELETE
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded bg-amber-600 text-white font-mono text-[10px]">
                        ARCHIVE REQUIRED
                      </span>
                    )}
                  </div>
                  <p className="text-xs leading-relaxed">
                    {isPermanent
                      ? 'This medicine has ZERO historical references and ZERO stock. It will be permanently removed from the database inside an atomic transaction.'
                      : 'This medicine has historical business records and cannot be permanently erased without corrupting financial audits. It will be removed from active POS and archived.'}
                  </p>
                  <p className="text-[10px] text-slate-500 italic mt-2 pt-2 border-t border-slate-200/60">
                    Final outcome will be decided using the shop's live PostgreSQL database. {preview.disclaimer || 'Final deletion eligibility is rechecked by the shop computer.'}
                  </p>
                </div>
              )}

              {/* Confirmation Input for Permanent Delete */}
              {isPermanent && !hasStock && !preview?.shop_update_required && (
                <div className="space-y-1.5 pt-1">
                  <label className="text-xs font-semibold text-slate-700">
                    Type <span className="font-mono text-rose-600 font-bold">DELETE</span> or medicine name to confirm permanent destruction:
                  </label>
                  <input
                    type="text"
                    value={confirmInput}
                    onChange={(e) => setConfirmInput(e.target.value)}
                    placeholder="Type DELETE to confirm"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-mono focus:ring-2 focus:ring-rose-500 outline-none"
                  />
                </div>
              )}

              {/* Reason Input */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-600">
                  Reason for deletion / archive (optional):
                </label>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Catalogue cleanup, discontinued, entry error"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs focus:ring-2 focus:ring-teal-600 outline-none"
                />
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-slate-100 bg-slate-50">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 border border-slate-300 rounded-lg text-xs font-medium text-slate-700 hover:bg-slate-100 transition cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={!canSubmit}
            className={`px-4 py-2 rounded-lg text-xs font-semibold text-white transition cursor-pointer flex items-center gap-1.5 ${
              !preview
                ? 'bg-slate-300 cursor-not-allowed disabled:opacity-50'
                : isPermanent
                  ? 'bg-rose-600 hover:bg-rose-700 disabled:bg-rose-300'
                  : 'bg-amber-600 hover:bg-amber-700 disabled:bg-amber-300'
            }`}
          >
            {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {preview?.outcome === 'PERMANENT_DELETE'
              ? 'Permanently Delete'
              : preview?.outcome === 'ARCHIVE_REQUIRED'
                ? 'Archive Medicine'
                : 'Delete Medicine'}
          </button>
        </div>
      </div>
    </div>
  );
};
