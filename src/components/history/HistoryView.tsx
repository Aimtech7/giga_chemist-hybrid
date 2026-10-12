import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Loader2, Printer, RefreshCw, Search, Undo2, X } from 'lucide-react';
import { apiDownload, apiFetch, ApiError } from '../../services/http';
import { createRequestId, getShops, getServerMode, queueRemoteCommand, type OnlineShop } from '../../services/remoteAdmin';
import { isAllShopsScope } from '../../services/shopContext';
import { printThermalReceipt } from '../../services/receiptPrinter';
import type { PharmacySettings, Sale, User } from '../../types';

/**
 * HISTORY (Admin / Manager): every past sale and every supply / purchase, READ ONLY.
 * Filtering, totals and paging run on the server (large histories are never downloaded); one page of
 * rows reaches the browser. Completed sales have no Edit: corrections are Void (audited) or the return
 * workflow; received purchases are never edited or deleted. Online, the shop is the header's selection
 * (or All Shops for a Global Administrator, with a Shop column and per-shop totals).
 */
export type HistoryTab = 'sales' | 'supplies';
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

const input = 'px-2.5 py-2 border border-slate-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-teal-600 outline-none';

export const HistoryView: React.FC<{ settings: PharmacySettings; currentUser: User; initialTab?: HistoryTab }> = ({ settings, currentUser, initialTab }) => {
  const [tab, setTab] = useState<HistoryTab>(initialTab || 'sales');
  useEffect(() => setTab(initialTab || 'sales'), [initialTab]);
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
        <h1 className="text-base font-bold text-slate-900">History</h1>
        <p className="text-[11px] text-slate-500">
          Every past transaction{allShops ? ' across ALL SHOPS' : ''}, read only. Corrections use void / return (sales) or cancel (pending purchases), always audited.
        </p>
        <div className="flex gap-1 mt-2 bg-slate-100 p-1 rounded-lg w-fit">
          {([['sales', 'Sales'], ['supplies', 'Supply / Purchases']] as [HistoryTab, string][]).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} className={`px-3 py-1.5 rounded-md text-xs font-semibold ${tab === id ? 'bg-white text-teal-800 shadow-xs' : 'text-slate-600'}`}>{label}</button>
          ))}
        </div>
      </div>
      <HistoryList key={tab} kind={tab} settings={settings} currentUser={currentUser} online={online} allShops={allShops} shops={shops} />
    </div>
  );
};

