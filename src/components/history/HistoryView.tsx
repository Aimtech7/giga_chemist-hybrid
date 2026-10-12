import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Eye, Loader2, Printer, RefreshCw, RotateCcw, Search, Undo2, X } from 'lucide-react';
import { apiDownload, apiFetch, ApiError } from '../../services/http';
import { createRequestId, getShops, getServerMode, queueRemoteCommand, type OnlineShop } from '../../services/remoteAdmin';
import { isAllShopsScope } from '../../services/shopContext';
import { printThermalReceipt } from '../../services/receiptPrinter';
import { canViewAllShifts, canViewShifts, canViewStockHistory, canViewTransactionHistory } from '../../services/permissions';
import { StockHistoryView } from './StockHistoryView';
import { ShiftHistoryView } from './ShiftHistoryView';
import type { PharmacySettings, Sale, User } from '../../types';

/**
 * HISTORY: Sales + Supply / Purchases (Admin / Manager) and Stock History (every role, incl. Cashier:
 * quantities only, own shop). Every past sale and every supply / purchase, READ ONLY.
 * Filtering, totals and paging run on the server (large histories are never downloaded); one page of
 * lightweight rows reaches the browser and a sale's COMPLETE detail is loaded only when it is opened.
 * Every figure shown for a sale is the value stored AT THE TIME OF SALE (sale_items unit price,
 * discount, total, price mode, batch; the sale's own totals and payments) — never today's prices.
 * Completed sales have no Edit: corrections are Void, Return (approved under Returns) or refund.
 */
export type HistoryTab = 'sales' | 'supplies' | 'stock' | 'shifts';
/**
 * Filters a caller may open the list with, e.g. Stock History -> "View sales":
 * { medicine_id, medicine_label, from, to, shop_id } = the receipts behind one day's Sold figure.
 */
export interface HistoryFilters {
  medicine?: string; medicine_id?: string; medicine_label?: string; from?: string; to?: string; receipt?: string; cashier?: string; status?: string; shop_id?: string;
  /** One cashier shift: Sales -> the sales of that shift; Shifts -> open that shift's detail. */
  shift_id?: string;
}
type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'all' | 'custom';

const day = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
function presetRange(p: Preset): { from: string; to: string } {
  const now = new Date();
  if (p === 'today') return { from: day(now), to: day(now) };
  if (p === 'yesterday') { const y = new Date(now.getTime() - 86_400_000); return { from: day(y), to: day(y) }; }
  if (p === 'week') { const s = new Date(now); s.setDate(now.getDate() - ((now.getDay() + 6) % 7)); return { from: day(s), to: day(now) }; }
  if (p === 'month') return { from: day(new Date(now.getFullYear(), now.getMonth(), 1)), to: day(now) };
  return { from: '', to: '' };
}
const fmtDate = (d: string | null | undefined) => {
  if (!d) return '—';
  const x = new Date(`${String(d).slice(0, 10)}T00:00:00`);
  return isNaN(x.getTime()) ? String(d) : x.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
};
const fmtTime = (t: string | null | undefined) => {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  if (!Number.isFinite(h)) return String(t);
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

const input = 'px-2.5 py-2 border border-slate-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-teal-600 outline-none';

export const HistoryView: React.FC<{ settings: PharmacySettings; currentUser: User; initialTab?: HistoryTab; initialFilters?: HistoryFilters | null }> = ({
  settings, currentUser, initialTab, initialFilters,
}) => {
  // Tabs this user may open: a cashier gets Stock History only (the server enforces the same).
  const tabs = useMemo(() => ([
    ...(canViewTransactionHistory(currentUser) ? [['sales', 'Sales'], ['supplies', 'Supply / Purchases']] : []),
    ...(canViewStockHistory(currentUser) ? [['stock', 'Stock History']] : []),
    // Cashier: "My Shifts" (own shifts only, read only); Administrator / Manager: every shift.
    ...(canViewShifts(currentUser) ? [['shifts', canViewAllShifts(currentUser) ? 'Shifts' : 'My Shifts']] : []),
  ] as [HistoryTab, string][]), [currentUser]);
  const allowed = (t?: HistoryTab) => (t && tabs.some(([id]) => id === t) ? t : tabs[0]?.[0] || 'stock');
  const [tab, setTab] = useState<HistoryTab>(allowed(initialTab));
  // Re-applied on every navigation request (new filters object), even when the requested tab is unchanged.
  useEffect(() => setTab(allowed(initialTab)), [initialTab, initialFilters, tabs]); // eslint-disable-line react-hooks/exhaustive-deps
  const [online, setOnline] = useState(false);
  const [shops, setShops] = useState<OnlineShop[]>([]);
  const allShops = online && isAllShopsScope();
  useEffect(() => {
    void getServerMode().then((m) => setOnline(m === 'online'));
  }, []);
  useEffect(() => {
    if (allShops) getShops().then((d) => setShops(d.shops)).catch(() => setShops([]));
  }, [allShops]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      <div className="px-3 pt-3 pb-2 bg-white border-b border-slate-200 shrink-0">
        <h1 className="text-base font-bold text-slate-900">{tab === 'sales' ? 'Sales History' : tab === 'supplies' ? 'Supply History' : tab === 'shifts' ? (canViewAllShifts(currentUser) ? 'Shift History' : 'My Shifts') : 'Stock History'}</h1>
        <p className="text-[11px] text-slate-500">
          {tab === 'shifts'
            ? `Cashier shifts${allShops ? ' of every shop (each shift stays in its own shop)' : ''}: opening float, sales by payment method, refunds, till expenses, expected vs counted cash and the variance — read only.`
            : tab === 'stock'
            ? `Daily stock per medicine${allShops ? ' for each shop' : ''}: opening, sold, returned, received, adjustments and the stock remaining at the end of each day — from the stock movement ledger, read only.`
            : `Every past transaction${allShops ? ' across ALL SHOPS' : ''}, exactly as recorded at the time — read only. Corrections use void / return (sales) or cancel (pending purchases), always audited.`}
        </p>
        <div className="flex gap-1 mt-2 bg-slate-100 p-1 rounded-lg w-fit">
          {tabs.map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} className={`px-3 py-1.5 rounded-md text-xs font-semibold ${tab === id ? 'bg-white text-teal-800 shadow-xs' : 'text-slate-600'}`}>{label}</button>
          ))}
        </div>
      </div>
      {tab === 'shifts' ? (
        <ShiftHistoryView key={`shifts-${JSON.stringify(initialFilters || {})}`} settings={settings} currentUser={currentUser} online={online} allShops={allShops} shops={shops}
          initialShiftId={initialTab === 'shifts' ? initialFilters?.shift_id || null : null} />
      ) : tab === 'stock' ? (
        <StockHistoryView key={`stock-${JSON.stringify(initialFilters || {})}`} settings={settings} currentUser={currentUser} online={online} allShops={allShops} shops={shops}
          initialFilters={initialTab === 'stock' ? initialFilters || null : null} />
      ) : (
        <HistoryList key={`${tab}-${JSON.stringify(initialFilters || {})}`} kind={tab} settings={settings} currentUser={currentUser} online={online} allShops={allShops} shops={shops}
          initialFilters={initialTab === tab ? initialFilters || null : null} />
      )}
    </div>
  );
};

