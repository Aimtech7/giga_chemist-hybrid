import React from 'react';
import { CheckCircle2, Clock, X, XCircle } from 'lucide-react';
import type { RemoteAction, RemoteCommand } from '../../services/remoteAdmin';

/** Shared pieces of the Remote Admin screens (phone-first). */
export interface Draft {
  action: RemoteAction;
  title: string;
  payload: Record<string, unknown>;
  lines: [string, string][];
  requestId: string;
}

export const ago = (iso: string | null | undefined, now = Date.now()) => {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');
export const bytes = (n: number | null | undefined) => {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(v / 1024)} KB`;
};
export const duration = (sec: number | null | undefined) => {
  if (sec === null || sec === undefined) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

const STATUS_STYLE: Record<string, string> = {
  PENDING: 'bg-amber-50 text-amber-800 border-amber-200',
  DELIVERED: 'bg-sky-50 text-sky-800 border-sky-200',
  APPLIED: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  REJECTED: 'bg-rose-50 text-rose-800 border-rose-200',
};
export const STATUS_TEXT: Record<string, string> = {
  PENDING: 'Waiting for the shop computer',
  DELIVERED: 'Shop computer received it',
  APPLIED: 'Applied by the shop',
  REJECTED: 'Rejected by the shop',
};

export const StatusBadge: React.FC<{ status: string }> = ({ status }) => (
  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-bold ${STATUS_STYLE[status] || 'bg-slate-50 text-slate-700 border-slate-200'}`}>
    {status === 'APPLIED' ? <CheckCircle2 className="w-3 h-3" /> : status === 'REJECTED' ? <XCircle className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
    {status}
  </span>
);

export const Pill: React.FC<{ tone: 'ok' | 'warn' | 'bad' | 'muted'; children: React.ReactNode }> = ({ tone, children }) => (
  <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-bold ${
    tone === 'ok' ? 'bg-emerald-100 text-emerald-800' : tone === 'warn' ? 'bg-amber-100 text-amber-800' : tone === 'bad' ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-600'
  }`}>{children}</span>
);

export const inputCls = 'w-full px-3 py-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-teal-600 focus:border-teal-600 outline-none bg-white';
export const labelCls = 'block text-xs font-semibold text-slate-600 mb-1';
export const btnPrimary = 'w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-sm font-bold disabled:opacity-50';
export const btnSecondary = 'w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-sm font-semibold';
export const btnDanger = 'w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-rose-700 hover:bg-rose-800 text-white text-sm font-bold disabled:opacity-50';
export const card = 'bg-white border border-slate-200 rounded-xl p-3';

export const Sheet: React.FC<{ title: string; onClose: () => void; children: React.ReactNode }> = ({ title, onClose, children }) => (
  <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-end sm:items-center justify-center">
    <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl max-h-[92vh] overflow-y-auto p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-bold text-slate-900">{title}</h2>
        <button onClick={onClose} className="p-2 -mr-2 rounded-lg hover:bg-slate-100" aria-label="Close"><X className="w-5 h-5 text-slate-500" /></button>
      </div>
      {children}
    </div>
  </div>
);

export const Row: React.FC<{ k: string; children: React.ReactNode }> = ({ k, children }) => (
  <div className="flex justify-between gap-3 py-1 text-sm border-b border-slate-100 last:border-0">
    <span className="text-slate-500 shrink-0">{k}</span>
    <span className="font-semibold text-slate-900 text-right break-words min-w-0">{children}</span>
  </div>
);

export function describeResult(c: RemoteCommand): string | null {
  const r = c.result;
  if (!r) return null;
  if ('previous_quantity' in r && 'new_quantity' in r) {
    const d = Number(r.delta);
    return `Batch ${r.batch_number ?? ''}: ${r.previous_quantity} → ${r.new_quantity} (${d > 0 ? '+' : ''}${d}). Medicine stock now ${r.current_stock}.`;
  }
  if ('expiry_date' in r) return `Batch ${r.batch_number ?? ''} expiry now ${r.expiry_date || 'unknown'}.`;
  if ('selling_price' in r) return `Selling price now ${r.selling_price}${r.wholesale_price != null ? `, wholesale ${r.wholesale_price}` : ''}.`;
  if ('approval_id' in r) return String(r.note || 'Update approval recorded.');
  if ('active' in r && 'user_id' in r) return `${r.name}: account ${r.active ? 'ACTIVE' : 'DISABLED'}.`;
  if ('previous_role' in r) return `${r.name}: role ${r.previous_role} → ${r.role}.`;
  if ('updated' in r) return `Updated: ${(r.updated as string[]).join(', ')}.`;
  if ('name' in r) return `Saved: ${r.name}.`;
  return null;
}

/** One-line description of WHAT a command asks for (from payload + display context). */
export function describeRequest(c: RemoteCommand): string {
  const p = c.payload || {};
  const d = c.display || {};
  const target = [d.medicine_name, d.batch_number ? `batch ${d.batch_number}` : null, d.user_name].filter(Boolean).join(' · ');
  const t = c.command_type;
  let what = '';
  if (t === 'STOCK_ADD') what = `+${p.quantity}`;
  else if (t === 'STOCK_REMOVE') what = `-${p.quantity} (${p.reason})`;
  else if (t === 'STOCK_SET') what = `count = ${p.quantity}`;
  else if (t === 'PRICE_UPDATE') {
    const before = d.prices_before || {};
    what = ['selling_price', 'wholesale_price', 'min_selling_price', 'purchase_price'].filter((k) => k in p)
      .map((k) => `${k.replace('_price', '').replace('_', ' ')} ${before[k] ?? '?'} → ${p[k] ?? 'none'}`).join(', ');
  } else if (t === 'BATCH_EXPIRY_UPDATE') what = `expiry ${d.expiry_before ?? '?'} → ${p.expiry_date || 'unknown'}`;
  else if (t === 'USER_SET_ACTIVE') what = p.active ? 'activate' : 'deactivate';
  else if (t === 'USER_ROLE_UPDATE') what = `role ${d.role_before ?? '?'} → ${p.role}`;
  else if (t === 'APP_UPDATE_APPROVE') what = `install ${String(p.target_commit).slice(0, 12)}`;
  else if (t === 'CATEGORY_UPSERT') what = String(p.name);
  else if (t === 'SETTINGS_UPDATE') what = Object.keys(p).join(', ');
  else if (t === 'MEDICINE_METADATA_UPDATE') what = Object.keys(p).filter((k) => k !== 'medicine_id').join(', ');
  return [target, what].filter(Boolean).join(' · ');
}
