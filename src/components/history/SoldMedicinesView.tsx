import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Printer, RefreshCw, Search } from 'lucide-react';
import { apiFetch } from '../../services/http';
import { canViewTransactionHistory } from '../../services/permissions';
import type { OnlineShop } from '../../services/remoteAdmin';
import type { PharmacySettings, User } from '../../types';

/**
 * HISTORY -> SOLD MEDICINES ("Today's Sold Medicines" from the POS). READ ONLY.
 * Per medicine for one business day (Africa/Nairobi): retail / wholesale units, gross sold, units
 * returned from that day's sales, net sold, current stock and the number of sales. Voided sales are
 * excluded. Computed by the server (GET /api/history/sold). A cashier sees today and quantities only;
 * Administrators / Managers can pick another day; money columns are sent to Administrators only.
 */
const nairobiToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
const fmtN = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());
const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const input = 'px-2.5 py-2 border border-slate-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-teal-600 outline-none';
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export const SoldMedicinesView: React.FC<{ settings: PharmacySettings; currentUser: User; allShops: boolean; shops: OnlineShop[] }> = ({
  settings, currentUser, allShops, shops,
}) => {
  const today = nairobiToday();
  const canPickDate = canViewTransactionHistory(currentUser);
  const [date, setDate] = useState(today);
  const [q, setQ] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [shop, setShop] = useState('');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQApplied(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams();
      if (canPickDate && date !== today) p.set('date', date);
      if (qApplied) p.set('search', qApplied);
      if (shop) p.set('shop_id', shop);
      setData(await apiFetch(`/api/history/sold?${p.toString()}`));
    } catch (err: any) {
      setError(err?.message || 'Could not load the sold medicines.');
    } finally {
      setLoading(false);
    }
  }, [canPickDate, date, today, qApplied, shop]);
  useEffect(() => {
    void load();
  }, [load]);

  const showMoney = Boolean(data?.totals && 'revenue' in data.totals);
  const multiShop = allShops && !shop;
  const t = data?.totals;
  const cards: [string, string][] = t ? [
    ['Medicines', fmtN(t.medicines)], ['Sales', fmtN(t.transactions)], ['Gross sold', fmtN(t.gross_sold)], ['Returned', fmtN(t.returned)], ['Net sold', fmtN(t.net_sold)],
    ...(showMoney ? [['Revenue', money(t.revenue)], ['Gross profit', money(t.gross_profit)]] as [string, string][] : []),
  ] : [];
  const cols = useMemo(() => ['Medicine', ...(multiShop ? ['Shop'] : []), 'Retail qty', 'Wholesale qty', 'Gross sold', 'Returned', 'Net sold', 'Current stock', 'Sales',
    ...(showMoney ? ['Revenue', 'Cost', 'Profit'] : [])], [multiShop, showMoney]);

  const print = () => {
    if (!data) return;
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) return;
    const head = cols.map((c) => `<th>${esc(c)}</th>`).join('');
    const body = data.items.map((r: any) => `<tr><td>${esc(r.name)}</td>${multiShop ? `<td>${esc(r.shop_code)}</td>` : ''}<td>${r.retail_qty}</td><td>${r.wholesale_qty}</td><td>${r.gross_sold}</td><td>${r.returned}</td><td>${r.net_sold}</td><td>${r.current_stock}</td><td>${r.transactions}</td>${showMoney ? `<td>${money(r.revenue)}</td><td>${money(r.cost)}</td><td>${money(r.gross_profit)}</td>` : ''}</tr>`).join('');
    w.document.write(`<!doctype html><html><head><title>Sold medicines ${esc(data.date)}</title><style>body{font-family:sans-serif;font-size:12px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:3px 6px;text-align:right}td:first-child,th:first-child{text-align:left}</style></head><body>
      <h2>${esc(settings.pharmacy_name || 'GIGA CHEMIST')} — Sold medicines ${esc(data.date)}</h2>
      <p>${cards.map(([k, v]) => `${esc(k)}: <b>${esc(v)}</b>`).join(' · ')}</p>
      <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table><p>Printed ${esc(new Date().toLocaleString())}</p></body></html>`);
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-3 space-y-3">
        <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap gap-2 items-center">
          {canPickDate ? (
            <input type="date" className={input} value={date} max={today} onChange={(e) => setDate(e.target.value || today)} aria-label="Business date" />
          ) : (
            <span className="text-xs font-semibold text-slate-700">Today ({today})</span>
          )}
          <div className="relative flex-1 min-w-[180px]">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
            <input className={`${input} w-full pl-8`} placeholder="Search medicine, generic or barcode" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {allShops && (
            <select className={input} value={shop} onChange={(e) => setShop(e.target.value)} aria-label="Shop">
              <option value="">All shops</option>
              {shops.map((s) => <option key={s.shop_id} value={s.shop_id}>{s.name}</option>)}
            </select>
          )}
          <button onClick={() => void load()} className="px-2.5 py-2 rounded-lg border border-slate-300 text-xs font-semibold flex items-center gap-1">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh
          </button>
          <button onClick={print} disabled={!data?.items?.length} className="px-2.5 py-2 rounded-lg border border-slate-300 text-xs font-semibold flex items-center gap-1 disabled:opacity-50">
            <Printer className="w-3.5 h-3.5" /> Print
          </button>
        </div>
        {error && <div className="text-xs rounded p-2 border bg-rose-50 border-rose-200 text-rose-800">{error}</div>}
        {cards.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
            {cards.map(([k, v]) => (
              <div key={k} className="bg-white border border-slate-200 rounded-lg p-2"><div className="text-[10px] uppercase text-slate-500 font-semibold">{k}</div><div className="text-sm font-bold text-slate-900">{v}</div></div>
            ))}
          </div>
        )}
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-600">
              <tr>{cols.map((c, i) => <th key={c} className={`px-2 py-2 font-semibold ${i === 0 ? 'text-left' : 'text-right'}`}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {(data?.items || []).map((r: any) => (
                <tr key={`${r.shop_id}:${r.medicine_id}`} className="border-t border-slate-100">
                  <td className="px-2 py-1.5"><div className="font-semibold text-slate-900">{r.name}</div>{r.generic_name && <div className="text-[10px] text-slate-500">{r.generic_name}</div>}</td>
                  {multiShop && <td className="px-2 py-1.5 text-right">{r.shop_code}</td>}
                  <td className="px-2 py-1.5 text-right">{fmtN(r.retail_qty)}</td>
                  <td className="px-2 py-1.5 text-right">{fmtN(r.wholesale_qty)}</td>
                  <td className="px-2 py-1.5 text-right font-semibold">{fmtN(r.gross_sold)}</td>
                  <td className="px-2 py-1.5 text-right">{r.returned ? fmtN(r.returned) : '—'}</td>
                  <td className="px-2 py-1.5 text-right font-semibold">{fmtN(r.net_sold)}</td>
                  <td className={`px-2 py-1.5 text-right ${r.current_stock <= 0 ? 'text-rose-700 font-semibold' : ''}`}>{fmtN(r.current_stock)}</td>
                  <td className="px-2 py-1.5 text-right">{fmtN(r.transactions)}</td>
                  {showMoney && <><td className="px-2 py-1.5 text-right">{money(r.revenue)}</td><td className="px-2 py-1.5 text-right">{money(r.cost)}</td><td className="px-2 py-1.5 text-right">{money(r.gross_profit)}</td></>}
                </tr>
              ))}
              {data && !data.items.length && <tr><td colSpan={cols.length} className="px-2 py-6 text-center text-slate-500">No medicines sold on {data.date}{qApplied ? ` matching "${qApplied}"` : ''}.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-500">Voided sales are not counted. "Returned" = units of this day's sales returned and approved. Current stock is live (not end of day: see Stock History).</p>
      </div>
    </div>
  );
};
