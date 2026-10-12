import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Download, Loader2, Printer, RefreshCw, Search, X } from 'lucide-react';
import { apiDownload, apiFetch } from '../../services/http';
import { navigateTo } from '../../services/navigation';
import { canViewTransactionHistory } from '../../services/permissions';
import type { OnlineShop } from '../../services/remoteAdmin';
import type { PharmacySettings, User } from '../../types';
import type { HistoryFilters } from './HistoryView';

/**
 * HISTORY -> STOCK HISTORY (every role; a cashier sees this tab only). READ ONLY.
 * Per business day (Africa/Nairobi): each medicine's opening stock, sold, restocked returns, net sold,
 * received, adjustments and the stock REMAINING at the end of that day. Everything is computed by the
 * server from the stock movement ledger (GET /api/history/stock); the browser only pages and displays.
 * A day the ledger cannot prove shows INCOMPLETE STOCK HISTORY (sales only), never today's stock.
 */
type Preset = 'today' | 'yesterday' | 'week' | 'date' | 'range';

const nairobiToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
function presetRange(p: Preset, today: string): { from: string; to: string } {
  if (p === 'yesterday') return { from: addDays(today, -1), to: addDays(today, -1) };
  if (p === 'week') {
    const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
    return { from: addDays(today, -dow), to: today };
  }
  return { from: today, to: today };
}
const fmtN = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());
const signed = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString());
const input = 'px-2.5 py-2 border border-slate-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-teal-600 outline-none';
const shortDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export const StockHistoryView: React.FC<{ settings: PharmacySettings; currentUser: User; online: boolean; allShops: boolean; shops: OnlineShop[]; initialFilters: HistoryFilters | null }> = ({
  settings, currentUser, allShops, shops, initialFilters,
}) => {
  const today = nairobiToday();
  const startsCustom = Boolean(initialFilters?.from || initialFilters?.to);
  const [preset, setPreset] = useState<Preset>(startsCustom ? (initialFilters?.from === initialFilters?.to ? 'date' : 'range') : 'today');
  const [range, setRange] = useState(startsCustom ? { from: initialFilters?.from || initialFilters?.to || today, to: initialFilters?.to || initialFilters?.from || today } : presetRange('today', today));
  const [q, setQ] = useState(initialFilters?.medicine || '');
  const [qApplied, setQApplied] = useState(initialFilters?.medicine || '');
  const [showAll, setShowAll] = useState(false);
  const [shop, setShop] = useState(initialFilters?.shop_id || '');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(100);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ medicine_id: string; date: string; shop_id: string } | null>(null);
  const isCashier = currentUser.role === 'CASHIER';
  const canLinks = canViewTransactionHistory(currentUser);

  // Search runs on the server over the whole selected period (every medicine, not the visible page).
  useEffect(() => {
    const t = setTimeout(() => { setQApplied(q.trim()); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [q]);

  const params = useMemo(() => {
    const p = new URLSearchParams({ from: range.from, to: range.to });
    if (qApplied) p.set('q', qApplied);
    if (showAll) p.set('activity_only', 'false');
    if (shop) p.set('shop_id', shop);
    return p;
  }, [range, qApplied, showAll, shop]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams(params);
      p.set('page', String(page));
      p.set('page_size', String(size));
      setData(await apiFetch(`/api/history/stock?${p.toString()}`));
    } catch (err: any) {
      setError(err?.message || 'Could not load the stock history.');
    } finally {
      setLoading(false);
    }
  }, [params, page, size]);
  useEffect(() => {
    void load();
  }, [load]);

  const choose = (p: Preset) => {
    setPreset(p);
    if (p === 'today' || p === 'yesterday' || p === 'week') setRange(presetRange(p, today));
    if (p === 'date') setRange((r) => ({ from: r.to, to: r.to }));
    setPage(1);
  };
  const exportCsv = async () => {
    try {
      await apiDownload(`/api/history/export/stock?${params.toString()}`, `giga-daily-stock-history-${range.from}-${range.to}.csv`);
    } catch (err: any) {
      setError(err?.message || 'Export failed.');
    }
  };
  const print = async () => {
    try {
      const rows: any[] = [];
      for (let p = 1; p <= 40; p++) {
        const qp = new URLSearchParams(params);
        qp.set('page', String(p));
        qp.set('page_size', '500');
        const r: any = await apiFetch(`/api/history/stock?${qp.toString()}`);
        rows.push(...r.rows);
        if (p >= r.pages) break;
      }
      printStockHistory(rows, { pharmacy: settings.pharmacy_name || 'GIGA CHEMIST', shop: shopLabel(), from: range.from, to: range.to, multi: allShops && !shop });
    } catch (err: any) {
      setError(err?.message || 'Print failed.');
    }
  };
  const shopLabel = () => {
    if (allShops) return shop ? shops.find((s) => s.shop_id === shop)?.name || shop : 'All shops (each shop separately)';
    return data?.rows?.[0]?.shop_name || settings.pharmacy_name || 'This shop';
  };

  // Rows of this page grouped by business day (newest first), each with its day's cards.
  const groups = useMemo(() => {
    const out: { date: string; heading: string; rows: any[] }[] = [];
    for (const r of data?.rows || []) {
      const last = out[out.length - 1];
      if (last && last.date === r.date) last.rows.push(r);
      else out.push({ date: r.date, heading: r.heading, rows: [r] });
    }
    return out;
  }, [data]);
  const dayInfo = useMemo(() => new Map<string, any>((data?.days || []).map((d: any) => [d.date, d])), [data]);
  const earliest = (data?.ledger || []).map((l: any) => l.exact_from_date).filter(Boolean).sort().pop() as string | undefined;
  const multiShop = allShops && !shop;
  const cols = ['Medicine', ...(multiShop ? ['Shop'] : []), 'Opening', 'Sold', 'Returned', 'Net sold', 'Received', 'Adjustments', 'Remaining', ''];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-3 space-y-3">
        <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-2">
          <div className="flex flex-wrap gap-2 items-center">
            <div className="flex gap-1 bg-slate-100 p-1 rounded-lg">
              {([['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['date', 'Custom date'], ['range', 'Custom range']] as [Preset, string][]).map(([id, label]) => (
                <button key={id} onClick={() => choose(id)} className={`px-2.5 py-1.5 rounded-md text-xs font-semibold ${preset === id ? 'bg-white text-teal-800 shadow-xs' : 'text-slate-600'}`}>{label}</button>
              ))}
            </div>
            {preset === 'date' && (
              <input type="date" className={input} value={range.to} max={today} onChange={(e) => { if (e.target.value) { setRange({ from: e.target.value, to: e.target.value }); setPage(1); } }} aria-label="Date" />
            )}
            {preset === 'range' && (
              <>
                <input type="date" className={input} value={range.from} max={today} onChange={(e) => { if (e.target.value) { setRange({ ...range, from: e.target.value }); setPage(1); } }} aria-label="From" />
                <input type="date" className={input} value={range.to} max={today} onChange={(e) => { if (e.target.value) { setRange({ ...range, to: e.target.value }); setPage(1); } }} aria-label="To" />
              </>
            )}
            {allShops && (
              <select className={input} value={shop} onChange={(e) => { setShop(e.target.value); setPage(1); }} aria-label="Shop">
                <option value="">All shops (separately)</option>{shops.map((x) => <option key={x.shop_id} value={x.shop_id}>{x.shop_code} — {x.name}</option>)}
              </select>
            )}
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
              <input className={`${input} pl-7 pr-7 w-72`} placeholder="Search medicine, generic, brand, barcode, SKU…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search medicines" />
              {q && <button onClick={() => setQ('')} className="absolute right-2 top-2" aria-label="Clear search"><X className="w-4 h-4 text-slate-400" /></button>}
            </div>
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
              <input type="checkbox" checked={showAll} onChange={(e) => { setShowAll(e.target.checked); setPage(1); }} /> Show all medicines
            </label>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={() => void print()} className="flex items-center gap-1 px-3 py-2 rounded-lg border border-slate-300 text-xs font-semibold"><Printer className="w-3.5 h-3.5" /> Print</button>
              {!isCashier && <button onClick={() => void exportCsv()} className="flex items-center gap-1 px-3 py-2 rounded-lg border border-slate-300 text-xs font-semibold"><Download className="w-3.5 h-3.5" /> CSV</button>}
              <button onClick={() => void load()} className="p-2 rounded-lg hover:bg-slate-100" aria-label="Refresh"><RefreshCw className={`w-4 h-4 text-slate-500 ${loading ? 'animate-spin' : ''}`} /></button>
            </div>
          </div>
          <div className="text-[11px] text-slate-500">
            {range.from === range.to ? shortDate(range.from) : `${shortDate(range.from)} – ${shortDate(range.to)}`} · business days in Kenya time · {showAll ? 'all medicines' : 'medicines with activity (sales, returns, receipts, adjustments, counts)'}
            {isCashier && ' · read only'}
          </div>
        </div>

        {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}
        {data && earliest && range.from < earliest && (
          <div className="flex gap-2 text-xs bg-amber-50 border border-amber-300 text-amber-900 rounded-lg p-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <div>{(data.ledger || []).map((l: any) => <div key={l.shop_id}>{multiShop ? <b>{shops.find((s) => s.shop_id === l.shop_id)?.shop_code || ''}: </b> : null}{l.note}</div>)}</div>
          </div>
        )}
        {loading && !data && <div className="p-4 text-xs text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading stock history…</div>}

        {data && groups.length === 0 && (
          <div className="space-y-3">
            {(data.days || []).map((d: any) => <DayHeader key={d.date} day={d} multiShop={multiShop} />)}
            <div className="p-4 text-xs text-slate-500 text-center bg-white rounded-xl border border-slate-200">
              {qApplied ? <>No medicine matches “{qApplied}” in this period. <button onClick={() => setQ('')} className="underline">Clear search</button></> : showAll ? 'No medicines.' : 'No stock activity in this period.'}
              {!showAll && <> <button onClick={() => setShowAll(true)} className="underline ml-1">Show all medicines</button></>}
            </div>
          </div>
        )}

        {groups.map((g) => (
          <div key={g.date} className="space-y-2">
            {dayInfo.get(g.date) && <DayHeader day={dayInfo.get(g.date)} multiShop={multiShop} />}
            <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500 uppercase text-[10px] tracking-wide">
                  <tr>{cols.map((h, i) => <th key={`${h}${i}`} className={`px-2 py-2 whitespace-nowrap ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {g.rows.map((r: any) => {
                    const incomplete = r.status === 'INCOMPLETE';
                    return (
                      <tr key={`${r.shop_id}-${r.medicine_id}-${r.date}`} onClick={() => setOpen({ medicine_id: r.medicine_id, date: r.date, shop_id: r.shop_id })}
                        className="border-t border-slate-100 hover:bg-teal-50 cursor-pointer">
                        <td className="px-2 py-1.5 min-w-[14rem]">
                          <div className="font-semibold text-slate-900">{r.medicine_name}</div>
                          {(r.generic_name && r.generic_name !== r.medicine_name) || r.barcode ? (
                            <div className="text-[10px] text-slate-500">{[r.generic_name && r.generic_name !== r.medicine_name ? r.generic_name : null, r.barcode].filter(Boolean).join(' · ')}</div>
                          ) : null}
                        </td>
                        {multiShop && <td className="px-2 text-right"><span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 font-bold">{r.shop_code}</span></td>}
                        <td className="px-2 text-right">{fmtN(r.opening)}</td>
                        <td className="px-2 text-right font-bold">{fmtN(r.gross_sold)}</td>
                        <td className="px-2 text-right">{fmtN(r.returned)}</td>
                        <td className="px-2 text-right">{fmtN(r.net_sold)}</td>
                        <td className="px-2 text-right">{r.received ? <span className="text-emerald-700 font-semibold">{signed(r.received)}</span> : fmtN(r.received)}</td>
                        <td className="px-2 text-right" title={(r.adjustment_breakdown || []).map((b: any) => `${b.label} ${signed(b.quantity)}`).join('\n')}>
                          {r.adjustments ? <span className={r.adjustments < 0 ? 'text-rose-700 font-semibold' : 'text-sky-800 font-semibold'}>{signed(r.adjustments)}</span> : fmtN(r.adjustments)}
                        </td>
                        <td className="px-2 text-right font-black text-slate-900">{fmtN(r.closing)}</td>
                        <td className="px-2 text-right whitespace-nowrap">
                          {incomplete && <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 text-[9px] font-bold">INCOMPLETE STOCK HISTORY</span>}
                          {r.status === 'MISMATCH' && <span className="px-1.5 py-0.5 rounded bg-rose-100 text-rose-800 text-[9px] font-bold" title="The stored movements do not add up for this day">LEDGER MISMATCH {signed(r.difference)}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        {data && data.total > 0 && (
          <div className="flex items-center justify-between text-xs">
            <div className="text-slate-600">{Number(data.total).toLocaleString()} medicine-day rows · page {data.page} of {data.pages}</div>
            <div className="flex items-center gap-2">
              <select className={input} value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(1); }} aria-label="Rows per page">
                {[50, 100, 250, 500].map((n) => <option key={n} value={n}>{n} / page</option>)}
              </select>
              <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="p-1.5 rounded border border-slate-300 disabled:opacity-40" aria-label="Previous page"><ChevronLeft className="w-4 h-4" /></button>
              <button disabled={page >= data.pages} onClick={() => setPage(page + 1)} className="p-1.5 rounded border border-slate-300 disabled:opacity-40" aria-label="Next page"><ChevronRight className="w-4 h-4" /></button>
            </div>
          </div>
        )}
      </div>
      {open && <StockActivityDrawer {...open} canLinks={canLinks} onClose={() => setOpen(null)} />}
    </div>
  );
};

const DayHeader: React.FC<{ day: any; multiShop: boolean }> = ({ day, multiShop }) => {
  const s = day.summary;
  const cards: [string, string][] = [
    ['Medicines sold', fmtN(s.medicines_sold)], ['Units sold', fmtN(s.units_sold)], ['Units received', fmtN(s.units_received)],
    ['Restocked returns', fmtN(s.units_returned)], ['Adjustments', signed(s.adjustments)],
    [multiShop ? 'Closing units (combined across shops)' : 'Closing units', s.closing_units === null ? 'INCOMPLETE' : fmtN(s.closing_units)],
  ];
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-black tracking-wide text-slate-900">{day.heading}</h2>
        {day.status === 'INCOMPLETE' && <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 text-[10px] font-bold">INCOMPLETE STOCK HISTORY</span>}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2">
        {cards.map(([k, v]) => (
          <div key={k} className="bg-white border border-slate-200 rounded-lg px-2.5 py-2">
            <div className="text-sm font-bold text-slate-900">{v}</div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500">{k}</div>
          </div>
        ))}
      </div>
      {multiShop && day.by_shop?.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-2 text-xs overflow-x-auto">
          <table className="w-full"><tbody>
            {day.by_shop.map((x: any) => (
              <tr key={x.shop_id} className="border-t border-slate-100 first:border-0">
                <td className="py-1 pr-3 font-semibold whitespace-nowrap">{x.shop_code} — {x.shop_name}</td>
                <td className="pr-3">{fmtN(x.units_sold)} sold</td><td className="pr-3">{fmtN(x.units_received)} received</td>
                <td className="pr-3">adjustments {signed(x.adjustments)}</td>
                <td className="pr-3">opening {x.opening_units === null ? 'INCOMPLETE' : fmtN(x.opening_units)}</td>
                <td>remaining <b>{x.closing_units === null ? 'INCOMPLETE' : fmtN(x.closing_units)}</b></td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
      {(day.boundaries || []).map((b: any, i: number) => (
        <div key={i} className="text-[11px] bg-sky-50 border border-sky-200 text-sky-900 rounded p-2">{b.note}</div>
      ))}
    </div>
  );
};

/** One medicine on one day: batches + adjustments + the chronological movement timeline. Read only. */
const StockActivityDrawer: React.FC<{ medicine_id: string; date: string; shop_id: string; canLinks: boolean; onClose: () => void }> = ({ medicine_id, date, shop_id, canLinks, onClose }) => {
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiFetch(`/api/history/stock/${medicine_id}?date=${date}&shop_id=${encodeURIComponent(shop_id)}`).then(setD).catch((e: any) => setError(e?.message || 'Could not load the stock activity.'));
  }, [medicine_id, date, shop_id]);
  const s = d?.summary;
  const go = (tab: 'sales' | 'supplies') => {
    navigateTo('history', tab, { medicine_id, medicine_label: d?.medicine?.name || '', from: date, to: date, shop_id });
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex justify-end" onClick={onClose}>
      <div className="bg-white w-full md:max-w-3xl h-full overflow-y-auto p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between sticky top-0 bg-white pb-1">
          <div>
            <h2 className="text-base font-black tracking-tight text-slate-900 uppercase">Stock activity — {d?.medicine?.name || '…'}</h2>
            <div className="text-xs font-semibold text-slate-600">{d?.heading || date}{d?.shop_code ? ` · ${d.shop_code}` : ''}</div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100" aria-label="Close"><X className="w-5 h-5 text-slate-500" /></button>
        </div>
        {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}
        {!d && !error && <div className="text-xs text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}
        {d && (
          <>
            {s.status === 'INCOMPLETE' && (
              <div className="text-xs bg-amber-50 border border-amber-300 text-amber-900 rounded p-2">
                <b>INCOMPLETE STOCK HISTORY.</b> {d.ledger?.[0]?.note || 'The stock ledger cannot prove this day.'} Only the sales below are exact.
              </div>
            )}
            <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5 text-center">
              {([['Opening', fmtN(s.opening)], ['Sold', fmtN(s.gross_sold)], ['Returned', fmtN(s.returned)], ['Net sold', fmtN(s.net_sold)], ['Received', signed(s.received)],
                ['Adjustments', signed(s.adjustments)], ['Remaining', fmtN(s.closing)], ['Receipts', fmtN(s.receipts)]] as [string, string][]).map(([k, v]) => (
                <div key={k} className="border border-slate-200 rounded-lg py-1.5"><div className="text-sm font-black">{v}</div><div className="text-[9px] uppercase text-slate-500">{k}</div></div>
              ))}
            </div>
            {s.status === 'MISMATCH' && <div className="text-xs bg-rose-50 border border-rose-200 text-rose-800 rounded p-2">The stored movements do not add up for this day (difference {signed(s.difference)}). Nothing has been changed; check the timeline below.</div>}
            {canLinks && (
              <div className="flex flex-wrap gap-2">
                <button onClick={() => go('sales')} disabled={!s.gross_sold && !s.voided_sale_units} className="px-3 py-1.5 rounded-lg border border-teal-300 text-teal-800 text-xs font-semibold disabled:opacity-40">View sales ({s.receipts} receipt{s.receipts === 1 ? '' : 's'})</button>
                <button onClick={() => go('supplies')} disabled={!s.received} className="px-3 py-1.5 rounded-lg border border-teal-300 text-teal-800 text-xs font-semibold disabled:opacity-40">View supplies</button>
              </div>
            )}
            {s.adjustment_breakdown?.length > 0 && (
              <div className="border border-slate-200 rounded-lg">
                <div className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-600 bg-slate-50 border-b border-slate-200">Adjustments {signed(s.adjustments)}</div>
                <div className="p-2 text-xs">{s.adjustment_breakdown.map((b: any) => (
                  <div key={b.key} className="flex justify-between py-0.5"><span>{b.label}{b.movements > 1 ? ` (${b.movements})` : ''}</span><span className="font-semibold">{signed(b.quantity)}</span></div>
                ))}</div>
              </div>
            )}
            <div className="border border-slate-200 rounded-lg overflow-x-auto">
              <div className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-600 bg-slate-50 border-b border-slate-200">Batches ({d.batches.length})</div>
              <table className="w-full text-xs">
                <thead className="text-slate-500"><tr>{['Batch', 'Expiry', 'Opening', 'Sold', 'Returned', 'Received', 'Adjustment', 'Closing'].map((h) => <th key={h} className="text-left px-2 py-1 whitespace-nowrap">{h}</th>)}</tr></thead>
                <tbody>{d.batches.map((b: any) => (
                  <tr key={b.batch_id} className="border-t border-slate-100">
                    <td className="px-2 py-1 font-mono">{b.batch_number}</td><td className="px-2">{b.expiry_date || 'unknown'}</td><td className="px-2">{fmtN(b.opening)}</td>
                    <td className="px-2 font-semibold">{fmtN(b.sold)}</td><td className="px-2">{fmtN(b.returned)}</td><td className="px-2">{signed(b.received)}</td>
                    <td className="px-2">{signed(b.adjustments)}</td><td className="px-2 font-bold">{fmtN(b.closing)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="border border-slate-200 rounded-lg overflow-x-auto">
              <div className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-600 bg-slate-50 border-b border-slate-200">Movement timeline ({d.events.length})</div>
              {d.events.length === 0 ? <div className="p-3 text-xs text-slate-500">No stock movement for this medicine on this day.</div> : (
                <table className="w-full text-xs">
                  <thead className="text-slate-500"><tr>{['Time', 'Event', 'Change', 'Stock', 'Reference', 'User', 'Batch'].map((h) => <th key={h} className="text-left px-2 py-1 whitespace-nowrap">{h}</th>)}</tr></thead>
                  <tbody>{d.events.map((e: any, i: number) => (
                    <tr key={i} className={`border-t border-slate-100 ${e.legacy_import ? 'text-slate-400' : ''}`}>
                      <td className="px-2 py-1 font-mono whitespace-nowrap">{e.time?.slice(0, 5)}</td>
                      <td className="px-2 whitespace-nowrap">{e.label}{e.legacy_import && <span className="ml-1 text-[9px] font-bold">IMPORTED (no balance)</span>}</td>
                      <td className={`px-2 font-bold ${e.change < 0 ? 'text-rose-700' : e.change > 0 ? 'text-emerald-700' : ''}`}>{signed(e.change)}</td>
                      <td className="px-2 whitespace-nowrap">{e.before === null ? '—' : `${e.before} → ${e.after}`}</td>
                      <td className="px-2 font-mono whitespace-nowrap">{e.reference || '—'}</td><td className="px-2">{e.user || '—'}</td><td className="px-2 font-mono">{e.batch_number}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </div>
            <p className="text-[10px] text-slate-400">Read only. Quantities come from the stock movement ledger as stored; nothing here changes stock, sales, returns or purchases.</p>
          </>
        )}
      </div>
    </div>
  );
};

/** Printable DAILY STOCK HISTORY (browser print; "Save as PDF" gives the PDF). */
function printStockHistory(rows: any[], o: { pharmacy: string; shop: string; from: string; to: string; multi: boolean }) {
  const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  const cell = (v: number | null | undefined) => (v === null || v === undefined ? '—' : String(v));
  const byDay = new Map<string, any[]>();
  for (const r of rows) {
    if (!byDay.has(r.date)) byDay.set(r.date, []);
    byDay.get(r.date)!.push(r);
  }
  const head = ['Medicine', ...(o.multi ? ['Shop'] : []), 'Opening', 'Sold', 'Returned', 'Received', 'Adjustments', 'Remaining'];
  const body = [...byDay.entries()].map(([, list]) => `
    <h3>${esc(list[0].heading)}</h3>
    <table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>
    ${list.map((r) => `<tr><td>${esc(r.medicine_name)}${r.status === 'INCOMPLETE' ? ' <i>(incomplete)</i>' : ''}</td>${o.multi ? `<td>${esc(r.shop_code)}</td>` : ''}
      <td>${cell(r.opening)}</td><td>${cell(r.gross_sold)}</td><td>${cell(r.returned)}</td><td>${cell(r.received)}</td><td>${cell(r.adjustments)}</td><td><b>${cell(r.closing)}</b></td></tr>`).join('')}
    </tbody></table>`).join('');
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Daily Stock History</title><style>
    body{font-family:Arial,sans-serif;font-size:11px;margin:16px;color:#111} h1{font-size:16px;margin:0} h2{font-size:13px;margin:2px 0 8px} h3{font-size:12px;margin:14px 0 4px}
    table{border-collapse:collapse;width:100%} th,td{border:1px solid #bbb;padding:3px 5px;text-align:right} th:first-child,td:first-child{text-align:left} th{background:#f1f5f9}
  </style></head><body>
    <h1>${esc(o.pharmacy.toUpperCase().includes('GIGA') ? o.pharmacy : `GIGA CHEMIST — ${o.pharmacy}`)}</h1><h2>DAILY STOCK HISTORY</h2>
    <div>Shop: <b>${esc(o.shop)}</b></div><div>Date: <b>${o.from === o.to ? esc(o.from) : `${esc(o.from)} to ${esc(o.to)}`}</b></div>
    ${body || '<p>No stock activity in this period.</p>'}
    <p style="color:#666;margin-top:12px">Remaining = stock at the end of each business day, from the stock movement ledger. Printed ${esc(new Date().toLocaleString())}.</p>
  </body></html>`);
  w.document.close();
  w.focus();
  w.print();
}
