import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AlertTriangle, Trash2, Archive, X, ShieldAlert, Loader2, RotateCcw, CheckCircle2, Clock } from 'lucide-react';
import type { Medicine } from '../../types';
import { apiFetch } from '../../services/http';

export interface AuthoritativePreflight {
  preflight_id: string;
  medicine_id: string;
  name: string;
  current_version: number;
  current_status: string;
  current_stock: number;
  active_batches: number;
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
  pending_local_sync: number;
  outcome: 'PERMANENT_DELETE' | 'ARCHIVE_REQUIRED' | 'BLOCKED';
  block_reason: string | null;
  generated_at: string;
  expires_at: string;
}

export type RemoteDeleteStep = 'IDLE' | 'QUEUING' | 'PENDING' | 'DELIVERED' | 'APPLIED' | 'REJECTED';

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
  const [loadingStage, setLoadingStage] = useState<string>('Querying local shop PostgreSQL...');
  const [preflight, setPreflight] = useState<AuthoritativePreflight | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStalePreflight, setIsStalePreflight] = useState(false);
  const [confirmInput, setConfirmInput] = useState('');
  const [reason, setReason] = useState('');

  // Remote execution lifecycle: IDLE -> QUEUING -> PENDING -> DELIVERED -> APPLIED (or REJECTED)
  const [remoteStep, setRemoteStep] = useState<RemoteDeleteStep>('IDLE');
  const [activeCommandId, setActiveCommandId] = useState<string | null>(null);
  const [isShopOffline, setIsShopOffline] = useState(false);
  const [completionResult, setCompletionResult] = useState<{ action: 'DELETED' | 'ARCHIVED'; reason: string } | null>(null);

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanupPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    return cleanupPolling;
  }, [cleanupPolling]);

  const fetchAuthoritativePreflight = useCallback(async () => {
    if (!medicine) return;
    cleanupPolling();
    setLoading(true);
    setError(null);
    setIsStalePreflight(false);
    setRemoteStep('IDLE');
    setCompletionResult(null);

    try {
      if (isRemote && shopId) {
        setLoadingStage('Requesting authoritative preflight from Shop 1 PostgreSQL...');
        const preflightUrl = `/api/admin/medicines/${medicine.id}/delete-preflight?shop_id=${shopId}`;
        const previewUrl = `/api/admin/medicines/${medicine.id}/delete-preview?shop_id=${shopId}`;
        const resp = await apiFetch<any>(preflightUrl || previewUrl, {
          method: 'POST',
          body: { reason: 'Authoritative preflight audit' },
        });

        if (resp.status === 'APPLIED' && resp.preflight) {
          setPreflight(resp.preflight);
          setLoading(false);
          return;
        }

        // Poll command status until APPLIED
        const cmdId = resp.command_id;
        setActiveCommandId(cmdId);
        let attempts = 0;
        const maxAttempts = 20;

        pollIntervalRef.current = setInterval(async () => {
          attempts++;
          try {
            const cmd = await apiFetch<any>(`/api/admin/commands/${cmdId}`);
            if (cmd.status === 'APPLIED' && cmd.result) {
              cleanupPolling();
              setPreflight(cmd.result);
              setLoading(false);
            } else if (cmd.status === 'REJECTED') {
              cleanupPolling();
              setLoading(false);
              setError(cmd.error || 'Shop 1 rejected delete preflight.');
            } else if (cmd.status === 'DELIVERED') {
              setLoadingStage('Shop 1 computing authoritative inventory & references...');
            } else if (attempts >= maxAttempts) {
              cleanupPolling();
              setLoading(false);
              setIsShopOffline(true);
              setError('WAITING FOR SHOP 1: Shop 1 has not picked up preflight request yet.');
            }
          } catch (pollErr: any) {
            cleanupPolling();
            setLoading(false);
            setError(pollErr?.message || 'Error communicating with cloud gateway.');
          }
        }, 1000);
      } else {
        // Local mode: direct local authority
        setLoadingStage('Auditing local historical references and stock...');
        const localPreflightUrl = `/api/medicines/${medicine.id}/delete-preflight`;
        const localPreviewUrl = `/api/medicines/${medicine.id}/delete-preview`;
        const data = await apiFetch<AuthoritativePreflight>(localPreflightUrl || localPreviewUrl, {
          method: 'POST',
          body: { reason: 'Authoritative preflight audit' },
        });
        setPreflight(data);
        setLoading(false);
      }
    } catch (err: any) {
      setPreflight(null);
      setLoading(false);
      if (err?.code === 'SHOP_UPDATE_REQUIRED' || err?.message?.includes('SHOP UPDATE REQUIRED')) {
        setError('SHOP UPDATE REQUIRED: This shop needs a software update before remote medicine operations can proceed.');
      } else {
        setError(err?.message || 'DELETION ELIGIBILITY COULD NOT BE DETERMINED');
      }
    }
  }, [medicine, isRemote, shopId, cleanupPolling]);

  useEffect(() => {
    if (!isOpen || !medicine) {
      cleanupPolling();
      setPreflight(null);
      setError(null);
      setIsStalePreflight(false);
      setConfirmInput('');
      setReason('');
      setRemoteStep('IDLE');
      setActiveCommandId(null);
      setCompletionResult(null);
      return;
    }

    void fetchAuthoritativePreflight();
  }, [isOpen, medicine, fetchAuthoritativePreflight, cleanupPolling]);

  if (!isOpen || !medicine) return null;

  const preview = preflight;
  const isPermanent = preview?.outcome === 'PERMANENT_DELETE';
  const hasStock = (preflight?.current_stock ?? medicine.current_stock ?? 0) > 0;
  const hasPendingSync = (preflight?.pending_local_sync ?? 0) > 0;
  const isBlocked = preflight?.outcome === 'BLOCKED' || hasStock || hasPendingSync;

  const isConfirmValid = isPermanent
    ? confirmInput.trim().toUpperCase() === 'DELETE' || confirmInput.trim().toLowerCase() === medicine.name.trim().toLowerCase()
    : true;

  const isBusy = loading || remoteStep === 'QUEUING' || remoteStep === 'PENDING' || remoteStep === 'DELIVERED';
  const canSubmit = Boolean(preflight && !isBlocked && isConfirmValid && !isBusy && remoteStep === 'IDLE');

  const handleDelete = async () => {
    if (!canSubmit || !preflight) return;
    setError(null);
    setIsStalePreflight(false);

    if (isRemote && shopId) {
      setRemoteStep('QUEUING');
      try {
        const queuedResp = await apiFetch<any>('/api/admin/commands/medicine-delete', {
          method: 'POST',
          body: {
            medicine_id: medicine.id,
            preflight_id: preflight.preflight_id,
            expected_version: preflight.current_version,
            expected_status: preflight.current_status,
            expected_current_stock: preflight.current_stock,
            reason: reason.trim() || undefined,
          },
        });

        const cmdId = queuedResp.command_id;
        setActiveCommandId(cmdId);
        setRemoteStep('PENDING');

        // Poll until APPLIED or REJECTED
        let pollCount = 0;
        cleanupPolling();
        pollIntervalRef.current = setInterval(async () => {
          pollCount++;
          try {
            const cmd = await apiFetch<any>(`/api/admin/commands/${cmdId}`);
            if (cmd.status === 'DELIVERED') {
              setRemoteStep('DELIVERED');
            } else if (cmd.status === 'APPLIED') {
              cleanupPolling();
              setRemoteStep('APPLIED');
              const res = {
                action: (cmd.result?.action || (isPermanent ? 'DELETED' : 'ARCHIVED')) as 'DELETED' | 'ARCHIVED',
                reason: cmd.result?.reason || 'Authoritative deletion completed on Shop 1.',
              };
              setCompletionResult(res);
              // Notify parent
              onDeleted(res);
            } else if (cmd.status === 'REJECTED') {
              cleanupPolling();
              setRemoteStep('REJECTED');
              const errText = String(cmd.error || '');
              if (
                errText.includes('DELETE_PREFLIGHT_STALE') ||
                errText.includes('version conflict') ||
                errText.includes('Refresh and retry') ||
                errText.includes('Medicine version conflict')
              ) {
                setIsStalePreflight(true);
                setError('SHOP DATA CHANGED: Shop 1 state changed after preflight was issued. Refresh preview before trying again.');
              } else {
                setError(cmd.error || 'Command rejected by Shop 1.');
              }
            } else if (pollCount > 25 && !cmd.shop_online) {
              setIsShopOffline(true);
            }
          } catch (pollErr: any) {
            cleanupPolling();
            setRemoteStep('REJECTED');
            setError(pollErr?.message || 'Error tracking command status.');
          }
        }, 1000);
      } catch (err: any) {
        setRemoteStep('REJECTED');
        setError(err?.message || 'Failed to queue delete command.');
      }
    } else {
      // Local shop deletion
      setRemoteStep('PENDING');
      try {
        const data = await apiFetch<any>(`/api/medicines/${medicine.id}`, {
          method: 'DELETE',
          body: {
            preflight_id: preflight.preflight_id,
            expected_version: preflight.current_version,
            expected_status: preflight.current_status,
            expected_current_stock: preflight.current_stock,
            reason: reason.trim() || undefined,
          },
        });
        setRemoteStep('APPLIED');
        const res = {
          action: (data.action || (isPermanent ? 'DELETED' : 'ARCHIVED')) as 'DELETED' | 'ARCHIVED',
          reason: data.reason || 'Local deletion completed.',
        };
        setCompletionResult(res);
        onDeleted(res);
        onClose();
      } catch (err: any) {
        setRemoteStep('REJECTED');
        const errText = String(err?.message || '');
        if (errText.includes('DELETE_PREFLIGHT_STALE') || errText.includes('version conflict')) {
          setIsStalePreflight(true);
          setError('SHOP DATA CHANGED: Shop data changed after preflight. Refresh preview before trying again.');
        } else {
          setError(err?.message || 'Delete operation failed.');
        }
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden animate-in fade-in zoom-in duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50">
          <div className="flex items-center gap-2.5">
            <div className={`p-2 rounded-lg ${
              completionResult
                ? 'bg-emerald-100 text-emerald-700'
                : preflight?.outcome === 'PERMANENT_DELETE'
                  ? 'bg-rose-100 text-rose-700'
                  : preflight?.outcome === 'ARCHIVE_REQUIRED'
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-slate-100 text-slate-700'
            }`}>
              {completionResult ? (
                <CheckCircle2 className="w-5 h-5" />
              ) : preflight?.outcome === 'PERMANENT_DELETE' ? (
                <Trash2 className="w-5 h-5" />
              ) : preflight?.outcome === 'ARCHIVE_REQUIRED' ? (
                <Archive className="w-5 h-5" />
              ) : (
                <ShieldAlert className="w-5 h-5 text-slate-500" />
              )}
            </div>
            <div>
              <h3 className="font-bold text-slate-900 text-base">
                {isRemote ? 'Authoritative Remote Delete' : 'Delete Medicine'}
              </h3>
              <p className="text-xs text-slate-500 font-mono">{medicine.name}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200/50 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
          {loading ? (
            <div className="py-12 flex flex-col items-center justify-center gap-3 text-slate-500">
              <Loader2 className="w-8 h-8 animate-spin text-teal-600" />
              <p className="text-sm font-medium">{loadingStage}</p>
            </div>
          ) : completionResult ? (
            <div className="py-8 text-center space-y-3">
              <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 mx-auto flex items-center justify-center">
                <CheckCircle2 className="w-7 h-7" />
              </div>
              <h4 className="font-bold text-base text-slate-900">
                {completionResult.action === 'DELETED'
                  ? 'MEDICINE PERMANENTLY DELETED'
                  : 'MEDICINE ARCHIVED'}
              </h4>
              <p className="text-xs text-slate-600 max-w-sm mx-auto">
                {completionResult.reason}
              </p>
            </div>
          ) : (
            <>
              {/* Lifecycle Progress Bar for Remote Execution */}
              {isRemote && remoteStep !== 'IDLE' && (
                <div className="p-3 bg-slate-900 text-white rounded-xl space-y-2 text-xs">
                  <div className="flex justify-between items-center text-[11px] font-mono">
                    <span className="text-slate-400">Execution Lifecycle:</span>
                    <span className="font-bold text-teal-400">{remoteStep}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] font-mono">
                    <span className={`px-2 py-0.5 rounded ${remoteStep === 'QUEUING' ? 'bg-teal-500 text-white' : 'bg-slate-700 text-slate-300'}`}>1. QUEUING</span>
                    <span>→</span>
                    <span className={`px-2 py-0.5 rounded ${remoteStep === 'PENDING' ? 'bg-teal-500 text-white' : remoteStep === 'DELIVERED' || remoteStep === 'APPLIED' ? 'bg-emerald-700 text-white' : 'bg-slate-700 text-slate-300'}`}>2. PENDING</span>
                    <span>→</span>
                    <span className={`px-2 py-0.5 rounded ${remoteStep === 'DELIVERED' ? 'bg-teal-500 text-white animate-pulse' : remoteStep === 'APPLIED' ? 'bg-emerald-700 text-white' : 'bg-slate-700 text-slate-300'}`}>3. DELIVERED</span>
                    <span>→</span>
                    <span className={`px-2 py-0.5 rounded ${remoteStep === 'APPLIED' ? 'bg-emerald-500 text-white font-bold' : 'bg-slate-700 text-slate-300'}`}>4. APPLIED</span>
                  </div>
                  {activeCommandId && (
                    <div className="text-[10px] text-slate-400 truncate">
                      Command ID: <span className="font-mono text-slate-300">{activeCommandId}</span>
                    </div>
                  )}
                  {isShopOffline && remoteStep === 'PENDING' && (
                    <div className="p-2 bg-amber-950/80 border border-amber-600/50 rounded text-amber-200 text-[11px] mt-2 flex items-center gap-2">
                      <Clock className="w-4 h-4 text-amber-400 shrink-0" />
                      <span>WAITING FOR SHOP 1: Shop 1 is offline or reconnecting. Command remains queued in Sync Center.</span>
                    </div>
                  )}
                </div>
              )}

              {/* Error Alert */}
              {error && (
                <div className="p-4 bg-rose-50 border border-rose-300 rounded-xl space-y-2 text-rose-900 text-xs">
                  <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-[11px] text-rose-800">
                    <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                    {isStalePreflight ? 'SHOP DATA CHANGED' : 'OPERATION REFUSED'}
                  </div>
                  <p className="text-xs text-rose-700">
                    {error}
                  </p>
                  <div>
                    <button
                      type="button"
                      onClick={() => void fetchAuthoritativePreflight()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-700 hover:bg-rose-800 text-white font-medium text-xs transition cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      {isStalePreflight ? 'REFRESH DELETE PREVIEW' : 'Retry Preview'}
                    </button>
                  </div>
                </div>
              )}

              {/* Authoritative Shop Identity Card */}
              {preflight && (
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2 text-xs">
                  <div className="flex justify-between items-center font-medium">
                    <span className="text-slate-500">Shop Authority:</span>
                    <span className="font-mono font-bold text-teal-800 bg-teal-50 px-2 py-0.5 rounded border border-teal-200">
                      v{preflight.current_version} · status: {preflight.current_status}
                    </span>
                  </div>
                  <div className="flex justify-between items-center font-medium">
                    <span className="text-slate-500">Medicine:</span>
                    <span className="font-semibold text-slate-900">{preflight.name}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-500">Authoritative Stock:</span>
                    <span className={`font-mono font-bold ${preflight.current_stock > 0 ? 'text-rose-600' : 'text-slate-700'}`}>
                      {preflight.current_stock} {medicine.unit || 'units'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-500">Active Batches:</span>
                    <span className="font-mono text-slate-700">{preflight.active_batches}</span>
                  </div>
                  <div className="flex justify-between items-center text-[10px] text-slate-400">
                    <span>Preflight Token:</span>
                    <span className="font-mono truncate max-w-[200px]" title={preflight.preflight_id}>{preflight.preflight_id}</span>
                  </div>
                </div>
              )}

              {/* Blocked Alert */}
              {preflight?.block_reason && (
                <div className="p-3 bg-rose-50 border border-rose-300 rounded-xl flex items-start gap-2.5 text-rose-800 text-xs font-medium">
                  <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
                  <div>
                    <div className="font-bold uppercase tracking-wider text-[10px] text-rose-800">DELETION BLOCKED</div>
                    <div className="mt-0.5 leading-relaxed">
                      {preflight.block_reason}
                    </div>
                  </div>
                </div>
              )}

              {/* Historical References Breakdown */}
              {preflight && (
                <div className="border border-slate-200 rounded-xl overflow-hidden text-xs">
                  <div className="px-3.5 py-2 bg-slate-100 font-semibold text-slate-700 flex justify-between items-center">
                    <span>Authoritative Shop History</span>
                    <span className="font-mono bg-white px-2 py-0.5 rounded border border-slate-300">
                      Total References: {preflight.total_historical_references}
                    </span>
                  </div>
                  <div className="p-3.5 grid grid-cols-2 gap-2 text-slate-600">
                    <div className="flex justify-between py-1 border-b border-slate-100">
                      <span>Sales:</span>
                      <span className="font-mono font-semibold">{preflight.references.sales}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-100">
                      <span>Sale Items:</span>
                      <span className="font-mono font-semibold">{preflight.references.sale_items}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-100">
                      <span>Purchases:</span>
                      <span className="font-mono font-semibold">{preflight.references.purchases}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-100">
                      <span>Purchase Items:</span>
                      <span className="font-mono font-semibold">{preflight.references.purchase_items}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-100">
                      <span>Returns:</span>
                      <span className="font-mono font-semibold">{preflight.references.returns}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-100">
                      <span>Stock Movements:</span>
                      <span className="font-mono font-semibold">{preflight.references.inventory_movements}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-100 col-span-2">
                      <span>Pending Local Sync:</span>
                      <span className={`font-mono font-semibold ${preflight.pending_local_sync > 0 ? 'text-amber-600' : ''}`}>
                        {preflight.pending_local_sync}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Decided Outcome Card */}
              {preflight && preflight.outcome !== 'BLOCKED' && (
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
                      ? 'This medicine has ZERO historical references and ZERO stock. It will be permanently removed inside an atomic transaction on Shop 1.'
                      : 'This medicine has historical business records and cannot be permanently erased without corrupting financial audits. It will be deactivated and safely archived.'}
                  </p>
                </div>
              )}

              {/* Confirmation Input for Permanent Delete */}
              {isPermanent && !isBlocked && (
                <div className="space-y-1.5 pt-1">
                  <label className="text-xs font-semibold text-slate-700">
                    Type <span className="font-mono text-rose-600 font-bold">DELETE</span> or medicine name to confirm permanent destruction:
                  </label>
                  <input
                    type="text"
                    value={confirmInput}
                    onChange={(e) => setConfirmInput(e.target.value)}
                    placeholder="Type DELETE to confirm"
                    disabled={isBusy}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-mono focus:ring-2 focus:ring-rose-500 outline-none"
                  />
                </div>
              )}

              {/* Reason Input */}
              {!isBlocked && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-600">
                    Reason for deletion / archive (optional):
                  </label>
                  <input
                    type="text"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Catalogue cleanup, discontinued, entry error"
                    disabled={isBusy}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs focus:ring-2 focus:ring-teal-600 outline-none"
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-slate-100 bg-slate-50">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-slate-300 rounded-lg text-xs font-medium text-slate-700 hover:bg-slate-100 transition cursor-pointer"
          >
            {completionResult ? 'Close' : 'Cancel'}
          </button>
          {!completionResult && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={!canSubmit}
              className={`px-4 py-2 rounded-lg text-xs font-semibold text-white transition cursor-pointer flex items-center gap-1.5 ${
                !canSubmit
                  ? 'bg-slate-300 cursor-not-allowed opacity-60'
                  : isPermanent
                    ? 'bg-rose-600 hover:bg-rose-700'
                    : 'bg-amber-600 hover:bg-amber-700'
              }`}
            >
              {isBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {preview?.outcome === 'PERMANENT_DELETE'
                ? 'Permanently Delete'
                : preview?.outcome === 'ARCHIVE_REQUIRED'
                  ? 'Archive Medicine'
                  : 'Delete Medicine'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
