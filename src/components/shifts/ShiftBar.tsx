import React, { useEffect, useState } from 'react';
import { AlertCircle, Loader2, Lock, Printer, RefreshCw, Wallet, X } from 'lucide-react';
import { ApiError } from '../../services/http';
import {
  closeShift, fmtMoney, fmtVariance, getShiftMedicines, openShift, printShiftReport, varianceLabel,
  type LiveTotals, type Shift, type ShiftMedicine, type ShiftStatusState,
} from '../../services/shifts';
import { navigateTo } from '../../services/navigation';
import { getServerMode } from '../../services/remoteAdmin';
import { hasPermission } from '../../services/permissions';
import type { PharmacySettings, User as UserType } from '../../types';

export interface ShiftBarProps {
  settings: PharmacySettings;
  shiftStatus?: ShiftStatusState;
  shift?: Shift | null;
  live?: LiveTotals | null;
  errorReason?: string | null;
  currentUser?: UserType | null;
  onRetry?: () => void | Promise<void>;
  onChanged: () => void | Promise<void>;
  openShiftInputRef?: React.RefObject<HTMLInputElement | null>;
  online?: boolean;
}

/**
 * POS shift strip with explicit states: LOADING, NO_SHIFT, OPEN_SHIFT, ERROR.
 * Never silently renders null/nothing so cashier/admin are never stuck at checkout.
 */
