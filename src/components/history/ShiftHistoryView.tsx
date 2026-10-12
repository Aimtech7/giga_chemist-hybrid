import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Loader2, Pill, Printer, RefreshCw, Search, X } from 'lucide-react';
import { apiDownload, apiFetch } from '../../services/http';
import { queueRemoteCommand, type OnlineShop } from '../../services/remoteAdmin';
import { navigateTo } from '../../services/navigation';
import { canCorrectShifts, canReviewShifts, canViewAllShifts } from '../../services/permissions';
import {
  correctShift, fmtMoney, fmtVariance, getShiftDetail, getShiftMedicines, printShiftReport, reviewShift, type Shift, type ShiftMedicine,
} from '../../services/shifts';
import { CloseShiftDialog } from '../shifts/ShiftBar';
import type { PharmacySettings, User } from '../../types';

/**
 * SHIFT HISTORY (History -> Shifts). Administrator / Manager: every shift of the shop (Global Admin:
 * any shop, or All Shops with each shift kept in its own shop). Cashier: "My Shifts" — their own shifts
 * only, read only (the server enforces the same). Reports: shift list (cash variance), daily summary,
 * cashier reconciliation; CSV export of the filters. Never profit or cost.
 */
type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'all' | 'custom';
type View = 'shifts' | 'daily' | 'cashiers';
const day = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
function presetRange(p: Preset): { from: string; to: string } {
  const now = new Date();
  if (p === 'today') return { from: day(now), to: day(now) };
  if (p === 'yesterday') { const y = new Date(now.getTime() - 86_400_000); return { from: day(y), to: day(y) }; }
  if (p === 'week') { const s = new Date(now); s.setDate(now.getDate() - ((now.getDay() + 6) % 7)); return { from: day(s), to: day(now) }; }
  if (p === 'month') return { from: day(new Date(now.getFullYear(), now.getMonth(), 1)), to: day(now) };
  return { from: '', to: '' };
}
const input = 'px-2.5 py-2 border border-slate-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-teal-600 outline-none';
const vTone = (v: number | null | undefined) => (v === null || v === undefined ? 'text-slate-500' : Math.round(v * 100) < 0 ? 'text-rose-700 font-bold' : Math.round(v * 100) > 0 ? 'text-amber-700 font-bold' : 'text-emerald-700 font-semibold');
const when = (d: string | null | undefined) => (d ? new Date(d).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');

export const ShiftHistoryView: React.FC<{
  settings: PharmacySettings; currentUser: User; online: boolean; allShops: boolean; shops: OnlineShop[]; initialShiftId?: string | null;
}> = ({ settings, currentUser, online, allShops, shops, initialShiftId }) => {
  const cur = settings.currency || 'KES';
  const money = (n: number | null | undefined) => fmtMoney(cur, n);
  const all = canViewAllShifts(currentUser);
  const [preset, setPreset] = useState<Preset>(initialShiftId ? 'all' : 'week');
  const [range, setRange] = useState(presetRange(initialShiftId ? 'all' : 'week'));
  const [f, setF] = useState<Record<string, string>>({});
  const [applied, setApplied] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [view, setView] = useState<View>('shifts');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ id: string; shop_id: string | null } | null>(initialShiftId ? { id: initialShiftId, shop_id: null } : null);
  const [staff, setStaff] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (!all || allShops || online || currentUser.role !== 'ADMIN') return;
    apiFetch<any[]>('/api/users').then((u) => setStaff((u || []).filter((x) => x?.id && x?.name).map((x) => ({ id: x.id, name: x.name })))).catch(() => setStaff([]));
  }, [all, allShops, online, currentUser.role]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (range.from) p.set('from', range.from);
    if (range.to) p.set('to', range.to);
    for (const [k, v] of Object.entries(applied)) if (v && v.trim()) p.set(k, v.trim());
    return p;
  }, [range, applied]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams(params);
      p.set('page', String(page));
      p.set('page_size', '50');
      setData(await apiFetch<any>(`/api/shifts?${p.toString()}`));
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load shifts.');
    } finally {
      setLoading(false);
    }
  }, [params, page]);
  useEffect(() => {
    void load();
  }, [load]);

  const choose = (p: Preset) => {
    setPreset(p);
    if (p !== 'custom') setRange(presetRange(p));
    setPage(1);
  };
  const s = data?.summary;
  const stat = (label: string, value: React.ReactNode, cls = 'text-slate-900') => (
    <div className="rounded-lg bg-white border border-slate-200 px-2.5 py-1.5"><div className={`text-sm font-bold ${cls}`}>{value}</div><div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div></div>
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-3 py-2 bg-white border-b border-slate-200 space-y-2 shrink-0">
        <div className="flex flex-wrap items-center gap-1.5">
          {(['today', 'yesterday', 'week', 'month', 'all', 'custom'] as Preset[]).map((p) => (
            <button key={p} onClick={() => choose(p)} className={`px-2.5 py-1.5 rounded-md text-xs font-semibold border ${preset === p ? 'bg-teal-700 text-white border-teal-700' : 'bg-white text-slate-700 border-slate-300'}`}>
              {{ today: 'Today', yesterday: 'Yesterday', week: 'This Week', month: 'This Month', all: 'All', custom: 'Custom' }[p]}
            </button>
          ))}
          {preset === 'custom' && (
            <>
              <input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className={input} aria-label="From" />
              <input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className={input} aria-label="To" />
            </>
          )}
          <button onClick={() => void load()} className="p-2 rounded-lg hover:bg-slate-100" aria-label="Refresh"><RefreshCw className={`w-4 h-4 text-slate-500 ${loading ? 'animate-spin' : ''}`} /></button>
        </div>
        <form className="flex flex-wrap items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); setApplied(f); setPage(1); }}>
          {all && (
            <div className="relative"><Search className="w-3.5 h-3.5 absolute left-2 top-2.5 text-slate-400" />
              <input value={f.q || ''} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Shift no. or cashier" className={`${input} pl-7 w-44`} /></div>
          )}
          {allShops && (
            <select value={f.shop_id || ''} onChange={(e) => setF({ ...f, shop_id: e.target.value })} className={input} aria-label="Shop">
              <option value="">All shops</option>
              {shops.map((x) => <option key={x.shop_id} value={x.shop_id}>{x.shop_code} — {x.name}</option>)}
            </select>
          )}
          {staff.length > 0 && (
            <select value={f.cashier || ''} onChange={(e) => setF({ ...f, cashier: e.target.value })} className={input} aria-label="Cashier">
              <option value="">All cashiers</option>
              {staff.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          )}
          <select value={f.status || ''} onChange={(e) => setF({ ...f, status: e.target.value })} className={input} aria-label="Status">
            <option value="">Any status</option><option value="OPEN">Open</option><option value="CLOSED">Closed</option><option value="REVIEWED">Reviewed</option>
          </select>
          <select value={f.variance || ''} onChange={(e) => setF({ ...f, variance: e.target.value })} className={input} aria-label="Variance">
            <option value="">Any variance</option><option value="SHORT">Short</option><option value="OVER">Over</option><option value="BALANCED">Balanced</option>
            <option value="NONZERO">Short or over</option><option value="UNREVIEWED">Unreviewed variance</option>
          </select>
          <button type="submit" className="px-3 py-2 rounded-lg bg-slate-800 text-white text-xs font-semibold">Apply</button>
          <button type="button" onClick={() => void apiDownload(`/api/shifts/export?${params.toString()}`, `giga-shift-reconciliation-${range.from || 'all'}-${range.to || 'now'}.csv`).catch((e) => setError(e?.message || 'Export failed.'))}
            className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold flex items-center gap-1"><Download className="w-3.5 h-3.5" /> CSV</button>
          {all && (
            <div className="flex gap-1 bg-slate-100 p-1 rounded-lg ml-auto">
              {([['shifts', 'Cash Variance'], ['daily', 'Daily Shift Summary'], ['cashiers', 'Cashier Reconciliation']] as [View, string][]).map(([id, label]) => (
                <button type="button" key={id} onClick={() => setView(id)} className={`px-2.5 py-1 rounded-md text-xs font-semibold ${view === id ? 'bg-white text-teal-800 shadow-xs' : 'text-slate-600'}`}>{label}</button>
              ))}
            </div>
          )}
        </form>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}
        {s && (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
            {stat('Shifts', `${s.shifts}${s.open ? ` (${s.open} open)` : ''}`)}
            {stat('Sales (closed)', money(s.total_sales))}
            {stat('Cash sales', money(s.cash_sales))}
            {stat('Expected cash', money(s.expected_cash))}
            {stat('Actual cash', money(s.actual_cash))}
            {stat('Net variance', fmtVariance(cur, s.cash_variance), vTone(s.cash_variance))}
            {stat('Short / Over', `${s.short_count} / ${s.over_count}`, s.short_count ? 'text-rose-700' : 'text-slate-900')}
            {stat('Unreviewed variances', s.unreviewed_variances, s.unreviewed_variances ? 'text-amber-700' : 'text-slate-900')}
          </div>
        )}

        {view === 'daily' && data && (
          <Table head={['Date', ...(allShops ? ['Shop'] : []), 'Shifts', 'Sales', 'Cash sales', 'Expected', 'Actual', 'Variance']}
            rows={data.by_day.map((d: any) => [String(d.date).slice(0, 10), ...(allShops ? [d.shop_code] : []), d.shifts, money(d.total_sales), money(d.cash_sales), money(d.expected_cash), money(d.actual_cash),
              <span className={vTone(d.cash_variance)}>{fmtVariance(cur, d.cash_variance)}</span>])} />
        )}
        {view === 'cashiers' && data && (
          <Table head={['Cashier', ...(allShops ? ['Shop'] : []), 'Shifts', 'Sales', 'Expected', 'Actual', 'Variance', 'Short', 'Over']}
            rows={data.by_cashier.map((d: any) => [d.cashier_name || '—', ...(allShops ? [d.shop_code] : []), d.shifts, money(d.total_sales), money(d.expected_cash), money(d.actual_cash),
              <span className={vTone(d.cash_variance)}>{fmtVariance(cur, d.cash_variance)}</span>, d.short_count, d.over_count])} />
        )}
        {view === 'shifts' && data && (
          <>
            <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-600 text-[10px] uppercase tracking-wide">
                  <tr>{['Date', ...(allShops ? ['Shop'] : []), 'Cashier', 'Shift', 'Opened', 'Closed', 'Float', 'Txns', 'Cash', 'M-Pesa', 'Card', 'Bank', 'Refunds', 'Expenses', 'Expected', 'Actual', 'Variance', 'Status'].map((h) => <th key={h} className="px-2 py-2 text-left whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {data.rows.length === 0 && <tr><td colSpan={18} className="px-3 py-6 text-center text-slate-500">No shifts for these filters.</td></tr>}
                  {data.rows.map((r: Shift) => (
                    <tr key={r.id} onClick={() => setDetail({ id: r.id, shop_id: r.shop_id })} className="border-t border-slate-100 hover:bg-teal-50 cursor-pointer whitespace-nowrap">
                      <td className="px-2 py-1.5">{String(r.opened_business_date).slice(0, 10)}</td>
                      {allShops && <td className="px-2 py-1.5 font-semibold">{r.shop_code}</td>}
                      <td className="px-2 py-1.5">{r.cashier_name}</td>
                      <td className="px-2 py-1.5 font-mono text-[10px]">{r.shift_number}</td>
                      <td className="px-2 py-1.5">{when(r.opened_at)}</td>
                      <td className="px-2 py-1.5">{when(r.closed_at)}</td>
                      <td className="px-2 py-1.5 text-right">{money(r.opening_float)}</td>
                      <td className="px-2 py-1.5 text-right">{r.total_transactions ?? 0}</td>
                      <td className="px-2 py-1.5 text-right">{money(r.cash_sales)}</td>
                      <td className="px-2 py-1.5 text-right">{money(r.mpesa_sales)}</td>
                      <td className="px-2 py-1.5 text-right">{money(r.card_sales)}</td>
                      <td className="px-2 py-1.5 text-right">{money(r.bank_sales)}</td>
                      <td className="px-2 py-1.5 text-right">{money(r.refund_total)}</td>
                      <td className="px-2 py-1.5 text-right">{money(r.cash_expenses)}</td>
                      <td className="px-2 py-1.5 text-right">{money(r.expected_cash)}{r.live ? '*' : ''}</td>
                      <td className="px-2 py-1.5 text-right">{money(r.actual_cash)}</td>
                      <td className={`px-2 py-1.5 text-right ${vTone(r.status === 'OPEN' ? null : r.effective_variance)}`}>{r.status === 'OPEN' ? '—' : fmtVariance(cur, r.effective_variance)}{r.corrected ? ' (corr.)' : ''}</td>
                      <td className="px-2 py-1.5"><StatusPill s={r} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between text-xs text-slate-600">
              <span>{data.total} shift(s){data.rows.some((r: Shift) => r.live) ? ' · * open shift: live figures' : ''}</span>
              <div className="flex items-center gap-1">
                <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="p-1.5 rounded border border-slate-300 disabled:opacity-40" aria-label="Previous page"><ChevronLeft className="w-4 h-4" /></button>
                <span>Page {data.page} / {data.pages}</span>
                <button disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)} className="p-1.5 rounded border border-slate-300 disabled:opacity-40" aria-label="Next page"><ChevronRight className="w-4 h-4" /></button>
              </div>
            </div>
          </>
        )}
        {!data && loading && <div className="text-xs text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading shifts…</div>}
      </div>

      {detail && (
        <ShiftDetailDrawer id={detail.id} shopId={detail.shop_id} settings={settings} currentUser={currentUser} online={online} allShops={allShops}
          onClose={() => setDetail(null)} onChanged={() => void load()} />
      )}
    </div>
  );
};

const StatusPill: React.FC<{ s: Shift }> = ({ s }) => {
  const cls = s.status === 'OPEN' ? 'bg-sky-100 text-sky-800' : s.status === 'REVIEWED' ? 'bg-emerald-100 text-emerald-800' : (s.cash_variance ?? 0) !== 0 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-700';
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${cls}`}>{s.status}{s.status === 'OPEN' && s.opened_business_date && String(s.opened_business_date).slice(0, 10) < day(new Date()) ? ' · LEFT OPEN' : ''}</span>;
};

const Table: React.FC<{ head: string[]; rows: React.ReactNode[][] }> = ({ head, rows }) => (
  <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
    <table className="w-full text-xs">
      <thead className="bg-slate-50 text-slate-600 text-[10px] uppercase tracking-wide"><tr>{head.map((h) => <th key={h} className="px-2 py-2 text-left whitespace-nowrap">{h}</th>)}</tr></thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={head.length} className="px-3 py-6 text-center text-slate-500">No closed shifts for these filters.</td></tr>}
        {rows.map((r, i) => <tr key={i} className="border-t border-slate-100 whitespace-nowrap">{r.map((c, j) => <td key={j} className="px-2 py-1.5">{c}</td>)}</tr>)}
      </tbody>
    </table>
  </div>
);

const ShiftDetailDrawer: React.FC<{
  id: string; shopId: string | null; settings: PharmacySettings; currentUser: User; online: boolean; allShops: boolean; onClose: () => void; onChanged: () => void;
}> = ({ id, shopId, settings, currentUser, online, allShops, onClose, onChanged }) => {
  const cur = settings.currency || 'KES';
  const money = (n: number | null | undefined) => fmtMoney(cur, n);
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [meds, setMeds] = useState<ShiftMedicine[] | null>(null);
  const [notes, setNotes] = useState('');
  const [corr, setCorr] = useState({ amount: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [adminClose, setAdminClose] = useState(false);

  const load = useCallback(async () => {
    try {
      setD(await getShiftDetail(id, shopId));
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load the shift.');
    }
  }, [id, shopId]);
  useEffect(() => {
    void load();
  }, [load]);

  const sh: Shift | undefined = d?.shift;
  const isOwn = sh?.cashier_id === currentUser.id;
  const canReview = canReviewShifts(currentUser) && sh?.status === 'CLOSED' && !allShops && (currentUser.role === 'ADMIN' || !isOwn);
  const canCorrect = canCorrectShifts(currentUser) && !online && sh && sh.status !== 'OPEN';
  const canAdminClose = !online && currentUser.role === 'ADMIN' && sh?.status === 'OPEN' && !isOwn;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setInfo(ok);
      await load();
      onChanged();
    } catch (err: any) {
      setError(err?.message || 'Action failed.');
    } finally {
      setBusy(false);
    }
  };
  const line = (k: string, v: React.ReactNode, cls = '') => <div className={`flex justify-between py-0.5 ${cls}`}><span className="text-slate-600">{k}</span><span className="font-mono">{v}</span></div>;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/40" onClick={onClose}>
      <div className="w-full max-w-xl h-full overflow-y-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Shift details">
        <div className="sticky top-0 bg-slate-800 text-white px-4 py-3 flex items-center justify-between">
          <div>
            <div className="font-black text-sm tracking-wide">SHIFT {sh?.shift_number || ''}</div>
            <div className="text-[11px] text-slate-300">{sh ? `${sh.shop_name || sh.shop_code || 'This shop'} · ${sh.cashier_name} · ${sh.status}` : 'Loading…'}</div>
          </div>
          <button onClick={onClose} aria-label="Close"><X className="w-5 h-5" /></button>
        </div>
        {error && <div className="m-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}
        {info && <div className="m-3 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded p-2">{info}</div>}
        {sh && (
          <div className="p-4 space-y-4 text-xs">
            <section>
              <h3 className="font-bold text-slate-900 mb-1">SHIFT INFORMATION</h3>
              {line('Shift ID', <span className="text-[10px]">{sh.id}</span>)}
              {line('Shop', sh.shop_name || sh.shop_code || 'This shop')}
              {line('Cashier', sh.cashier_name)}
              {line('Device', sh.device_id || '—')}
              {line('Opened at', when(sh.opened_at))}
              {line('Closed at', when(sh.closed_at))}
              {sh.close_method === 'ADMIN' && line('Closed by Administrator', `${sh.closed_by_name} — ${sh.admin_close_reason}`, 'text-rose-700')}
              {sh.reviewed_at && line('Reviewed', `${sh.reviewed_by_name || ''} · ${when(sh.reviewed_at)}${sh.review_notes ? ` · ${sh.review_notes}` : ''}`)}
            </section>
            <section className="rounded border border-slate-200 p-3">
              <h3 className="font-bold text-slate-900 mb-1">FINANCIAL SUMMARY{sh.live ? ' (live, shift open)' : ''}</h3>
              {line('Opening Float', money(sh.opening_float))}
              {line('Gross Sales', money(sh.total_sales))}
              {line('Net Sales (after refunds)', money(sh.total_sales === null ? null : Math.round(((sh.total_sales || 0) - (sh.refund_total || 0)) * 100) / 100))}
              {line('Cash', money(sh.cash_sales))}
              {line('M-Pesa', money(sh.mpesa_sales))}
              {line('Card', money(sh.card_sales))}
              {line('Bank', money(sh.bank_sales))}
              {!!sh.other_sales && line('Other', money(sh.other_sales))}
              {line('Mixed (split) sales', d.recount?.mixed_transactions ?? 0)}
              {line('Transactions / units', `${sh.total_transactions ?? 0} / ${sh.units_sold ?? 0}`)}
              {line('Returns / refunds', `${sh.returns_count ?? 0} · ${money(sh.refund_total)} (cash ${money(sh.cash_refunds)})`)}
              {line('Voids', `${sh.voided_count ?? 0} · ${money(sh.voided_total)}`)}
              {line('Cash expenses (till)', money(sh.cash_expenses))}
              <div className="border-t border-slate-200 mt-1 pt-1">
                {line('Expected Cash', money(sh.expected_cash), 'font-bold')}
                {line('Actual Cash', money(sh.actual_cash), 'font-bold')}
                {line('Variance', <span className={vTone(sh.cash_variance)}>{sh.status === 'OPEN' ? '—' : fmtVariance(cur, sh.cash_variance)}</span>, 'font-bold')}
                {sh.closing_notes && line('Closing notes', sh.closing_notes)}
              </div>
              <div className="text-[10px] text-slate-500 mt-1">{d.formula}</div>
              {d.recount?.changed_since_close && (
                <div className="mt-2 rounded bg-amber-50 border border-amber-300 p-2 text-amber-900">
                  Transactions of this shift changed after it was counted (recount now: expected {money(d.recount.expected_cash)}). The closing figures above are kept as counted.
                </div>
              )}
            </section>
            {d.corrections.length > 0 && (
              <section>
                <h3 className="font-bold text-slate-900 mb-1">CORRECTIONS (audited; original figures kept)</h3>
                {d.corrections.map((c: any) => (
                  <div key={c.id} className="border-t border-slate-100 py-1">
                    {when(c.at)} · {c.by}: counted {money(c.previous_actual_cash)} → {money(c.corrected_actual_cash)} · variance <span className={vTone(c.corrected_variance)}>{fmtVariance(cur, c.corrected_variance)}</span>
                    <div className="text-slate-500">{c.reason}</div>
                  </div>
                ))}
              </section>
            )}
            <section>
              <h3 className="font-bold text-slate-900 mb-1">TRANSACTIONS</h3>
              <div className="flex flex-wrap gap-1.5">
                {currentUser.role !== 'CASHIER' && (
                  <button onClick={() => { navigateTo('history', 'sales', { shift_id: sh.id, ...(sh.shop_id && allShops ? { shop_id: sh.shop_id } : {}) }); onClose(); }}
                    className="px-2.5 py-1.5 rounded border border-slate-300 font-semibold">View sales of this shift</button>
                )}
                {currentUser.role !== 'CASHIER' && !online && <button onClick={() => { navigateTo('returns'); onClose(); }} className="px-2.5 py-1.5 rounded border border-slate-300 font-semibold">Returns</button>}
                {currentUser.role !== 'CASHIER' && !online && <button onClick={() => { navigateTo('expenses'); onClose(); }} className="px-2.5 py-1.5 rounded border border-slate-300 font-semibold">Expenses</button>}
                <button onClick={() => getShiftMedicines(sh.id, sh.shop_id).then((x) => setMeds(x.medicines)).catch((e) => setError(e?.message || 'Could not load medicines.'))}
                  className="px-2.5 py-1.5 rounded border border-teal-600 text-teal-800 font-semibold flex items-center gap-1"><Pill className="w-3.5 h-3.5" /> View Medicines Sold During Shift</button>
              </div>
              {meds && (
                <table className="w-full mt-2">
                  <thead className="text-[10px] uppercase text-slate-500"><tr><th className="text-left">Medicine</th><th className="text-right">Sold</th><th className="text-right">Returns</th><th className="text-right">Net sold</th></tr></thead>
                  <tbody>
                    {meds.length === 0 && <tr><td colSpan={4} className="text-slate-500 py-1">Nothing sold in this shift.</td></tr>}
                    {meds.map((m) => <tr key={m.medicine_id} className="border-t border-slate-100"><td>{m.name}</td><td className="text-right">{m.quantity_sold}</td><td className="text-right">{m.returned}</td><td className="text-right font-semibold">{m.net_sold}</td></tr>)}
                  </tbody>
                </table>
              )}
              {d.refunds.length > 0 && (
                <div className="mt-2"><div className="font-semibold">Refunds paid from this till</div>
                  {d.refunds.map((r: any) => <div key={r.id} className="flex justify-between border-t border-slate-100 py-0.5"><span>{r.receipt_number} · {r.medicine_name} × {r.approved_quantity}</span><span>{r.refund_method} {money(r.refund_amount)}</span></div>)}</div>
              )}
              {d.expenses.length > 0 && (
                <div className="mt-2"><div className="font-semibold">Expenses paid from this till</div>
                  {d.expenses.map((e: any) => <div key={e.id} className="flex justify-between border-t border-slate-100 py-0.5"><span className={e.status === 'voided' ? 'line-through' : ''}>{e.category} · {e.description}</span><span>{money(e.amount)}</span></div>)}</div>
              )}
              {d.voided_sales.length > 0 && (
                <div className="mt-2"><div className="font-semibold">Voided sales (excluded from totals)</div>
                  {d.voided_sales.map((v: any) => <div key={v.id} className="flex justify-between border-t border-slate-100 py-0.5"><span>{v.receipt_number}</span><span>{money(v.total)}</span></div>)}</div>
              )}
            </section>

            <section className="flex flex-wrap gap-2">
              {sh.status !== 'OPEN' && (
                <button onClick={() => { if (!printShiftReport(sh, { pharmacyName: settings.pharmacy_name, currency: cur, medicines: meds || undefined, reprint: true })) setError('Allow pop-ups to print the report.'); }}
                  className="px-3 py-2 rounded border border-slate-300 font-semibold flex items-center gap-1"><Printer className="w-4 h-4" /> Reprint Shift Report</button>
              )}
              {canAdminClose && <button onClick={() => setAdminClose(true)} className="px-3 py-2 rounded bg-rose-700 text-white font-bold">Close this shift (Administrator)</button>}
            </section>

            {canReview && (
              <section className="rounded border border-emerald-300 bg-emerald-50 p-3 space-y-2">
                <h3 className="font-bold text-emerald-900">REVIEW</h3>
                <p className="text-emerald-900">Reviewing records that the shift was checked. Figures are never changed.{online ? ' Online: the review is sent to the shop and applied there.' : ''}</p>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="w-full px-2 py-1.5 border border-slate-300 rounded" placeholder={(sh.cash_variance ?? 0) !== 0 ? 'Review notes (required for a variance)' : 'Review notes (optional)'} />
                <button disabled={busy} onClick={() => void act(() => (online ? queueRemoteCommand('shift-review', { shift_id: sh.id, ...(notes.trim() ? { notes: notes.trim() } : {}) }) : reviewShift(sh.id, notes)),
                  online ? 'Review queued for the shop (applied when the shop is online).' : 'Shift reviewed.')} className="px-3 py-2 rounded bg-emerald-700 text-white font-bold disabled:opacity-50">Mark Reviewed</button>
              </section>
            )}
            {sh.status === 'CLOSED' && allShops && canReviewShifts(currentUser) && <p className="text-slate-500">Open this shop (not All Shops) to review the shift.</p>}
            {canCorrect && (
              <section className="rounded border border-amber-300 bg-amber-50 p-3 space-y-2">
                <h3 className="font-bold text-amber-900">CORRECT COUNTED CASH (Administrator)</h3>
                <p className="text-amber-900">Adds an audited correction (e.g. a recount). The original closing figures stay unchanged.</p>
                <div className="flex gap-2">
                  <input inputMode="decimal" value={corr.amount} onChange={(e) => setCorr({ ...corr, amount: e.target.value })} placeholder={`Corrected cash (${cur})`} className={`${input} w-40`} />
                  <input value={corr.reason} onChange={(e) => setCorr({ ...corr, reason: e.target.value })} placeholder="Reason" className={`${input} flex-1`} />
                </div>
                <button disabled={busy} onClick={() => void act(() => correctShift(sh.id, Number(corr.amount), corr.reason), 'Correction recorded.')} className="px-3 py-2 rounded bg-amber-700 text-white font-bold disabled:opacity-50">Record Correction</button>
              </section>
            )}
          </div>
        )}
        {adminClose && sh && (
          <CloseShiftDialog settings={settings} shift={sh} live={sh as any} adminClosure onClose={() => setAdminClose(false)} onDone={async () => { await load(); onChanged(); }} />
        )}
      </div>
    </div>
  );
};
