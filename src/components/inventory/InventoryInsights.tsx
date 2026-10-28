import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Lightbulb, Loader2, RefreshCw, Search, ShoppingCart } from 'lucide-react';
import { apiFetch } from '../../services/http';
import { queueRemoteCommand } from '../../services/remoteAdmin';
import { generateUUID } from '../../utils/uuid';
import type { User } from '../../types';

/**
 * STOCK INSIGHTS (Administrator / Manager; shop server and online app). READ ONLY views computed by the
 * server (GET /api/inventory/insights/*):
 *   Reorder        suggestions from sales velocity, reorder level, lead time and pending drafts
 *                  ("Create purchase draft" is an explicit Administrator action; nothing is received)
 *   Movement       FAST / NORMAL / SLOW / NO SALES 30 / 60 / 90
 *   Expiry risk    per batch: days left vs estimated days to sell
 *   Reconciliation (shop computer) movement ledger vs batch quantities
 * Money columns are sent by the server to Administrators only.
 */
type Tab = 'reorder' | 'movement' | 'expiry' | 'reconciliation' | 'prices';
const input = 'px-2.5 py-2 border border-slate-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-teal-600 outline-none';
const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const n0 = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());
const TONE: Record<string, string> = {
  OUT_OF_STOCK: 'bg-rose-100 text-rose-800', CRITICAL: 'bg-rose-100 text-rose-800', LOW: 'bg-amber-100 text-amber-800', PLAN: 'bg-slate-100 text-slate-700',
  FAST: 'bg-emerald-100 text-emerald-800', NORMAL: 'bg-sky-100 text-sky-800', SLOW: 'bg-amber-100 text-amber-800',
  NO_SALES_30: 'bg-orange-100 text-orange-800', NO_SALES_60: 'bg-rose-100 text-rose-700', NO_SALES_90: 'bg-rose-200 text-rose-900',
  EXPIRED: 'bg-rose-200 text-rose-900', HIGH: 'bg-rose-100 text-rose-800', MEDIUM: 'bg-amber-100 text-amber-800', UNKNOWN: 'bg-slate-100 text-slate-600',
  BALANCED: 'bg-emerald-100 text-emerald-800', SHORT: 'bg-rose-100 text-rose-800', OVER: 'bg-sky-100 text-sky-800', INCOMPLETE_HISTORY: 'bg-slate-200 text-slate-700',
};
const Badge: React.FC<{ v: string }> = ({ v }) => <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold whitespace-nowrap ${TONE[v] || 'bg-slate-100'}`}>{v.replace(/_/g, ' ')}</span>;

export const InventoryInsights: React.FC<{ currentUser: User; online: boolean }> = ({ currentUser, online }) => {
  const [tab, setTab] = useState<Tab>('reorder');
  const [q, setQ] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [filter, setFilter] = useState('');
  const [params, setParams] = useState({ window_days: 30, lead_days: 7, cover_days: 30, fast_per_day: 1, slow_per_day: 0.1 });
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, number>>({});
  const isAdmin = currentUser.role === 'ADMIN';

  useEffect(() => {
    const t = setTimeout(() => setQApplied(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => { setFilter(''); setData(null); }, [tab]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams();
      if (qApplied) p.set('search', qApplied);
      if (tab === 'reorder') ['window_days', 'lead_days', 'cover_days'].forEach((k) => p.set(k, String((params as any)[k])));
      if (tab === 'movement') { p.set('fast_per_day', String(params.fast_per_day)); p.set('slow_per_day', String(params.slow_per_day)); if (filter) p.set('class', filter); }
      if (tab === 'expiry' && filter) p.set('risk', filter);
      if (tab === 'reconciliation' && filter) p.set('status', filter);
      if (tab === 'prices') {
        const all: any = await apiFetch(`/api/price-history?limit=1000`);
        const s = qApplied.toLowerCase();
        const rows = all.rows.filter((r: any) => !s || String(r.medicine_name || '').toLowerCase().includes(s));
        setData({ items: rows, total: rows.length, rule: 'Every price change, recorded by the database (immutable). Historical sales keep the price they were sold at.' });
        return;
      }
      const path = tab === 'expiry' ? 'expiry-risk' : tab;
      setData(await apiFetch(`/api/inventory/insights/${path}?${p.toString()}`));
    } catch (err: any) {
      setError(err?.message || 'Could not load the insight.');
    } finally {
      setLoading(false);
    }
  }, [tab, qApplied, params, filter]);
  useEffect(() => { void load(); }, [load]);

  const tabs: [Tab, string][] = [['reorder', 'Reorder suggestions'], ['movement', 'Fast / slow / dead'], ['expiry', 'Expiry risk'], ...(online ? [] : [['reconciliation', 'Stock reconciliation'], ['prices', 'Price history']] as [Tab, string][])];
  const summaryKeys = useMemo(() => Object.keys(data?.summary || {}), [data]);

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      <div>
        <h1 className="text-base font-bold text-slate-900 flex items-center gap-1.5"><Lightbulb className="w-4 h-4 text-teal-700" /> Stock Insights</h1>
        <p className="text-[11px] text-slate-500">Recommendations and checks computed from the stock ledger and sales. Read only: nothing here orders, receives or adjusts stock.</p>
      </div>
      <div className="flex flex-wrap gap-1 bg-slate-100 p-1 rounded-lg w-fit">
        {tabs.map(([id, label]) => <button key={id} onClick={() => setTab(id)} className={`px-3 py-1.5 rounded-md text-xs font-semibold ${tab === id ? 'bg-white text-teal-800 shadow-xs' : 'text-slate-600'}`}>{label}</button>)}
      </div>
      <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[180px]"><Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" /><input className={`${input} w-full pl-8`} placeholder="Search medicine, generic or barcode" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {tab === 'reorder' && (['window_days', 'lead_days', 'cover_days'] as const).map((k) => (
          <label key={k} className="text-[11px] text-slate-600 flex items-center gap-1">{k === 'window_days' ? 'Sales window' : k === 'lead_days' ? 'Lead time' : 'Cover'} (days)
            <input className={`${input} w-16`} type="number" min={0} value={params[k]} onChange={(e) => setParams({ ...params, [k]: Number(e.target.value) })} /></label>
        ))}
        {tab === 'movement' && (['fast_per_day', 'slow_per_day'] as const).map((k) => (
          <label key={k} className="text-[11px] text-slate-600 flex items-center gap-1">{k === 'fast_per_day' ? 'Fast ≥' : 'Slow <'} units/day
            <input className={`${input} w-16`} type="number" step="0.1" min={0} value={params[k]} onChange={(e) => setParams({ ...params, [k]: Number(e.target.value) })} /></label>
        ))}
        {tab !== 'reorder' && summaryKeys.length > 0 && (
          <select className={input} value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All</option>{summaryKeys.map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
          </select>
        )}
        <button className="px-2.5 py-2 rounded-lg border border-slate-300 text-xs font-semibold flex items-center gap-1" onClick={() => void load()}>{loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh</button>
      </div>
      {error && <div className="text-xs rounded p-2 border bg-rose-50 border-rose-200 text-rose-800">{error}</div>}
      {data?.summary && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {summaryKeys.map((k) => {
            const v = data.summary[k];
            return (
              <button key={k} onClick={() => setFilter(filter === k ? '' : k)} className={`text-left bg-white border rounded-lg p-2 ${filter === k ? 'border-teal-600' : 'border-slate-200'}`}>
                <Badge v={k} />
                <div className="text-sm font-bold mt-1">{typeof v === 'number' ? n0(v) : n0(v.medicines ?? v.batches)}</div>
                {typeof v === 'object' && <div className="text-[10px] text-slate-500">{n0(v.units)} units{v.value !== undefined ? ` · ${money(v.value)}` : v.purchase_value !== undefined ? ` · cost ${money(v.purchase_value)}` : v.retail_value !== undefined ? ` · retail ${money(v.retail_value)}` : ''}</div>}
              </button>
            );
          })}
        </div>
      )}
      {data?.rule && <p className="text-[11px] text-slate-500">{data.rule}</p>}
      {tab === 'reorder' && data && <ReorderTable data={data} isAdmin={isAdmin} online={online} picked={picked} setPicked={setPicked} />}
      {tab === 'movement' && data && (
        <Table cols={['Medicine', 'Class', 'Stock', 'Sold 30d', 'Sold 90d', 'Units/day', 'Last sale', 'Days since', ...(isAdmin ? ['Stock value'] : [])]}
          rows={data.items.map((r: any) => [<Name r={r} />, <Badge v={r.class} />, n0(r.current_quantity), n0(r.sold_30), n0(r.sold_90), r.velocity_per_day, r.last_sale || '—', r.days_since_sale ?? '—', ...(isAdmin ? [money(r.stock_value)] : [])])} />
      )}
      {tab === 'expiry' && data && (
        <Table cols={['Medicine', 'Batch', 'Qty', 'Expiry', 'Days left', 'Units/day', 'Days to sell', 'Risk', 'Retail value', ...(isAdmin ? ['Purchase value'] : [])]}
          rows={data.items.map((r: any) => [<Name r={r} />, r.batch_number, n0(r.quantity), r.expiry_date || 'unknown', r.days_remaining ?? '—', r.avg_daily_sales, r.estimated_days_to_sell ?? 'no sales', <Badge v={r.risk} />, money(r.retail_value), ...(isAdmin ? [money(r.purchase_value)] : [])])} />
      )}
      {tab === 'reconciliation' && data && (
        <Table cols={['Medicine', 'Expected (ledger)', 'Actual', 'Variance', ...(isAdmin ? ['Variance cost'] : []), 'Last count', 'Last movement', 'Status']}
          rows={data.items.map((r: any) => [<Name r={r} />, n0(r.expected), n0(r.actual), r.variance > 0 ? `+${r.variance}` : r.variance, ...(isAdmin ? [money(r.variance_cost)] : []),
            r.last_count ? new Date(r.last_count).toLocaleDateString() : '—', r.last_movement ? new Date(r.last_movement).toLocaleString() : '—', <Badge v={r.status} />])} />
      )}
      {tab === 'prices' && data && (
        <Table cols={['When', 'Medicine', 'Batch', 'Field', 'Old', 'New', 'By', 'Source', 'Reason / reference']}
          rows={data.items.map((r: any) => [new Date(r.changed_at).toLocaleString(), r.medicine_name, r.batch_number || '—', String(r.field).replace(/_/g, ' '), money(r.old_value), money(r.new_value),
            r.changed_by_name || '—', <Badge v={r.source} />, [r.reason, r.reference].filter(Boolean).join(' · ') || '—'])} />
      )}
      {data && data.total > (data.items?.length || 0) && <p className="text-[11px] text-slate-500">Showing the first {data.items.length} of {data.total}. Use search or a filter to narrow.</p>}
    </div>
  );
};

const Name: React.FC<{ r: any }> = ({ r }) => <div><div className="font-semibold text-slate-900">{r.name}{r.shop_code ? <span className="ml-1 text-[10px] text-slate-500">{r.shop_code}</span> : null}</div>{r.generic_name && <div className="text-[10px] text-slate-500">{r.generic_name}</div>}</div>;

const Table: React.FC<{ cols: string[]; rows: React.ReactNode[][] }> = ({ cols, rows }) => (
  <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
    <table className="w-full text-xs">
      <thead className="bg-slate-50 text-slate-600"><tr>{cols.map((c) => <th key={c} className="px-2 py-2 text-left font-semibold whitespace-nowrap">{c}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, i) => <tr key={i} className="border-t border-slate-100">{r.map((c, j) => <td key={j} className="px-2 py-1.5">{c}</td>)}</tr>)}
        {!rows.length && <tr><td colSpan={cols.length} className="px-2 py-6 text-center text-slate-500">Nothing to show.</td></tr>}
      </tbody>
    </table>
  </div>
);

const ReorderTable: React.FC<{ data: any; isAdmin: boolean; online: boolean; picked: Record<string, number>; setPicked: (p: Record<string, number>) => void }> = ({ data, isAdmin, online, picked, setPicked }) => {
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [supplier, setSupplier] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!isAdmin) return;
    void apiFetch<any>('/api/suppliers').then((s) => setSuppliers((Array.isArray(s) ? s : s?.suppliers || []).filter((x: any) => x.status !== 'inactive'))).catch(() => {});
  }, [isAdmin]);
  const chosen = data.items.filter((r: any) => picked[r.medicine_id] > 0);
  const create = async () => {
    if (!window.confirm(`Create a PENDING purchase draft with ${chosen.length} line(s)? Nothing enters stock until the order is received. Set the real batch numbers and expiry dates when receiving.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }).replace(/-/g, '');
      const items = chosen.map((r: any) => ({ medicine_id: r.medicine_id, quantity: picked[r.medicine_id], purchase_price: r.unit_cost ?? 0, batch_number: `REORDER-${day}` }));
      const notes = 'Created from reorder suggestions (update batch numbers / expiry before receiving).';
      if (online) {
        const r: any = await queueRemoteCommand('purchase-create', { purchase_id: generateUUID(), supplier_id: supplier, items, notes });
        setMsg({ ok: true, text: `Purchase draft queued for the shop computer (${r.status}).` });
      } else {
        const r: any = await apiFetch('/api/purchases/drafts', { body: { supplier_id: supplier, items, notes } });
        setMsg({ ok: true, text: `Purchase draft ${r.purchase?.order_number || ''} created (PENDING). See Purchases.` });
      }
      setPicked({});
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Could not create the draft.' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      {isAdmin && (
        <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap gap-2 items-center">
          <span className="text-xs font-semibold text-slate-700">{chosen.length} selected</span>
          <select className={input} value={supplier} onChange={(e) => setSupplier(e.target.value)}><option value="">Supplier…</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <button className="px-3 py-2 rounded-lg bg-teal-700 text-white text-xs font-semibold flex items-center gap-1 disabled:opacity-50" disabled={busy || !chosen.length || !supplier} onClick={() => void create()}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShoppingCart className="w-3.5 h-3.5" />} Create purchase draft
          </button>
          {msg && <span className={`text-xs ${msg.ok ? 'text-emerald-700' : 'text-rose-700'}`}>{msg.text}</span>}
        </div>
      )}
      <Table cols={[...(isAdmin ? ['Order'] : []), 'Medicine', 'Urgency', 'Stock', 'Reorder level', 'Sold (window)', 'Units/day', 'Days of cover', 'On order', 'Suggested', ...(isAdmin ? ['Est. cost'] : [])]}
        rows={data.items.map((r: any) => [
          ...(isAdmin ? [<input type="number" min={0} className={`${input} w-20`} value={picked[r.medicine_id] ?? ''} placeholder={String(r.suggested_quantity)}
            onChange={(e) => setPicked({ ...picked, [r.medicine_id]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} aria-label={`Order quantity for ${r.name}`} />] : []),
          <Name r={r} />, <Badge v={r.urgency} />, n0(r.current_stock), n0(r.reorder_level), n0(r.sold_in_window), r.avg_daily_sales, r.days_of_cover ?? '—', n0(r.on_order),
          <b>{n0(r.suggested_quantity)}</b>, ...(isAdmin ? [money(r.estimated_cost)] : []),
        ])} />
    </div>
  );
};
