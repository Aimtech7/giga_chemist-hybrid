import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Search, X } from 'lucide-react';
import { apiFetch } from '../../services/http';
import { normalize, tokens } from '../../services/medicineSearch';
import { VirtualRows } from '../common/VirtualRows';

/**
 * ALL SHOPS (Global Administrator): stock of each medicine in EACH shop, side by side. Read only.
 * Medicines are matched across shops by barcode (else exact name); stock is never merged into one
 * ambiguous number — the Combined column is separate and labelled. Changes are made per shop.
 */
interface Row { key: string; name: string; barcode: string | null; category: string | null; combined: number; per_shop: Record<string, { stock: number; reorder_level: number; status: string; name: string }> }

export const StockComparison: React.FC = () => {
  const [data, setData] = useState<{ shops: { shop_id: string; shop_code: string | null; name: string | null }[]; rows: Row[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [onlyGaps, setOnlyGaps] = useState(false);
  useEffect(() => {
    apiFetch<any>('/api/admin/stock-comparison').then(setData).catch((e) => setError(e?.message || 'Could not load the comparison.'));
  }, []);
  const indexed = useMemo(() => (data?.rows || []).map((r) => ({ r, hay: normalize([r.name, r.barcode, r.category, ...Object.values(r.per_shop).map((x) => x.name)].join(' ')) })), [data]);
  const shown = useMemo(() => {
    const ts = tokens(q);
    return indexed.filter(({ r, hay }) => ts.every((t) => hay.includes(t))
      && (!onlyGaps || (data?.shops || []).some((s) => (r.per_shop[s.shop_id]?.stock ?? 0) <= 0))).map((x) => x.r);
  }, [indexed, q, onlyGaps, data]);
  const shops = data?.shops || [];
  const cols = `minmax(240px,2fr) 150px ${shops.map(() => '120px').join(' ')} 130px`;
  const cell = (r: Row, shopId: string) => {
    const v = r.per_shop[shopId];
    if (!v) return <span className="text-slate-400 text-[11px]">not stocked</span>;
    const tone = v.stock <= 0 ? 'text-rose-700' : v.stock <= v.reorder_level ? 'text-amber-700' : 'text-slate-900';
    return <span className={`font-black ${tone}`}>{v.stock}{v.status !== 'active' && <span className="ml-1 text-[9px] font-bold text-slate-500">INACTIVE</span>}</span>;
  };
  return (
    <div className="flex-1 overflow-y-auto bg-slate-50 p-3 space-y-2">
      <div>
        <h1 className="text-base font-black text-slate-900">ALL SHOPS — STOCK COMPARISON</h1>
        <p className="text-[11px] text-slate-500">Each shop's own stock side by side (cloud copy, read only). Matched by barcode, else exact name. Open one shop to change its stock.</p>
      </div>
      {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}
      {!data && !error && <div className="text-xs text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading every shop's catalogue…</div>}
      {data && (
        <>
          <div className="flex flex-wrap gap-2 items-center bg-white border border-slate-200 rounded-xl p-2">
            <div className="relative flex-1 min-w-[16rem]">
              <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search medicine, barcode, category…" className="w-full pl-9 pr-8 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-teal-600" />
              {q && <button onClick={() => setQ('')} className="absolute right-2 top-2" aria-label="Clear search"><X className="w-4 h-4 text-slate-400" /></button>}
            </div>
            <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={onlyGaps} onChange={(e) => setOnlyGaps(e.target.checked)} /> Out of stock in at least one shop</label>
            <span className="text-xs text-slate-600">Showing <b>{shown.length.toLocaleString()}</b> of <b>{data.rows.length.toLocaleString()}</b> medicines</span>
          </div>
          {shown.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-6 text-sm text-center">No medicine matches “{q.trim()}”. <button onClick={() => setQ('')} className="ml-2 underline">Clear search</button></div>
          ) : (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <VirtualRows items={shown} rowHeight={40} height="calc(100vh - 260px)" minWidth={420 + shops.length * 120 + 130}
                header={(
                  <div className="grid gap-x-2 px-3 py-2 bg-slate-50 border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-500 font-bold" style={{ gridTemplateColumns: cols }}>
                    <div>Medicine</div><div>Barcode</div>{shops.map((s) => <div key={s.shop_id}>{s.shop_code} stock</div>)}<div>Combined (all shops)</div>
                  </div>
                )}
                render={(r) => (
                  <div className="grid items-center gap-x-2 px-3 h-full border-b border-slate-100 text-xs" style={{ gridTemplateColumns: cols }}>
                    <div className="truncate font-semibold" title={r.name}>{r.name}<span className="ml-1 text-[10px] text-slate-500 font-normal">{r.category || ''}</span></div>
                    <div className="font-mono text-[11px] truncate">{r.barcode || '—'}</div>
                    {shops.map((s) => <div key={s.shop_id}>{cell(r, s.shop_id)}</div>)}
                    <div className="text-slate-500">{r.combined}</div>
                  </div>
                )} />
            </div>
          )}
        </>
      )}
    </div>
  );
};