export const ShiftBar: React.FC<ShiftBarProps> = ({
  settings,
  shiftStatus,
  shift,
  live,
  errorReason,
  currentUser,
  onRetry,
  onChanged,
  openShiftInputRef,
  online,
}) => {
  const [serverOnline, setServerOnline] = useState<boolean>(false);
  useEffect(() => {
    if (online === undefined) {
      void getServerMode().then((m) => setServerOnline(m === 'online'));
    }
  }, [online]);
  const isOnlineMode = online ?? serverOnline;
  const cur = settings.currency || 'KES';
  const money = (n: number | null | undefined) => fmtMoney(cur, n);
  const [float, setFloat] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The shift being closed is kept here: after the close the bar reloads (no open shift) while the
  // dialog stays up to show the variance and print the report.
  const [closing, setClosing] = useState<{ shift: Shift; live: LiveTotals | null } | null>(null);
  const dialog = closing && (
    <CloseShiftDialog settings={settings} shift={closing.shift} live={closing.live} onClose={() => setClosing(null)} onDone={onChanged} />
  );

  // Derive explicit state if not provided
  const status: ShiftStatusState = shiftStatus ?? (
    shift === undefined ? 'LOADING' :
    shift === null ? 'NO_SHIFT' :
    'OPEN_SHIFT'
  );

  // 1. LOADING STATE
  if (status === 'LOADING') {
    return (
      <>
        {dialog}
        <div className="mx-3 mt-2 rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 flex items-center gap-3 text-xs text-slate-700 shadow-xs">
          <Loader2 className="w-5 h-5 text-teal-600 animate-spin shrink-0" />
          <div className="flex flex-col">
            <span className="font-bold text-slate-800">Checking shift status...</span>
            <span className="text-[11px] text-slate-500">Contacting local POS server to verify active cashier drawer.</span>
          </div>
        </div>
      </>
    );
  }

  // 2. ERROR STATE
  if (status === 'ERROR') {
    return (
      <>
        {dialog}
        <div className="mx-3 mt-2 rounded-lg border-2 border-rose-400 bg-rose-50 p-3.5 text-xs text-rose-900 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <AlertCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
              <div>
                <div className="text-sm font-black tracking-wide text-rose-900">SHIFT STATUS UNAVAILABLE</div>
                <div className="text-xs text-rose-800 mt-0.5">Could not load the current shift. You must open a shift before completing sales.</div>
                {errorReason && (
                  <div className="mt-1.5 text-[11px] font-mono bg-white/90 border border-rose-200 rounded px-2.5 py-1 text-rose-900 font-semibold">
                    Reason: {errorReason}
                  </div>
                )}
              </div>
            </div>
            {onRetry && (
              <button
                type="button"
                onClick={() => void onRetry()}
                className="px-3.5 py-1.5 rounded bg-rose-700 hover:bg-rose-800 text-white font-bold text-xs flex items-center gap-1.5 shrink-0 transition shadow-xs cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Retry</span>
              </button>
            )}
          </div>
        </div>
      </>
    );
  }

  // 3. NO SHIFT STATE
  if (status === 'NO_SHIFT' || !shift) {
    if (isOnlineMode) {
      return (
        <>
          {dialog}
          <div className="mx-3 mt-2 rounded-lg border-2 border-amber-300 bg-amber-50 p-3.5 text-xs text-amber-950 shadow-xs flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-amber-200 border border-amber-300 flex items-center justify-center shrink-0">
              <Lock className="w-5 h-5 text-amber-800" />
            </div>
            <div>
              <div className="text-sm font-black tracking-wide text-amber-950 flex items-center gap-2">
                <span>SHIFT NOT OPEN</span>
                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-200 text-amber-900 uppercase">Cloud Copy · Read-Only</span>
              </div>
              <div className="text-xs text-amber-900 font-medium mt-1">
                No open shift is currently reported by the shop.
              </div>
              <div className="text-[11px] text-amber-800 mt-0.5">
                Open your shift from the local Shop POS terminal. The online system will display it after synchronization.
              </div>
            </div>
          </div>
        </>
      );
    }

    const canOpen = currentUser ? hasPermission(currentUser, 'shift.open') : true;

    if (!canOpen) {
      return (
        <>
          {dialog}
          <div className="mx-3 mt-2 rounded-lg border-2 border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 shadow-xs flex items-center gap-3">
            <Lock className="w-5 h-5 text-amber-700 shrink-0" />
            <div>
              <div className="font-bold text-amber-900">SHIFT NOT OPEN</div>
              <div className="text-[11px] text-amber-800">You must open a shift before completing sales. Contact an Administrator to open a shift.</div>
            </div>
          </div>
        </>
      );
    }

    const submit = async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = float.trim();
      const n = trimmed === '' ? 0 : Number(trimmed);
      if (!Number.isFinite(n) || n < 0) {
        setError('Enter a valid opening cash float (0 or more).');
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await openShift(Math.round(n * 100) / 100);
        setFloat('0');
        await onChanged();
      } catch (err: any) {
        setError(err?.message || 'Could not open the shift.');
      } finally {
        setBusy(false);
      }
    };

    return (
      <>
        {dialog}
        <form onSubmit={submit} className="mx-3 mt-2 rounded-lg border-2 border-amber-400 bg-amber-50 p-3.5 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 text-amber-950">
              <div className="w-9 h-9 rounded-full bg-amber-200 border border-amber-300 flex items-center justify-center shrink-0">
                <Lock className="w-5 h-5 text-amber-800" />
              </div>
              <div>
                <div className="text-sm font-black tracking-wide text-amber-950 flex items-center gap-2">
                  <span>SHIFT NOT OPEN</span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-200 text-amber-900 uppercase">Sales Locked</span>
                </div>
                <div className="text-xs text-amber-900 font-medium mt-0.5">
                  You must open a shift before completing sales.
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-3 ml-auto">
              <label className="text-xs font-bold text-slate-800 flex flex-col">
                <span>Opening Cash Float</span>
                <div className="flex items-center mt-1">
                  <span className="px-2.5 py-2 bg-slate-100 border border-r-0 border-slate-300 rounded-l text-xs font-bold text-slate-600">{cur}</span>
                  <input
                    ref={openShiftInputRef}
                    autoFocus
                    inputMode="decimal"
                    value={float}
                    onChange={(e) => setFloat(e.target.value)}
                    placeholder="0"
                    className="w-32 px-2.5 py-2 border border-slate-300 rounded-r text-sm font-mono font-bold bg-white focus:ring-2 focus:ring-teal-600 outline-none"
                    aria-label="Opening cash float"
                  />
                </div>
              </label>
              <button
                type="submit"
                disabled={busy}
                className="px-5 py-2 rounded bg-teal-700 hover:bg-teal-800 text-white text-xs font-extrabold flex items-center gap-1.5 disabled:opacity-50 transition shadow-sm cursor-pointer"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wallet className="w-4 h-4" />}
                <span>OPEN SHIFT</span>
              </button>
            </div>
          </div>
          {error && <div className="mt-2 text-xs font-semibold text-rose-700 bg-rose-100/60 border border-rose-200 rounded px-2.5 py-1">{error}</div>}
        </form>
      </>
    );
  }

  // 4. OPEN SHIFT STATE
  const t = live;
  return (
    <>
      <div className="mx-3 mt-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3.5 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-700 shadow-xs">
        <div className="font-black text-emerald-800 text-xs tracking-wide flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
          <span>CURRENT SHIFT</span>
        </div>
        <span>Opened: <b>{new Date(shift.opened_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</b></span>
        <span>Opening Float: <b>{money(shift.opening_float)}</b></span>
        <span>Transactions: <b>{t?.total_transactions ?? 0}</b></span>
        <span>Sales: <b>{money(t?.total_sales)}</b></span>
        <span>Cash: <b>{money(t?.cash_sales)}</b></span>
        <span>M-Pesa: <b>{money(t?.mpesa_sales)}</b></span>
        {!!t?.card_sales && <span>Card: <b>{money(t.card_sales)}</b></span>}
        {!!t?.bank_sales && <span>Bank: <b>{money(t.bank_sales)}</b></span>}
        <div className="ml-auto flex gap-1.5">
          <button onClick={() => navigateTo('history', 'shifts', { shift_id: shift.id })} className="px-2.5 py-1 rounded border border-emerald-400 bg-white hover:bg-emerald-50 text-emerald-800 font-semibold transition cursor-pointer">Shift Details</button>
          {!isOnlineMode && (
            <button onClick={() => setClosing({ shift, live })} className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-900 text-white font-bold transition cursor-pointer">Close Shift</button>
          )}
        </div>
      </div>
      {dialog}
    </>
  );
};

/**
 * Close: shows the server's expected cash; the closer enters ONLY the cash counted and notes. A non-zero
 * variance needs a reason. Expected cash cannot be edited. If new sales changed it meanwhile the server
 * refuses (SHIFT_TOTALS_CHANGED) and the figures are reloaded.
 */
export const CloseShiftDialog: React.FC<{
  settings: PharmacySettings;
  shift: Shift;
  live: LiveTotals | null;
  onClose: () => void;
  onDone: () => void | Promise<void>;
  /** Administrator closing someone else's (forgotten) shift: a reason is required. */
  adminClosure?: boolean;
}> = ({ settings, shift, live, onClose, onDone, adminClosure }) => {
  const cur = settings.currency || 'KES';
  const money = (n: number | null | undefined) => fmtMoney(cur, n);
  const [actual, setActual] = useState('');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [medicines, setMedicines] = useState<ShiftMedicine[] | null>(null);
  const [closed, setClosed] = useState<{ shift: Shift; medicines: ShiftMedicine[] } | null>(null);
  const [expected, setExpected] = useState<number | null>(live?.expected_cash ?? shift.expected_cash ?? null);

  useEffect(() => {
    getShiftMedicines(shift.id).then((d) => setMedicines(d.medicines)).catch(() => setMedicines([]));
  }, [shift.id]);

  const actualNum = actual.trim() === '' ? null : Number(actual);
  const variance = actualNum !== null && Number.isFinite(actualNum) && expected !== null ? Math.round((actualNum - expected) * 100) / 100 : null;
  const label = varianceLabel(variance);

  const submit = async () => {
    if (actualNum === null || !Number.isFinite(actualNum) || actualNum < 0) return setError('Enter the actual cash counted (0 or more).');
    if (label !== 'BALANCED' && notes.trim().length < 3) return setError('Explain the difference (closing notes) before closing.');
    if (adminClosure && reason.trim().length < 3) return setError('A reason is required to close another person\'s shift.');
    setBusy(true);
    setError(null);
    try {
      const out = await closeShift(shift.id, {
        actual_cash: Math.round(actualNum * 100) / 100, closing_notes: notes.trim() || undefined, expected_cash_seen: expected ?? undefined,
        admin_close_reason: adminClosure ? reason.trim() : undefined,
      });
      setClosed({ shift: out.shift, medicines: out.medicines });
      await onDone();
    } catch (err: any) {
      if (err instanceof ApiError && err.data?.code === 'SHIFT_TOTALS_CHANGED') setExpected(Number(err.data?.details?.expected_cash));
      setError(err?.message || 'Could not close the shift.');
    } finally {
      setBusy(false);
    }
  };

  const line = (k: string, v: React.ReactNode, strong = false) => (
    <div className={`flex justify-between py-0.5 ${strong ? 'font-bold text-slate-900' : 'text-slate-700'}`}><span>{k}</span><span className="font-mono">{v}</span></div>
  );
  const tone = (l: string | null) => (l === 'SHORT' ? 'text-rose-700 bg-rose-50 border-rose-300' : l === 'OVER' ? 'text-amber-800 bg-amber-50 border-amber-300' : 'text-emerald-800 bg-emerald-50 border-emerald-300');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-3" role="dialog" aria-modal="true" aria-labelledby="close-shift-title">
      <div className="w-full max-w-lg max-h-[92vh] overflow-y-auto bg-white rounded-lg shadow-xl">
        <div className="px-4 py-3 bg-slate-800 text-white flex items-center justify-between">
          <div>
            <div id="close-shift-title" className="font-black tracking-wide text-sm">{closed ? 'SHIFT CLOSED' : 'CLOSE SHIFT'}</div>
            <div className="text-[11px] text-slate-300">{shift.shift_number} · {shift.cashier_name} · opened {new Date(shift.opened_at).toLocaleString()}</div>
          </div>
          <button onClick={onClose} aria-label="Close"><X className="w-5 h-5" /></button>
        </div>

        {closed ? (
          <div className="p-4 space-y-3 text-sm">
            <div className={`rounded border-2 p-3 text-center ${tone(closed.shift.variance_status)}`}>
              <div className="text-xs uppercase tracking-wider">Variance</div>
              <div className="text-xl font-black">{fmtVariance(cur, closed.shift.cash_variance)}</div>
              <div className="text-xs">Expected {money(closed.shift.expected_cash)} · Counted {money(closed.shift.actual_cash)}</div>
            </div>
            <p className="text-xs text-slate-600">The shift is closed and recorded. It can no longer be edited; an Administrator / Manager will review it.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => { if (!printShiftReport(closed.shift, { pharmacyName: settings.pharmacy_name, currency: cur, medicines: closed.medicines })) setError('Allow pop-ups to print the report.'); }}
                className="px-3 py-2 rounded border border-slate-300 text-xs font-semibold flex items-center gap-1"><Printer className="w-4 h-4" /> Print Shift Report</button>
              <button onClick={onClose} className="px-4 py-2 rounded bg-teal-700 text-white text-xs font-bold">Done</button>
            </div>
            {error && <div className="text-xs text-rose-700">{error}</div>}
          </div>
        ) : (
          <div className="p-4 space-y-3 text-xs">
            <div className="rounded border border-slate-200 p-3">
              {line('Opening Float', money(shift.opening_float))}
              {line('+ Cash Sales', money(live?.cash_sales))}
              {line('- Cash Refunds', money(live?.cash_refunds))}
              {line('- Cash Expenses (paid from this till)', money(live?.cash_expenses))}
              <div className="border-t border-slate-200 mt-1 pt-1">{line('Expected Cash', money(expected), true)}</div>
              <div className="text-[10px] text-slate-500 mt-1">Not in the drawer: M-Pesa {money(live?.mpesa_sales)} · Card {money(live?.card_sales)} · Bank {money(live?.bank_sales)}.
                Transactions {live?.total_transactions ?? 0} · Sales {money(live?.total_sales)}{live?.voided_count ? ` · Voided ${live.voided_count}` : ''}</div>
            </div>
            {adminClosure && (
              <label className="block font-semibold text-rose-800">
                Reason for closing this person's shift
                <input value={reason} onChange={(e) => setReason(e.target.value)} className="mt-0.5 w-full px-2 py-2 border border-rose-300 rounded" placeholder="e.g. Cashier forgot to close; drawer counted by Administrator" />
              </label>
            )}
            <label className="block font-semibold text-slate-800">
              Actual Cash Counted
              <div className="flex items-center mt-0.5">
                <span className="px-2 py-2 bg-slate-50 border border-r-0 border-slate-300 rounded-l text-slate-500">{cur}</span>
                <input autoFocus inputMode="decimal" value={actual} onChange={(e) => setActual(e.target.value)} className="flex-1 px-2 py-2 border border-slate-300 rounded-r text-base font-mono" aria-label="Actual cash counted" />
              </div>
            </label>
            {label && (
              <div className={`rounded border-2 px-3 py-2 font-bold text-center ${tone(label)}`}>{fmtVariance(cur, variance)}</div>
            )}
            <label className="block font-semibold text-slate-800">
              Closing Notes {label && label !== 'BALANCED' ? <span className="text-rose-700">(required: explain the difference)</span> : <span className="text-slate-400">(optional)</span>}
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="mt-0.5 w-full px-2 py-1.5 border border-slate-300 rounded" placeholder="e.g. Customer change shortage" />
            </label>
            {medicines && medicines.length > 0 && (
              <details className="rounded border border-slate-200">
                <summary className="px-3 py-1.5 cursor-pointer font-semibold">Medicines sold this shift ({medicines.reduce((t, m) => t + m.quantity_sold, 0)} units)</summary>
                <div className="max-h-40 overflow-y-auto px-3 pb-2">
                  {medicines.map((m) => <div key={m.medicine_id} className="flex justify-between py-0.5 border-t border-slate-100"><span className="truncate">{m.name}</span><span className="font-mono">{m.quantity_sold}{m.returned ? ` (-${m.returned})` : ''}</span></div>)}
                </div>
              </details>
            )}
            {error && <div className="text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="px-3 py-2 rounded border border-slate-300 font-semibold">Cancel</button>
              <button onClick={() => void submit()} disabled={busy} className="px-4 py-2 rounded bg-slate-800 text-white font-bold flex items-center gap-1 disabled:opacity-50">
                {busy && <Loader2 className="w-4 h-4 animate-spin" />} Close Shift
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