const HistoryList: React.FC<{ kind: HistoryTab; settings: PharmacySettings; currentUser: User; online: boolean; allShops: boolean; shops: OnlineShop[] }> = ({
  kind, settings, currentUser, online, allShops, shops,
}) => {
  const cur = settings.currency || 'KES';
  const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${cur} ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const [preset, setPreset] = useState<Preset>('month');
  const [range, setRange] = useState(presetRange('month'));
  const [f, setF] = useState<Record<string, string>>(kind === 'supplies' ? { status: 'received' } : {});
  const [applied, setApplied] = useState<Record<string, string>>(f);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

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
  const isAdmin = currentUser.role === 'ADMIN';

  const filterBar = kind === 'sales' ? (
    <>
      <input className={`${input} w-40`} placeholder="Receipt / sale no." value={f.receipt || ''} onChange={set('receipt')} />
      <input className={`${input} w-40`} placeholder="Medicine / barcode" value={f.medicine || ''} onChange={set('medicine')} />
      <input className={`${input} w-36`} placeholder="Customer" value={f.customer || ''} onChange={set('customer')} />
      <select className={input} value={f.payment_method || ''} onChange={set('payment_method')} aria-label="Payment method">
        <option value="">Any payment</option>{['Cash', 'M-Pesa', 'Card', 'Bank', 'Split'].map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      <select className={input} value={f.status || ''} onChange={set('status')} aria-label="Status">
        <option value="">Any status</option>
        <option value="completed">Completed</option><option value="voided">Voided</option>
        <option value="partially_returned">Partially returned</option><option value="returned">Returned</option>
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
    ? [['Transactions', String(s.transactions)], ['Gross sales', money(s.gross_sales)], ['Discounts', money(s.discounts)], ['Net sales', money(s.net_sales)],
       ['Cash', money(s.cash)], ['M-Pesa / mobile', money(s.mobile_money)], ['Other payments', money(s.other_payments)], ['Refunds', money(s.refunds)],
       ...(s.gross_profit !== undefined ? [['Gross profit', money(s.gross_profit)] as [string, string]] : [])]
    : [['Supplies', String(s.supplies)], ['Units received', Number(s.units_received).toLocaleString()], ['Purchase value', money(s.purchase_value)], ['Suppliers used', String(s.suppliers_used)]];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-3 space-y-3 max-w-7xl mx-auto">
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
              <input className={`${input} pl-7 w-56`} placeholder={kind === 'sales' ? 'Search receipt, customer, medicine…' : 'Search order, invoice, supplier, medicine…'}
                value={f.q || ''} onChange={set('q')} onKeyDown={(e) => e.key === 'Enter' && apply()} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            {filterBar}
            <button onClick={apply} className="px-3 py-2 rounded-lg bg-teal-700 text-white text-xs font-bold">Apply filters</button>
            <button onClick={() => { setF(kind === 'supplies' ? { status: 'received' } : {}); setApplied(kind === 'supplies' ? { status: 'received' } : {}); setPage(1); }}
              className="px-3 py-2 rounded-lg border border-slate-300 text-xs font-semibold">Clear</button>
            <button onClick={() => void exportCsv()} className="ml-auto flex items-center gap-1 px-3 py-2 rounded-lg border border-slate-300 text-xs font-semibold"><Download className="w-3.5 h-3.5" /> Export CSV</button>
            <button onClick={() => void load()} className="p-2 rounded-lg hover:bg-slate-100" aria-label="Refresh"><RefreshCw className={`w-4 h-4 text-slate-500 ${loading ? 'animate-spin' : ''}`} /></button>
          </div>
        </div>

        {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}

        {s && (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-9 gap-2">
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
                    ? <><td className="pr-3">{x.transactions} sales</td><td className="pr-3">net {money(x.net_sales)}</td><td className="pr-3">refunds {money(x.refunds)}</td>{x.gross_profit !== undefined && <td>profit {money(x.gross_profit)}</td>}</>
                    : <><td className="pr-3">{x.supplies} supplies</td><td className="pr-3">{x.units_received} units</td><td>{money(x.purchase_value)}</td></>}
                </tr>
              ))}
            </tbody></table>
          </div>
        )}

        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500 uppercase text-[10px] tracking-wide">
              {kind === 'sales' ? (
                <tr>{['Date', 'Time', ...(allShops ? ['Shop'] : []), 'Receipt', 'Sale no.', 'Cashier', 'Customer', 'Items', 'Mode', 'Subtotal', 'Discount', 'Total', 'Payment', 'Reference', 'Status',
                  ...(isAdmin ? ['Profit'] : []), 'Device'].map((h) => <th key={h} className="text-left px-2 py-2 whitespace-nowrap">{h}</th>)}</tr>
              ) : (
                <tr>{['Received', ...(allShops ? ['Shop'] : []), 'Order', 'Invoice', 'Supplier', 'Lines', 'Units', 'Purchase cost', 'Payment', 'Status', 'Received by', 'Reference']
                  .map((h) => <th key={h} className="text-left px-2 py-2 whitespace-nowrap">{h}</th>)}</tr>
              )}
            </thead>
            <tbody>
              {(data?.rows || []).map((r: any) => (
                <tr key={`${r.shop_id}-${r.id}`} onClick={() => setDetailId(r.id)} className="border-t border-slate-100 hover:bg-teal-50 cursor-pointer whitespace-nowrap">
                  {kind === 'sales' ? (
                    <>
                      <td className="px-2 py-1.5">{r.date}</td><td className="px-2">{r.time || '—'}</td>{allShops && <td className="px-2 font-semibold">{r.shop_code}</td>}
                      <td className="px-2 font-mono">{r.receipt_number}</td><td className="px-2 font-mono text-slate-500">{r.sale_number}</td>
                      <td className="px-2">{r.cashier_name || '—'}</td><td className="px-2">{r.customer_name || '—'}</td><td className="px-2">{r.item_count} ({r.units})</td>
                      <td className="px-2">{r.price_mode}</td><td className="px-2 text-right">{money(r.subtotal)}</td><td className="px-2 text-right">{money(r.discount_total)}</td>
                      <td className="px-2 text-right font-bold">{money(r.total)}</td><td className="px-2">{r.payment_method}</td><td className="px-2">{r.payment_reference || '—'}</td>
                      <td className="px-2"><StatusTag s={r.status} /></td>{isAdmin && <td className="px-2 text-right">{money(r.gross_profit)}</td>}<td className="px-2 text-slate-500">{r.device_id || '—'}</td>
                    </>
                  ) : (
                    <>
                      <td className="px-2 py-1.5">{r.received_date || r.order_date || '—'}</td>{allShops && <td className="px-2 font-semibold">{r.shop_code}</td>}
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
          {loading && !data && <div className="p-4 text-xs text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}
          {data && data.rows.length === 0 && <div className="p-4 text-xs text-slate-500 text-center">Nothing matches these filters.</div>}
        </div>

        {data && (
          <div className="flex items-center justify-between text-xs">
            <div className="text-slate-600">{data.total.toLocaleString()} records · page {data.page} of {data.pages}</div>
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

      {detailId && kind === 'sales' && (
        <SaleDrawer id={detailId} settings={settings} currentUser={currentUser} online={online} allShops={allShops} money={money} onClose={() => setDetailId(null)} onChanged={() => void load()} />
      )}
      {detailId && kind === 'supplies' && <SupplyDrawer id={detailId} money={money} onClose={() => setDetailId(null)} />}
    </div>
  );
};

const StatusTag: React.FC<{ s: string }> = ({ s }) => {
  const t = String(s || '').toLowerCase();
  const cls = t === 'voided' || t === 'cancelled' ? 'bg-rose-50 text-rose-700' : t.includes('return') || t === 'pending' ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800';
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${cls}`}>{t.replace(/_/g, ' ') || '—'}</span>;
};

const Drawer: React.FC<{ title: string; onClose: () => void; children: React.ReactNode }> = ({ title, onClose, children }) => (
  <div className="fixed inset-0 z-50 bg-slate-900/50 flex justify-end">
    <div className="bg-white w-full max-w-2xl h-full overflow-y-auto p-4 space-y-3">
      <div className="flex items-center justify-between"><h2 className="text-base font-bold text-slate-900">{title}</h2>
        <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100" aria-label="Close"><X className="w-5 h-5 text-slate-500" /></button></div>
      {children}
    </div>
  </div>
);
const KV: React.FC<{ rows: [string, React.ReactNode][] }> = ({ rows }) => (
  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">{rows.map(([k, v]) => <React.Fragment key={k}><div className="text-slate-500">{k}</div><div className="font-semibold text-slate-900 text-right">{v ?? '—'}</div></React.Fragment>)}</div>
);
const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="border border-slate-200 rounded-lg"><div className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-600 bg-slate-50 border-b border-slate-200">{title}</div><div className="p-2 overflow-x-auto">{children}</div></div>
);

const SaleDrawer: React.FC<{ id: string; settings: PharmacySettings; currentUser: User; online: boolean; allShops: boolean; money: (n: any) => string; onClose: () => void; onChanged: () => void }> = ({
  id, settings, currentUser, online, allShops, money, onClose, onChanged,
}) => {
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    apiFetch(`/api/history/sales/${id}`).then(setD).catch((e: any) => setError(e?.message || 'Could not load the sale.'));
  }, [id]);

  const reprint = async () => {
    setBusy(true);
    try {
      const r: any = await apiFetch(`/api/history/sales/${id}/reprint`, { method: 'POST', body: {} });
      const sale = {
        ...r.sale, items: r.items.map((i: any) => ({ ...i, expiry_date: i.expiry_date || '—' })),
        split_payments: r.payments.length > 1 ? r.payments : undefined, cashier_name: r.sale.cashier_name || '',
      } as unknown as Sale;
      printThermalReceipt(sale, settings, { copyLabel: 'REPRINT — COPY' });
      setNotice('Receipt reprinted as a COPY (no new sale was created; the reprint is audited).');
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
        setNotice(`Void sent to the shop (${q.status}). It appears here once the shop applies it.${q.warning ? ` ${q.warning}` : ''}`);
      } else {
        await apiFetch(`/api/sales/${id}/void`, { method: 'POST', body: { reason: reason.trim() } });
        setNotice('Sale voided.');
        onChanged();
        setD(await apiFetch(`/api/history/sales/${id}`));
      }
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : 'Void failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title={d ? `Receipt ${d.sale.receipt_number}` : 'Sale'} onClose={onClose}>
      {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}
      {notice && <div className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded p-2">{notice}</div>}
      {!d && !error && <div className="text-xs text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}
      {d && (
        <>
          <div className="flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => void reprint()} className="flex items-center gap-1 px-3 py-2 rounded-lg border border-slate-300 text-xs font-semibold"><Printer className="w-4 h-4" /> Reprint receipt (copy)</button>
            {currentUser.role === 'ADMIN' && d.sale.status === 'completed' && !allShops && (
              <button disabled={busy} onClick={() => void voidSale()} className="flex items-center gap-1 px-3 py-2 rounded-lg border border-rose-300 text-rose-700 text-xs font-semibold"><Undo2 className="w-4 h-4" /> Void sale</button>
            )}
            <span className="text-[11px] text-slate-500 self-center">No edit: a completed sale is never changed. Returns are requested at the shop and approved under Returns.</span>
          </div>
          <KV rows={[['Shop', d.sale.shop_code ? `${d.sale.shop_code} — ${d.sale.shop_name}` : d.sale.shop_name], ['Sale number', d.sale.sale_number], ['Date / time', `${d.sale.date} ${d.sale.time || ''}`],
            ['Cashier', d.sale.cashier_name], ['Customer', d.sale.customer_name ? `${d.sale.customer_name}${d.sale.customer_phone ? ` (${d.sale.customer_phone})` : ''}` : 'Walk-in'],
            ['Device', d.sale.device_id], ['Price mode', d.sale.price_mode], ['Status', <StatusTag key="s" s={d.sale.status} />]]} />
          <Section title="Items">
            <table className="w-full text-xs"><thead className="text-slate-500"><tr>{['Medicine', 'Batch', 'Qty', 'Unit', 'Mode', 'Disc.', 'Total', ...(d.items[0]?.cost_price_snapshot !== undefined ? ['Cost', 'Profit'] : [])].map((h) => <th key={h} className="text-left pr-2">{h}</th>)}</tr></thead>
              <tbody>{d.items.map((i: any, n: number) => (
                <tr key={n} className="border-t border-slate-100"><td className="pr-2 py-1">{i.medicine_name}</td><td className="pr-2 font-mono">{i.batch_number}</td><td className="pr-2">{i.quantity}</td>
                  <td className="pr-2">{money(i.unit_price)}</td><td className="pr-2">{i.price_mode}</td><td className="pr-2">{money(i.discount)}</td><td className="pr-2 font-semibold">{money(i.total)}</td>
                  {i.cost_price_snapshot !== undefined && <><td className="pr-2">{money(i.cost_price_snapshot)}</td><td>{money(i.profit)}</td></>}</tr>
              ))}</tbody></table>
          </Section>
          <Section title="Payments">
            {d.payments.length === 0 ? <div className="text-xs text-slate-500">{d.sale.payment_method} (no payment lines recorded)</div> :
              d.payments.map((p: any, n: number) => <div key={n} className="flex justify-between text-xs py-0.5"><span>{p.method}{p.reference ? ` · ${p.reference}` : ''}</span><span className="font-semibold">{money(p.amount)}</span></div>)}
          </Section>
          <Section title="Totals">
            <KV rows={[['Subtotal', money(d.sale.subtotal)], ['Discount', money(d.sale.discount_total)], ['Tax', money(d.sale.tax_total)], ['Grand total', money(d.sale.total)],
              ['Amount received', money(d.sale.amount_received)], ['Change', money(d.sale.change_given)], ...(d.sale.gross_profit !== undefined ? [['Gross profit', money(d.sale.gross_profit)] as [string, string]] : [])]} />
          </Section>
          {d.void && <Section title="Void"><div className="text-xs">VOIDED — {d.void.reason || 'no reason recorded'}</div></Section>}
          <Section title={`Returns (${d.returns.length})`}>
            {d.returns.length === 0 ? <div className="text-xs text-slate-500">No returns for this sale.</div> : d.returns.map((r: any) => (
              <div key={r.id} className="text-xs py-1 border-t border-slate-100 first:border-0">
                <b>{r.status}</b> · {r.medicine_name} × {r.quantity}{r.approved_quantity ? ` (approved ${r.approved_quantity})` : ''} · refund {money(r.refund_amount)}
                {r.restocked !== null ? ` · ${r.restocked ? 'restocked' : 'not restocked'}` : ''}{r.reviewed_by ? ` · by ${r.reviewed_by}` : ''}{r.reason ? ` · "${r.reason}"` : ''}
              </div>
            ))}
          </Section>
          <Section title="Audit">
            {d.audit.length === 0 ? <div className="text-xs text-slate-500">No audit entries recorded for this sale.</div> :
              d.audit.map((a: any, n: number) => <div key={n} className="text-xs py-0.5"><b>{a.action}</b> · {a.by || '—'} · {a.at ? new Date(a.at).toLocaleString() : ''}</div>)}
          </Section>
        </>
      )}
    </Drawer>
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
