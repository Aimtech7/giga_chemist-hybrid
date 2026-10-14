import React, { useCallback, useEffect, useState } from 'react';
import { CalendarDays, Loader2, Printer, RefreshCw } from 'lucide-react';
import { apiFetch } from '../../services/http';
import type { PharmacySettings } from '../../types';

/**
 * BUSINESS DAY SUMMARY (Administrator / Manager; shop computer and online). READ ONLY: one card per
 * Kenya business day with sales, payments by method, returns / refunds, expenses, purchases, stock
 * adjustments, physical counts and cashier shift variances. Profit only for Administrators (server).
 */
const nairobiToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const input = 'px-2.5 py-2 border border-slate-300 rounded-lg text-xs bg-white';
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const lines = (d: any): [string, string][] => [
  ['Gross sales', money(d.gross_sales)], ['Net sales', money(d.net_sales)], ['Units sold', String(d.units_sold)], ['Transactions', `${d.transactions}${d.voided_sales ? ` (+${d.voided_sales} voided)` : ''}`],
  ['Cash', money(d.payments.cash)], ['M-Pesa', money(d.payments.mpesa)], ['Card', money(d.payments.card)], ['Bank', money(d.payments.bank)],
  ...(d.payments.other ? [['Other payments', money(d.payments.other)] as [string, string]] : []),
  ['Returns', `${d.returns} (${d.returned_units} units)`], ['Refunds', money(d.refunds)], ['Expenses', `${money(d.expenses)} (${d.expenses_count})`],
  ['Purchases received', `${money(d.purchases)} (${d.purchases_count})`], ['Stock adjustments', `${d.stock_adjustments} (${d.adjustment_units > 0 ? '+' : ''}${d.adjustment_units} units)`],
  ['Physical counts', `${d.physical_counts} (${d.physical_count_units > 0 ? '+' : ''}${d.physical_count_units} units)`],
  ['Shifts closed', `${d.shifts_closed}${d.shifts_short || d.shifts_over ? ` · short ${d.shifts_short} · over ${d.shifts_over}` : ''}`], ['Shift variance', money(d.shift_variance)],
  ...('gross_profit' in d ? [['Cost of goods', money(d.cost_of_goods)], ['Gross profit', money(d.gross_profit)]] as [string, string][] : []),
];

export const BusinessDayView: React.FC<{ settings: PharmacySettings }> = ({ settings }) => {
  const today = nairobiToday();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiFetch(`/api/business-day?from=${from}&to=${to}`));
    } catch (err: any) {
      setError(err?.message || 'Could not load the business day summary.');
    } finally {
      setLoading(false);
    }
  }, [from, to]);
  useEffect(() => { void load(); }, [load]);

  const print = () => {
    if (!data) return;
    const w = window.open('', '_blank', 'width=700,height=800');
    if (!w) return;
    const body = data.days.map((d: any) => `<h3>${esc(d.date)}${d.shop_code ? ` — ${esc(d.shop_code)}` : ''}</h3><table>${lines(d).map(([k, v]) => `<tr><td>${esc(k)}</td><td style="text-align:right">${esc(v)}</td></tr>`).join('')}</table>`).join('');
    w.document.write(`<!doctype html><html><head><title>Business day ${esc(from)}${from !== to ? ` - ${esc(to)}` : ''}</title><style>body{font-family:sans-serif;font-size:12px}table{border-collapse:collapse;width:100%;margin-bottom:12px}td{border-bottom:1px solid #ddd;padding:3px 6px}</style></head><body>
      <h2>${esc(settings.pharmacy_name || 'GIGA CHEMIST')} — Business day summary</h2><p>Read-only summary. Printed ${esc(new Date().toLocaleString())}</p>${body}</body></html>`);
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      <div>
        <h1 className="text-base font-bold text-slate-900 flex items-center gap-1.5"><CalendarDays className="w-4 h-4 text-teal-700" /> Business Day Summary</h1>
        <p className="text-[11px] text-slate-500">Per Kenya business day, read only (no day is locked). Net sales = gross sales minus refunds approved that day.</p>
      </div>
      <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap gap-2 items-center">
        <label className="text-xs text-slate-600 flex items-center gap-1">From <input type="date" className={input} value={from} max={today} onChange={(e) => setFrom(e.target.value || today)} /></label>
        <label className="text-xs text-slate-600 flex items-center gap-1">To <input type="date" className={input} value={to} max={today} onChange={(e) => setTo(e.target.value || today)} /></label>
        <button className="px-2.5 py-2 rounded-lg border border-slate-300 text-xs font-semibold flex items-center gap-1" onClick={() => void load()}>{loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh</button>
        <button className="px-2.5 py-2 rounded-lg border border-slate-300 text-xs font-semibold flex items-center gap-1" disabled={!data} onClick={print}><Printer className="w-3.5 h-3.5" /> Print</button>
      </div>
      {error && <div className="text-xs rounded p-2 border bg-rose-50 border-rose-200 text-rose-800">{error}</div>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {(data?.days || []).map((d: any) => (
          <div key={`${d.shop_id}:${d.date}`} className="bg-white border border-slate-200 rounded-xl p-3">
            <div className="text-sm font-bold text-slate-900">{new Date(`${d.date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}{d.shop_code ? <span className="ml-1 text-[10px] text-slate-500">{d.shop_code}</span> : null}</div>
            <table className="w-full text-xs mt-2"><tbody>{lines(d).map(([k, v]) => <tr key={k} className="border-t border-slate-100"><td className="py-0.5 text-slate-600">{k}</td><td className="py-0.5 text-right font-semibold">{v}</td></tr>)}</tbody></table>
          </div>
        ))}
      </div>
    </div>
  );
};