const HistoryList: React.FC<{ kind: 'sales' | 'supplies'; settings: PharmacySettings; currentUser: User; online: boolean; allShops: boolean; shops: OnlineShop[]; initialFilters: HistoryFilters | null }> = ({
  kind, settings, currentUser, online, allShops, shops, initialFilters,
}) => {
  const cur = settings.currency || 'KES';
  const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${cur} ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const startFilters = (): Record<string, string> => {
    const f: Record<string, string> = kind === 'supplies' ? { status: 'received' } : {};
    const keys = kind === 'sales' ? (['medicine', 'medicine_id', 'receipt', 'cashier', 'status', 'shop_id', 'shift_id'] as const) : (['medicine', 'medicine_id', 'shop_id'] as const);
    for (const k of keys) if (initialFilters?.[k]) f[k] = String(initialFilters[k]);
    return f;
  };
  const medicineLabel = initialFilters?.medicine_label || null;
  // A shift filter shows ALL of that shift's sales, whatever their date.
  const startRange = initialFilters?.shift_id ? presetRange('all')
    : initialFilters && (initialFilters.from || initialFilters.to) ? { from: initialFilters.from || '', to: initialFilters.to || '' } : presetRange('month');
  const [preset, setPreset] = useState<Preset>(initialFilters?.shift_id ? 'all' : initialFilters && (initialFilters.from || initialFilters.to) ? 'custom' : 'month');
  const [range, setRange] = useState(startRange);
  const [f, setF] = useState<Record<string, string>>(startFilters);
  const [applied, setApplied] = useState<Record<string, string>>(startFilters);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ id: string; shop_id: string } | null>(null);
  const [staff, setStaff] = useState<{ id: string; name: string }[]>([]);
  const isAdmin = currentUser.role === 'ADMIN';

  // Cashier filter: this shop's staff (one shop only; All Shops filters by name through the search box).
  useEffect(() => {
    if (kind !== 'sales' || allShops || !isAdmin) return;
    apiFetch<any[]>('/api/users').then((u) => setStaff((u || []).filter((x) => x?.id && x?.name).map((x) => ({ id: x.id, name: x.name })))).catch(() => setStaff([]));
  }, [kind, allShops, isAdmin]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (range.from) p.set('from', range.from);
    if (range.to) p.set('to', range.to);
    for (const [k, v] of Object.entries(applied)) if (v && v.trim()) p.set(k, v.trim());
    return p;
  }, [range, applied]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams(params);
      p.set('page', String(page));
      p.set('page_size', String(size));
      setData(await apiFetch(`/api/history/${kind}?${p.toString()}`));
    } catch (err: any) {
      setError(err?.message || 'Could not load history.');
    } finally {
      setLoading(false);
    }
  }, [kind, params, page, size]);
  useEffect(() => {
    void load();
  }, [load]);

  const apply = () => {
    setPage(1);
    setApplied({ ...f });
  };
  const choosePreset = (p: Preset) => {
    setPreset(p);
    if (p !== 'custom') setRange(presetRange(p));
    setPage(1);
  };
  const exportCsv = async () => {
    try {
      await apiDownload(`/api/history/export/${kind}?${params.toString()}`, `giga-${kind}-history-${range.from || 'all'}-${range.to || 'now'}.csv`);
    } catch (err: any) {
      setError(err?.message || 'Export failed.');
    }
  };
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const s = data?.summary;

  const filterBar = kind === 'sales' ? (
    <>
      <input className={`${input} w-40`} placeholder="Receipt / sale no." value={f.receipt || ''} onChange={set('receipt')} />
      <input className={`${input} w-40`} placeholder="Medicine / barcode" value={f.medicine || ''} onChange={set('medicine')} />
      <input className={`${input} w-36`} placeholder="Customer" value={f.customer || ''} onChange={set('customer')} />
      {staff.length > 0 && (
        <select className={input} value={f.cashier || ''} onChange={set('cashier')} aria-label="Cashier">
          <option value="">Any cashier</option>{staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      )}
      <select className={input} value={f.payment_method || ''} onChange={set('payment_method')} aria-label="Payment method">
        <option value="">Any payment</option>{['Cash', 'M-Pesa', 'Card', 'Bank', 'Mixed'].map((m) => <option key={m} value={m}>{m === 'Mixed' ? 'Mixed / split' : m}</option>)}
      </select>
      <select className={input} value={f.status || ''} onChange={set('status')} aria-label="Status">
        <option value="">Any status</option>
        <option value="completed">Completed</option><option value="partially_returned">Partially returned</option>
        <option value="returned">Returned</option><option value="voided">Voided</option>
      </select>
      <select className={input} value={f.price_mode || ''} onChange={set('price_mode')} aria-label="Price mode">
        <option value="">Retail + wholesale</option><option value="RETAIL">Retail</option><option value="WHOLESALE">Wholesale</option>
      </select>
    </>
  ) : (
    <>
      <input className={`${input} w-36`} placeholder="Supplier" value={f.supplier || ''} onChange={set('supplier')} />
      <input className={`${input} w-36`} placeholder="Medicine / barcode" value={f.medicine || ''} onChange={set('medicine')} />
      <input className={`${input} w-32`} placeholder="Batch" value={f.batch || ''} onChange={set('batch')} />
      <input className={`${input} w-32`} placeholder="Invoice" value={f.invoice || ''} onChange={set('invoice')} />
      <input className={`${input} w-32`} placeholder="Order no." value={f.order || ''} onChange={set('order')} />
      <select className={input} value={f.status || ''} onChange={set('status')} aria-label="Purchase status">
        <option value="">Any status</option><option value="received">Received</option><option value="pending">Pending</option><option value="cancelled">Cancelled</option>
      </select>
      <select className={input} value={f.payment_status || ''} onChange={set('payment_status')} aria-label="Payment status">
        <option value="">Any payment</option><option value="paid">Paid</option><option value="partial">Partial</option><option value="unpaid">Unpaid</option>
      </select>
    </>
  );

  const cards: [string, string][] = !s ? [] : kind === 'sales'
    ? [['Transactions', s.transactions.toLocaleString()], ['Units sold', Number(s.units_sold || 0).toLocaleString()], ['Gross sales', money(s.gross_sales)], ['Discounts', money(s.discounts)],
       ['Net sales', money(s.net_sales)], ['Returns / refunds', money(s.refunds)], ['Cash', money(s.cash)], ['M-Pesa / mobile', money(s.mobile_money)], ['Other payments', money(s.other_payments)],
       ...(s.gross_profit !== undefined ? [['Cost of goods', money(s.cost_of_goods)] as [string, string], ['Gross profit', money(s.gross_profit)] as [string, string]] : [])]
    : [['Supplies', String(s.supplies)], ['Units received', Number(s.units_received).toLocaleString()], ['Purchase value', money(s.purchase_value)], ['Suppliers used', String(s.suppliers_used)]];

  const open = (r: any) => setDetail({ id: r.id, shop_id: r.shop_id });

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-3 space-y-3">
        <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-2">
          <div className="flex flex-wrap gap-2 items-center">
            <select className={input} value={preset} onChange={(e) => choosePreset(e.target.value as Preset)} aria-label="Date range">
              <option value="today">Today</option><option value="yesterday">Yesterday</option><option value="week">This week</option>
              <option value="month">This month</option><option value="custom">Custom range</option><option value="all">All time</option>
            </select>
            <input type="date" className={input} value={range.from} onChange={(e) => { setPreset('custom'); setRange({ ...range, from: e.target.value }); setPage(1); }} aria-label="From" />
            <input type="date" className={input} value={range.to} onChange={(e) => { setPreset('custom'); setRange({ ...range, to: e.target.value }); setPage(1); }} aria-label="To" />
            {allShops && (
              <select className={input} value={f.shop_id || ''} onChange={set('shop_id')} aria-label="Shop">
                <option value="">All shops</option>{shops.map((x) => <option key={x.shop_id} value={x.shop_id}>{x.shop_code} — {x.name}</option>)}
              </select>
            )}
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
              <input className={`${input} pl-7 w-64`} placeholder={kind === 'sales' ? 'Search receipt, sale no., medicine, barcode, customer, cashier…' : 'Search order, invoice, supplier, medicine…'}
                value={f.q || ''} onChange={set('q')} onKeyDown={(e) => e.key === 'Enter' && apply()} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            {filterBar}
            <button onClick={apply} className="px-3 py-2 rounded-lg bg-teal-700 text-white text-xs font-bold">Apply filters</button>
            <button onClick={() => { const z = kind === 'supplies' ? { status: 'received' } : {}; setF(z); setApplied(z); setPage(1); }}
              className="px-3 py-2 rounded-lg border border-slate-300 text-xs font-semibold">Clear</button>
            <button onClick={() => void exportCsv()} className="ml-auto flex items-center gap-1 px-3 py-2 rounded-lg border border-slate-300 text-xs font-semibold"><Download className="w-3.5 h-3.5" /> Export CSV</button>
            <button onClick={() => void load()} className="p-2 rounded-lg hover:bg-slate-100" aria-label="Refresh"><RefreshCw className={`w-4 h-4 text-slate-500 ${loading ? 'animate-spin' : ''}`} /></button>
          </div>
        </div>

        {applied.medicine_id && (
          <div className="flex items-center gap-2 text-xs bg-teal-50 border border-teal-200 text-teal-900 rounded-lg px-3 py-2">
            <span>Showing only {kind === 'sales' ? 'sales' : 'supplies'} of <b>{medicineLabel || 'the selected medicine'}</b> (opened from Stock History).</span>
            <button onClick={() => { const { medicine_id: _m, ...rest } = applied; setApplied(rest); setF(rest); setPage(1); }} className="ml-auto underline font-semibold">Show all</button>
          </div>
        )}
        {applied.shift_id && (
          <div className="flex items-center gap-2 text-xs bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg px-3 py-2">
            <span>Showing only the sales of one <b>cashier shift</b> (opened from Shift details).</span>
            <button onClick={() => { const { shift_id: _s, ...rest } = applied; setApplied(rest); setF(rest); setPage(1); }} className="ml-auto underline font-semibold">Show all</button>
          </div>
        )}
        {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}

        {s && (
          <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-11 gap-2">
            {cards.map(([k, v]) => (
              <div key={k} className="bg-white border border-slate-200 rounded-lg px-2.5 py-2">
                <div className="text-sm font-bold text-slate-900 truncate">{v}</div>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">{k}</div>
              </div>
            ))}
          </div>
        )}
        {s && s.by_shop?.length > 1 && (
          <div className="bg-white border border-slate-200 rounded-lg p-2 text-xs overflow-x-auto">
            <div className="font-bold text-slate-700 mb-1">Per-shop contribution</div>
            <table className="w-full"><tbody>
              {s.by_shop.map((x: any) => (
                <tr key={x.shop_id} className="border-t border-slate-100">
                  <td className="py-1 pr-3 font-semibold">{x.shop_code} — {x.shop_name}</td>
                  {kind === 'sales'
                    ? <><td className="pr-3">{x.transactions} sales</td><td className="pr-3">{x.units_sold} units</td><td className="pr-3">net {money(x.net_sales)}</td><td className="pr-3">refunds {money(x.refunds)}</td>{x.gross_profit !== undefined && <td>profit {money(x.gross_profit)}</td>}</>
                    : <><td className="pr-3">{x.supplies} supplies</td><td className="pr-3">{x.units_received} units</td><td>{money(x.purchase_value)}</td></>}
                </tr>
              ))}
            </tbody></table>
          </div>
        )}

        {/* Desktop: a wide table (uses the whole screen). Phones: cards. Click a row/card for the complete detail. */}
        <div className="hidden md:block bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500 uppercase text-[10px] tracking-wide">
              {kind === 'sales' ? (
                <tr>{[...(allShops ? ['Shop'] : []), 'Receipt', 'Date', 'Time', 'Cashier', 'Customer', 'Items', 'Units', 'Mode', 'Subtotal', 'Discount', 'Total', 'Payment', 'Status',
                  ...(isAdmin ? ['Profit'] : []), ''].map((h, i) => <th key={`${h}${i}`} className="text-left px-2 py-2 whitespace-nowrap">{h}</th>)}</tr>
              ) : (
                <tr>{['Received', ...(allShops ? ['Shop'] : []), 'Order', 'Invoice', 'Supplier', 'Lines', 'Units', 'Purchase cost', 'Payment', 'Status', 'Received by', 'Reference']
                  .map((h) => <th key={h} className="text-left px-2 py-2 whitespace-nowrap">{h}</th>)}</tr>
              )}
            </thead>
            <tbody>
              {(data?.rows || []).map((r: any) => (
                <tr key={`${r.shop_id}-${r.id}`} onClick={() => open(r)} className="border-t border-slate-100 hover:bg-teal-50 cursor-pointer whitespace-nowrap">
                  {kind === 'sales' ? (
                    <>
                      {allShops && <td className="px-2 py-1.5"><span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 font-bold">{r.shop_code}</span></td>}
                      <td className="px-2 py-1.5 font-mono font-semibold">{r.receipt_number}</td><td className="px-2">{fmtDate(r.date)}</td><td className="px-2">{fmtTime(r.time)}</td>
                      <td className="px-2">{r.cashier_name || '—'}</td><td className="px-2">{r.customer_name || 'Walk-in'}</td><td className="px-2 text-center">{r.item_count}</td><td className="px-2 text-center">{r.units}</td>
                      <td className="px-2"><ModeTag m={r.price_mode} /></td><td className="px-2 text-right">{money(r.subtotal)}</td><td className="px-2 text-right">{Number(r.discount_total) ? money(r.discount_total) : '—'}</td>
                      <td className="px-2 text-right font-bold">{money(r.total)}</td><td className="px-2">{r.payment_method}</td>
                      <td className="px-2"><StatusTag s={r.status} /></td>{isAdmin && <td className="px-2 text-right">{money(r.gross_profit)}</td>}
                      <td className="px-2"><span className="inline-flex items-center gap-1 text-teal-800 font-semibold"><Eye className="w-3.5 h-3.5" /> View</span></td>
                    </>
                  ) : (
                    <>
                      <td className="px-2 py-1.5">{fmtDate(r.received_date || r.order_date)}</td>{allShops && <td className="px-2 font-semibold">{r.shop_code}</td>}
                      <td className="px-2 font-mono">{r.order_number}</td><td className="px-2 font-mono">{r.invoice_number || '—'}</td><td className="px-2">{r.supplier_name || '—'}</td>
                      <td className="px-2">{r.item_count}</td><td className="px-2">{r.units}</td><td className="px-2 text-right font-bold">{money(r.total_amount)}</td>
                      <td className="px-2">{r.payment_status || '—'}</td><td className="px-2"><StatusTag s={r.status} /></td><td className="px-2">{r.received_by || '—'}</td>
                      <td className="px-2 max-w-[12rem] truncate">{r.reference || '—'}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="md:hidden space-y-2">
          {(data?.rows || []).map((r: any) => (
            <button key={`${r.shop_id}-${r.id}`} onClick={() => open(r)} className="w-full text-left bg-white border border-slate-200 rounded-xl p-3">
              {kind === 'sales' ? (
                <>
                  <div className="flex justify-between gap-2">
                    <div className="min-w-0">
                      {allShops && <div className="text-[10px] font-bold text-amber-800">{r.shop_code} — {r.shop_name}</div>}
                      <div className="text-sm font-bold font-mono truncate">Receipt {r.receipt_number}</div>
                      <div className="text-[11px] text-slate-500">{fmtDate(r.date)} • {fmtTime(r.time)}</div>
                    </div>
                    <div className="text-right"><div className="text-sm font-bold">{money(r.total)}</div><StatusTag s={r.status} /></div>
                  </div>
                  <div className="text-[11px] text-slate-600 mt-1">Cashier: {r.cashier_name || '—'} · Customer: {r.customer_name || 'Walk-in'}</div>
                  <div className="text-[11px] text-slate-600">{r.item_count} item{r.item_count === 1 ? '' : 's'} • {r.units} unit{r.units === 1 ? '' : 's'} · {r.payment_method} · <ModeTag m={r.price_mode} /></div>
                </>
              ) : (
                <>
                  <div className="flex justify-between"><span className="text-sm font-bold font-mono">{r.order_number}</span><span className="text-sm font-bold">{money(r.total_amount)}</span></div>
                  <div className="text-[11px] text-slate-500">{fmtDate(r.received_date || r.order_date)} · {r.supplier_name || '—'} · {r.item_count} lines / {r.units} units</div>
                  <StatusTag s={r.status} />
                </>
              )}
            </button>
          ))}
        </div>
        {loading && !data && <div className="p-4 text-xs text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}
        {data && data.rows.length === 0 && <div className="p-4 text-xs text-slate-500 text-center bg-white rounded-xl border border-slate-200">Nothing matches these filters.</div>}

        {data && (
          <div className="flex items-center justify-between text-xs">
            <div className="text-slate-600">{Number(data.total).toLocaleString()} records · page {data.page} of {data.pages}</div>
            <div className="flex items-center gap-2">
              <select className={input} value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(1); }} aria-label="Rows per page">
                {[25, 50, 100].map((n) => <option key={n} value={n}>{n} / page</option>)}
              </select>
              <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="p-1.5 rounded border border-slate-300 disabled:opacity-40" aria-label="Previous page"><ChevronLeft className="w-4 h-4" /></button>
              <button disabled={page >= data.pages} onClick={() => setPage(page + 1)} className="p-1.5 rounded border border-slate-300 disabled:opacity-40" aria-label="Next page"><ChevronRight className="w-4 h-4" /></button>
            </div>
          </div>
        )}
      </div>

      {detail && kind === 'sales' && (
        <SaleDrawer id={detail.id} shopId={detail.shop_id} settings={settings} currentUser={currentUser} online={online} allShops={allShops} money={money}
          onClose={() => setDetail(null)} onChanged={() => void load()} />
      )}
      {detail && kind === 'supplies' && <SupplyDrawer id={detail.id} money={money} onClose={() => setDetail(null)} />}
    </div>
  );
};

const StatusTag: React.FC<{ s: string }> = ({ s }) => {
  const t = String(s || '').toLowerCase();
  const cls = t === 'voided' || t === 'cancelled' || t === 'rejected' ? 'bg-rose-50 text-rose-700' : t.includes('return') || t === 'pending' ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800';
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${cls}`}>{t.replace(/_/g, ' ') || '—'}</span>;
};
const ModeTag: React.FC<{ m: string }> = ({ m }) => {
  const w = String(m || 'RETAIL').toUpperCase() === 'WHOLESALE';
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${w ? 'bg-violet-100 text-violet-800' : 'bg-slate-100 text-slate-700'}`}>{w ? 'WHOLESALE' : 'RETAIL'}</span>;
};

const Drawer: React.FC<{ title: string; onClose: () => void; children: React.ReactNode }> = ({ title, onClose, children }) => (
  <div className="fixed inset-0 z-50 bg-slate-900/50 flex justify-end">
    <div className="bg-white w-full md:max-w-3xl h-full overflow-y-auto p-4 space-y-3">
      <div className="flex items-center justify-between sticky top-0 bg-white pb-1"><h2 className="text-base font-black tracking-tight text-slate-900">{title}</h2>
        <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100" aria-label="Close"><X className="w-5 h-5 text-slate-500" /></button></div>
      {children}
    </div>
  </div>
);
const KV: React.FC<{ rows: [string, React.ReactNode][] }> = ({ rows }) => (
  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">{rows.map(([k, v]) => <React.Fragment key={k}><div className="text-slate-500">{k}</div><div className="font-semibold text-slate-900 text-right">{v ?? '—'}</div></React.Fragment>)}</div>
);
const Section: React.FC<{ title: string; tone?: 'danger'; children: React.ReactNode }> = ({ title, tone, children }) => (
  <div className={`border rounded-lg ${tone === 'danger' ? 'border-rose-300' : 'border-slate-200'}`}>
    <div className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide border-b ${tone === 'danger' ? 'text-rose-800 bg-rose-50 border-rose-200' : 'text-slate-600 bg-slate-50 border-slate-200'}`}>{title}</div>
    <div className="p-2 overflow-x-auto">{children}</div>
  </div>
);

const SaleDrawer: React.FC<{ id: string; shopId: string; settings: PharmacySettings; currentUser: User; online: boolean; allShops: boolean; money: (n: any) => string; onClose: () => void; onChanged: () => void }> = ({
  id, shopId, settings, currentUser, online, allShops, money, onClose, onChanged,
}) => {
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [returning, setReturning] = useState(false);
  // The detail is always fetched for the sale's OWN shop (the row's shop, re-checked by the server).
  const detailUrl = `/api/history/sales/${id}?shop_id=${encodeURIComponent(shopId)}`;
  const reload = useCallback(() => apiFetch(detailUrl).then(setD).catch((e: any) => setError(e?.message || 'Could not load the sale.')), [detailUrl]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const reprint = async () => {
    setBusy(true);
    try {
      const r: any = await apiFetch(`/api/history/sales/${id}/reprint?shop_id=${encodeURIComponent(shopId)}`, { method: 'POST', body: {} });
      const sale = {
        ...r.sale, items: r.items.map((i: any) => ({ ...i, expiry_date: i.expiry_date || '—' })),
        split_payments: r.payments.length > 1 ? r.payments : undefined, cashier_name: r.sale.cashier_name || '',
      } as unknown as Sale;
      printThermalReceipt(sale, settings, { copyLabel: 'REPRINT — COPY' });
      setNotice('Receipt reprinted as a COPY from the stored sale (no new sale, no stock or total change; the reprint is audited).');
    } catch (e: any) {
      setError(e?.message || 'Reprint failed.');
    } finally {
      setBusy(false);
    }
  };
  const voidSale = async () => {
    const reason = window.prompt('Void reason (recorded in the audit trail):');
    if (!reason || reason.trim().length < 3) return;
    if (!window.confirm(`Void receipt ${d.sale.receipt_number}${online ? ` at ${d.sale.shop_code || 'the shop'}` : ''}? Stock is returned; the sale is kept as VOIDED.`)) return;
    setBusy(true);
    try {
      if (online) {
        const q = await queueRemoteCommand('sale-void', { sale_id: id, reason: reason.trim() }, createRequestId());
        setNotice(`Void sent to the shop (${q.status}). It shows here once the shop applies it.${q.warning ? ` ${q.warning}` : ''}`);
      } else {
        await apiFetch(`/api/sales/${id}/void`, { method: 'POST', body: { reason: reason.trim() } });
        setNotice('Sale voided.');
        onChanged();
        await reload();
      }
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : 'Void failed.');
    } finally {
      setBusy(false);
    }
  };

  const sale = d?.sale;
  const completed = sale && ['completed', 'partially_returned'].includes(String(sale.status).toLowerCase());
  const canVoid = currentUser.role === 'ADMIN' && sale && String(sale.status).toLowerCase() === 'completed' && !allShops;
  const hasCost = d?.items?.[0]?.cost_price_snapshot !== undefined;

  return (
    <Drawer title="SALE DETAILS" onClose={onClose}>
      {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}
      {notice && <div className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded p-2">{notice}</div>}
      {!d && !error && <div className="text-xs text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading the stored sale…</div>}
      {d && (
        <>
          {d.void && (
            <div className="rounded-lg border-2 border-rose-500 bg-rose-50 p-3 text-sm text-rose-900">
              <div className="font-black tracking-wide">VOIDED SALE</div>
              <div className="text-xs mt-1">Reason: <b>{d.void.reason || 'not recorded'}</b>{d.void.voided_by ? ` · by ${d.void.voided_by}` : ''}{d.void.voided_at ? ` · ${new Date(d.void.voided_at).toLocaleString()}` : ''}</div>
              <div className="text-[11px] mt-1">The original transaction below is kept unchanged for audit.</div>
            </div>
          )}
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-lg font-black font-mono">Receipt {sale.receipt_number}</div>
              <div className="text-xs text-slate-500">{fmtDate(sale.date)} • {fmtTime(sale.time)}</div>
            </div>
            <div className="flex flex-col items-end gap-1"><StatusTag s={sale.status} /><ModeTag m={sale.price_mode} /></div>
          </div>
          <Section title="Transaction">
            <KV rows={[['Receipt number', sale.receipt_number], ['Sale number', sale.sale_number],
              ['Shop', sale.shop_code ? `${sale.shop_code} — ${sale.shop_name}` : sale.shop_name], ['Date', fmtDate(sale.date)], ['Time', fmtTime(sale.time) || '—'],
              ['Cashier', sale.cashier_name], ['Device / terminal', sale.device_id], ['Status', <StatusTag key="s" s={sale.status} />], ['Price mode', <ModeTag key="m" m={sale.price_mode} />]]} />
          </Section>
          <Section title="Customer">
            {sale.walk_in ? <div className="text-xs font-semibold">Walk-in customer</div>
              : <KV rows={[['Name', sale.customer_name || '(customer record not available)'], ['Phone', sale.customer_phone || '—']]} />}
          </Section>
          <Section title={`Items sold (${d.quantities.different_medicines} medicine${d.quantities.different_medicines === 1 ? '' : 's'} · ${d.quantities.total_units} unit${d.quantities.total_units === 1 ? '' : 's'})`}>
            <table className="w-full text-xs">
              <thead className="text-slate-500"><tr>{['Medicine', 'Batch', 'Qty', 'Returned', 'Net', 'Unit price', 'Mode', 'Discount', 'Line total', ...(hasCost ? ['Cost', 'Profit'] : [])]
                .map((h) => <th key={h} className="text-left pr-2 pb-1 whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>{d.items.map((i: any, n: number) => (
                <tr key={n} className="border-t border-slate-100 align-top">
                  <td className="pr-2 py-1"><div className="font-semibold">{i.medicine_name}</div>
                    {(i.generic_name || i.brand_name) && <div className="text-[10px] text-slate-500">{[i.generic_name && i.generic_name !== i.medicine_name ? i.generic_name : null, i.brand_name].filter(Boolean).join(' · ')}</div>}</td>
                  <td className="pr-2 font-mono whitespace-nowrap">{i.batch_number}</td>
                  <td className="pr-2 font-bold">{i.quantity}</td>
                  <td className="pr-2">{i.returned_quantity ? <span className="text-amber-800 font-semibold">{i.returned_quantity}</span> : '—'}{i.pending_return_quantity ? <div className="text-[10px] text-amber-700">{i.pending_return_quantity} pending</div> : null}</td>
                  <td className="pr-2 font-semibold">{i.net_quantity}</td>
                  <td className="pr-2 whitespace-nowrap">{money(i.unit_price)}</td>
                  <td className="pr-2"><ModeTag m={i.price_mode} /></td>
                  <td className="pr-2 whitespace-nowrap">{Number(i.discount) ? money(i.discount) : '—'}</td>
                  <td className="pr-2 font-bold whitespace-nowrap">{money(i.total)}</td>
                  {hasCost && <><td className="pr-2 whitespace-nowrap">{money(i.cost_price_snapshot)}</td><td className="whitespace-nowrap">{money(i.profit)}</td></>}
                </tr>
              ))}</tbody>
            </table>
            <div className="text-[11px] text-slate-600 mt-2 flex flex-wrap gap-x-4">
              <span>Different medicines: <b>{d.quantities.different_medicines}</b></span><span>Total units sold: <b>{d.quantities.total_units}</b></span>
              {d.quantities.returned_units > 0 && <span>Returned (approved): <b>{d.quantities.returned_units}</b></span>}<span>Net units: <b>{d.quantities.net_units}</b></span>
            </div>
            <div className="text-[10px] text-slate-400 mt-1">Prices, discounts and totals are the values stored when the sale was made, not today's prices.</div>
          </Section>
          <Section title="Totals">
            <KV rows={[['Subtotal', money(sale.subtotal)], ['Discount', money(sale.discount_total)],
              ['Discount rate', sale.discount_percent !== null && sale.discount_percent !== undefined ? `${sale.discount_percent}%` : '—'],
              ...(Number(sale.tax_total) ? [['Tax', money(sale.tax_total)] as [string, string]] : []),
              ['Final total', <span key="t" className="text-sm">{money(sale.total)}</span>],
              ...(sale.gross_profit !== undefined ? [['Cost of goods', money(sale.cost_total)] as [string, string], ['Gross profit', money(sale.gross_profit)] as [string, string]] : [])]} />
          </Section>
          <Section title={`Payments${d.payments.length > 1 ? ` (${d.payments.length} — split)` : ''}`}>
            {d.payments.length === 0
              ? <div className="text-xs">{sale.payment_method}{sale.payment_reference ? ` · ref ${sale.payment_reference}` : ''} (no separate payment lines recorded)</div>
              : d.payments.map((p: any, n: number) => (
                <div key={n} className="flex justify-between text-xs py-0.5"><span>{p.method}{p.reference ? <span className="text-slate-500"> · ref <span className="font-mono">{p.reference}</span></span> : ''}</span><span className="font-semibold">{money(p.amount)}</span></div>
              ))}
            <div className="border-t border-slate-200 mt-1 pt-1"><KV rows={[['Payment method', sale.payment_method], ['Reference', sale.payment_reference || '—'],
              ['Total paid', money(d.total_paid)], ['Amount received', money(sale.amount_received)], ['Change given', money(sale.change_given)]]} /></div>
          </Section>
          {d.returns.length > 0 && (
            <Section title={`Returns (${d.returns.length})`}>
              <table className="w-full text-xs"><thead className="text-slate-500"><tr>{['Medicine', 'Sold', 'Returned', 'Approved', 'Refund', 'Restocked', 'Status', 'Reason', 'Reviewed by', 'Reviewed at']
                .map((h) => <th key={h} className="text-left pr-2 whitespace-nowrap">{h}</th>)}</tr></thead>
                <tbody>{d.returns.map((r: any) => (
                  <tr key={r.id} className="border-t border-slate-100"><td className="pr-2 py-1">{r.medicine_name}</td><td className="pr-2">{r.original_quantity ?? '—'}</td><td className="pr-2">{r.quantity}</td>
                    <td className="pr-2">{r.approved_quantity ?? '—'}</td><td className="pr-2 whitespace-nowrap">{r.status === 'APPROVED' ? money(r.refund_amount) : r.requested_refund !== null ? `(${money(r.requested_refund)} requested)` : '—'}</td>
                    <td className="pr-2">{r.restocked === null ? '—' : r.restocked ? 'Yes' : 'No'}</td><td className="pr-2"><StatusTag s={r.status} /></td><td className="pr-2">{r.reason || '—'}</td>
                    <td className="pr-2">{r.reviewed_by || '—'}</td><td className="whitespace-nowrap">{r.reviewed_at ? new Date(r.reviewed_at).toLocaleString() : '—'}</td></tr>
                ))}</tbody></table>
            </Section>
          )}
          <Section title="Audit">
            {d.audit.length === 0 ? <div className="text-xs text-slate-500">No audit entries recorded for this sale.</div> :
              d.audit.map((a: any, n: number) => <div key={n} className="text-xs py-0.5"><b>{a.action}</b> · {a.by || '—'} · {a.at ? new Date(a.at).toLocaleString() : ''}</div>)}
          </Section>

          <div className="flex flex-wrap gap-2 sticky bottom-0 bg-white pt-2 border-t border-slate-200">
            <button disabled={busy} onClick={() => void reprint()} className="flex items-center gap-1 px-3 py-2 rounded-lg border border-slate-300 text-xs font-semibold"><Printer className="w-4 h-4" /> Reprint receipt</button>
            {completed && !online && (
              <button disabled={busy} onClick={() => setReturning(true)} className="flex items-center gap-1 px-3 py-2 rounded-lg border border-amber-300 text-amber-800 text-xs font-semibold"><RotateCcw className="w-4 h-4" /> Return item</button>
            )}
            {canVoid && (
              <button disabled={busy} onClick={() => void voidSale()} className="flex items-center gap-1 px-3 py-2 rounded-lg border border-rose-300 text-rose-700 text-xs font-semibold"><Undo2 className="w-4 h-4" /> Void sale</button>
            )}
            <span className="text-[11px] text-slate-500 self-center">
              No edit: a completed sale is never changed.{online && completed ? ' Returns are requested at the shop till and approved under Returns.' : ''}
            </span>
          </div>
        </>
      )}
      {returning && d && (
        <ReturnSheet saleId={id} items={d.items} money={money} onClose={() => setReturning(false)} onDone={async () => { setReturning(false); setNotice('Return requested (PENDING). Approve it under Returns; only an approved return changes stock and refunds.'); await reload(); onChanged(); }} />
      )}
    </Drawer>
  );
};

/** Shop app only: requests a return for one sold line (PENDING; approval stays under Returns). */
const ReturnSheet: React.FC<{ saleId: string; items: any[]; money: (n: any) => string; onClose: () => void; onDone: () => void }> = ({ saleId, items, money, onClose, onDone }) => {
  const returnable = items.filter((i) => i.net_quantity - (i.pending_return_quantity || 0) > 0);
  const [line, setLine] = useState(0);
  const [qty, setQty] = useState('1');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const it = returnable[line];
  const submit = async () => {
    setError(null);
    const n = Number(qty);
    if (!it) return setError('Nothing on this sale can still be returned.');
    if (!/^\d+$/.test(qty) || n < 1 || n > it.net_quantity - (it.pending_return_quantity || 0)) return setError(`Quantity must be 1 to ${it.net_quantity - (it.pending_return_quantity || 0)}.`);
    if (reason.trim().length < 3) return setError('Give a reason.');
    setBusy(true);
    try {
      await apiFetch('/api/returns', { method: 'POST', body: { sale_id: saleId, medicine_id: it.medicine_id, batch_id: it.batch_id, quantity: n, reason: reason.trim() } });
      onDone();
    } catch (e: any) {
      setError(e?.message || 'Return request failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[60] bg-slate-900/50 flex items-center justify-center p-3">
      <div className="bg-white rounded-xl w-full max-w-md p-4 space-y-2">
        <div className="flex justify-between items-center"><div className="font-bold">Return item</div><button onClick={onClose} aria-label="Close"><X className="w-5 h-5" /></button></div>
        {returnable.length === 0 ? <div className="text-xs text-slate-600">Every unit of this sale is already returned or awaiting approval.</div> : (
          <>
            <select className={`${input} w-full`} value={line} onChange={(e) => setLine(Number(e.target.value))}>
              {returnable.map((i, n) => <option key={n} value={n}>{i.medicine_name} · batch {i.batch_number} · {i.net_quantity - (i.pending_return_quantity || 0)} returnable @ {money(i.unit_price)}</option>)}
            </select>
            <input className={`${input} w-full`} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Quantity" />
            <input className={`${input} w-full`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" />
            <p className="text-[11px] text-slate-500">Creates a PENDING return. The refund is computed from the original sale price when an Administrator approves it.</p>
          </>
        )}
        {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}
        <div className="grid grid-cols-2 gap-2">
          <button onClick={onClose} className="px-3 py-2 rounded-lg border border-slate-300 text-xs font-semibold">Cancel</button>
          <button disabled={busy || returnable.length === 0} onClick={() => void submit()} className="px-3 py-2 rounded-lg bg-teal-700 text-white text-xs font-bold disabled:opacity-50">Request return</button>
        </div>
      </div>
    </div>
  );
};

const SupplyDrawer: React.FC<{ id: string; money: (n: any) => string; onClose: () => void }> = ({ id, money, onClose }) => {
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiFetch(`/api/history/supplies/${id}`).then(setD).catch((e: any) => setError(e?.message || 'Could not load the purchase.'));
  }, [id]);
  return (
    <Drawer title={d ? `Purchase ${d.purchase.order_number}` : 'Purchase'} onClose={onClose}>
      {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}
      {!d && !error && <div className="text-xs text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}
      {d && (
        <>
          <KV rows={[['Shop', d.purchase.shop_code ? `${d.purchase.shop_code} — ${d.purchase.shop_name}` : d.purchase.shop_name], ['Invoice', d.purchase.invoice_number],
            ['Supplier', d.purchase.supplier_name], ['Ordered', d.purchase.order_date], ['Received', d.purchase.received_date], ['Received by', d.purchase.received_by],
            ['Payment', d.purchase.payment_status], ['Status', <StatusTag key="s" s={d.purchase.status} />], ['Total', money(d.purchase.total_amount)], ['Notes', d.purchase.notes]]} />
          <p className="text-[11px] text-slate-500">A received purchase is never edited or deleted (its stock is posted). Corrections need an audited stock correction / return to supplier.</p>
          <Section title={`Items (${d.items.length})`}>
            <table className="w-full text-xs"><thead className="text-slate-500"><tr>{['Medicine', 'Batch', 'Expiry', 'Qty', 'Buy price', 'Line total', 'Sell now*', 'Wholesale now*'].map((h) => <th key={h} className="text-left pr-2">{h}</th>)}</tr></thead>
              <tbody>{d.items.map((i: any, n: number) => (
                <tr key={n} className="border-t border-slate-100"><td className="pr-2 py-1">{i.medicine_name}</td><td className="pr-2 font-mono">{i.batch_number}</td><td className="pr-2">{i.expiry_date || 'unknown'}</td>
                  <td className="pr-2">{i.quantity}</td><td className="pr-2">{money(i.purchase_price)}</td><td className="pr-2 font-semibold">{money(i.total)}</td>
                  <td className="pr-2">{money(i.batch_selling_override ?? i.current_selling_price)}</td><td>{money(i.current_wholesale_price)}</td></tr>
              ))}</tbody></table>
            <div className="text-[10px] text-slate-400 mt-1">* Selling prices are not recorded on a purchase: shown as they are now (batch override, else medicine price).</div>
          </Section>
          <Section title={`Stock movements (${d.movements.length})`}>
            {d.movements.length === 0 ? <div className="text-xs text-slate-500">No stock movement references this purchase (pending or cancelled purchases post no stock).</div> :
              d.movements.map((m: any, n: number) => (
                <div key={n} className="text-xs py-0.5">{m.medicine_name}: {m.previous_quantity} → {m.new_quantity} (<b>{m.delta > 0 ? '+' : ''}{m.delta}</b>) · {m.movement_type} · {m.occurred_at ? new Date(m.occurred_at).toLocaleString() : ''}</div>
              ))}
          </Section>
        </>
      )}
    </Drawer>
  );
};
