import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ClipboardCheck, Eye, Layers, MinusCircle, PackagePlus, Pencil, Plus, Power, Search, Tag, Trash2, X } from 'lucide-react';
import { VirtualRows } from '../common/VirtualRows';
import { buildCatalogue, queryCatalogue, summarize, type CatalogueRow, type ExpiryFilter, type SortKey, type StockState } from '../../services/medicineSearch';
import type { Medicine, MedicineBatch } from '../../types';

/**
 * Online Medicines / Inventory: the WHOLE catalogue of the selected shop in one full-width table.
 * Search, filters and sorting run over all loaded medicines (never just the rendered rows); only the rows
 * in view are mounted (windowing), so 2,000+ medicines scroll smoothly with no "Show more".
 * The catalogue is the shop's cloud copy: browsing and searching work while the shop PC is offline.
 */
export type RowAction = 'view' | 'details' | 'price' | 'add' | 'remove' | 'count' | 'batch-new' | 'active' | 'delete';

const STOCK_BADGE: Record<StockState, { label: string; cls: string }> = {
  in: { label: 'IN STOCK', cls: 'text-emerald-800 bg-emerald-50 border-emerald-200' },
  low: { label: 'LOW STOCK', cls: 'text-amber-800 bg-amber-50 border-amber-300' },
  out: { label: 'OUT OF STOCK', cls: 'text-rose-800 bg-rose-50 border-rose-200' },
};
const COLS = 'minmax(220px,2.2fr) 120px 140px 130px 70px 92px 92px 92px 132px 64px 80px 56px 100px 220px';
const HEADERS: [string, SortKey | null][] = [
  ['Medicine', 'name'], ['SKU', null], ['Barcode', null], ['Category', null], ['Unit', null], ['Retail', 'retail'], ['Wholesale', 'wholesale'], ['Purchase', null],
  ['Current stock', 'stock'], ['Reorder', null], ['Status', 'status'], ['Batches', null], ['Nearest exp.', 'expiry'], ['Actions', null],
];
const sel = 'px-2.5 py-2 border border-slate-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-teal-600 outline-none';

export const MedicinesTable: React.FC<{
  medicines: Medicine[];
  batches: MedicineBatch[];
  currency: string;
  showCost: boolean;
  loading: boolean;
  pendingFor: (medicineId: string) => number;
  onAction: (medicineId: string, action: RowAction) => void;
  onCreate: () => void;
  initialStock?: 'all' | StockState;
  initialExpiry?: ExpiryFilter;
}> = ({ medicines, batches, currency, showCost, loading, pendingFor, onAction, onCreate, initialStock, initialExpiry }) => {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [stock, setStock] = useState<'all' | StockState>(initialStock || 'all');
  const [expiry, setExpiry] = useState<ExpiryFilter>(initialExpiry || 'all');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });

  // Index built once per catalogue load; each keystroke only filters / ranks precomputed text.
  const all = useMemo(() => buildCatalogue(medicines, batches), [medicines, batches]);
  const summary = useMemo(() => summarize(all), [all]);
  const categories = useMemo(() => [...new Set(all.map((r) => r.m.category).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [all]);
  const result = useMemo(() => queryCatalogue(all, { query, status, stock, expiry, category: category || undefined }, sort), [all, query, status, stock, expiry, category, sort]);
  const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const filtered = status !== 'all' || stock !== 'all' || expiry !== 'all' || !!category;
  const sortBy = (key: SortKey) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));

  const card = (k: string, v: number | string, tone?: string, onClick?: () => void) => (
    <button onClick={onClick} className={`text-left bg-white border rounded-lg px-3 py-2 ${onClick ? 'hover:border-teal-600' : 'cursor-default'} ${tone || 'border-slate-200'}`}>
      <div className="text-lg font-black text-slate-900 leading-tight">{typeof v === 'number' ? v.toLocaleString() : v}</div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{k}</div>
    </button>
  );

  const actionBtn = (id: string, a: RowAction, title: string, Icon: any) => (
    <button
      key={a}
      title={title}
      aria-label={title}
      onClick={(e) => { e.stopPropagation(); onAction(id, a); }}
      className={`p-1.5 rounded-md border transition ${
        a === 'delete'
          ? 'border-rose-200 hover:border-rose-500 hover:bg-rose-50 text-slate-500 hover:text-rose-700'
          : 'border-slate-200 hover:border-teal-600 hover:bg-teal-50 text-slate-600 hover:text-teal-800'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  );

  const row = (r: CatalogueRow) => {
    const m = r.m;
    const pend = pendingFor(m.id);
    return (
      <div onClick={() => onAction(m.id, 'view')} className="grid items-center gap-x-2 px-3 h-full border-b border-slate-100 hover:bg-teal-50/60 cursor-pointer text-xs" style={{ gridTemplateColumns: COLS }}>
        <div className="min-w-0">
          <div className="font-semibold text-slate-900 truncate" title={m.name}>{m.name}{pend > 0 && <span className="ml-1 text-[10px] font-bold text-amber-700">· {pend} pending</span>}</div>
          <div className="text-[10px] text-slate-500 truncate">{[m.generic_name && m.generic_name !== m.name ? m.generic_name : null, m.brand_name, m.dosage_strength, m.dosage_form].filter(Boolean).join(' · ') || '—'}</div>
        </div>
        <div className="font-mono text-[11px] truncate" title={m.sku}>{m.sku || '—'}</div>
        <div className="font-mono text-[11px] truncate" title={m.barcode}>{m.barcode || '—'}</div>
        <div className="truncate" title={m.category}>{m.category || '—'}</div>
        <div className="truncate">{m.unit || '—'}</div>
        <div className="text-right font-semibold">{money(m.selling_price)}</div>
        <div className="text-right">{money(m.wholesale_price)}</div>
        <div className="text-right text-slate-600">{showCost ? money(m.purchase_price) : '—'}</div>
        <div className="flex items-center gap-1.5">
          <span className={`text-base font-black w-12 text-right ${r.state === 'out' ? 'text-rose-700' : r.state === 'low' ? 'text-amber-700' : 'text-slate-900'}`}>{m.current_stock}</span>
          <span className={`px-1 py-0.5 rounded border text-[9px] font-bold whitespace-nowrap ${STOCK_BADGE[r.state].cls}`}>{STOCK_BADGE[r.state].label}</span>
        </div>
        <div className="text-center">{m.reorder_level}</div>
        <div><span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${m.status === 'active' ? 'bg-slate-100 text-slate-700' : 'bg-slate-300 text-slate-700'}`}>{m.status === 'active' ? 'ACTIVE' : 'INACTIVE'}</span></div>
        <div className="text-center">{r.batchCount}</div>
        <div className={r.expired ? 'text-rose-700 font-bold' : r.expiringSoon ? 'text-amber-700 font-semibold' : ''}>{r.nearestExpiry || 'unknown'}</div>
        <div className="flex gap-1">
          {actionBtn(m.id, 'view', 'View & batches', Eye)}
          {actionBtn(m.id, 'details', 'Edit details', Pencil)}
          {actionBtn(m.id, 'price', 'Edit price', Tag)}
          {actionBtn(m.id, 'add', 'Add stock', PackagePlus)}
          {actionBtn(m.id, 'remove', 'Remove stock', MinusCircle)}
          {actionBtn(m.id, 'count', 'Physical count', ClipboardCheck)}
          {actionBtn(m.id, 'batch-new', 'Manage batches (new batch)', Layers)}
          {actionBtn(m.id, 'active', m.status === 'active' ? 'Deactivate' : 'Activate', Power)}
          {actionBtn(m.id, 'delete', 'Delete medicine', Trash2)}
        </div>
      </div>
    );
  };

  const mobileRow = (r: CatalogueRow) => (
    <button onClick={() => onAction(r.m.id, 'view')} className="w-full h-full text-left px-3 border-b border-slate-100 flex items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="text-sm font-semibold truncate">{r.m.name}</div>
        <div className="text-[11px] text-slate-500 truncate">{[r.m.category, `${currency} ${money(r.m.selling_price)}`, r.m.status === 'active' ? null : 'INACTIVE'].filter(Boolean).join(' · ')}</div>
      </div>
      <div className="text-right shrink-0">
        <div className={`text-base font-black ${r.state === 'out' ? 'text-rose-700' : r.state === 'low' ? 'text-amber-700' : ''}`}>{r.m.current_stock}</div>
        <span className={`px-1 rounded border text-[9px] font-bold ${STOCK_BADGE[r.state].cls}`}>{STOCK_BADGE[r.state].label}</span>
      </div>
    </button>
  );

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
        {card('Total medicines', summary.total, undefined, () => { setStatus('all'); setStock('all'); })}
        {card('Active', summary.active, undefined, () => setStatus('active'))}
        {card('Inactive', summary.inactive, undefined, () => setStatus('inactive'))}
        {card('In stock', summary.in, 'border-emerald-200', () => setStock('in'))}
        {card('Low stock', summary.low, 'border-amber-300', () => setStock('low'))}
        {card('Out of stock', summary.out, 'border-rose-200', () => setStock('out'))}
        {card('Total units', summary.units)}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-2 flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[16rem]">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search all medicines: name, generic, brand, barcode, SKU, category, strength, batch…"
            className="w-full pl-9 pr-8 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-teal-600 outline-none" aria-label="Search medicines" />
          {query && <button onClick={() => setQuery('')} className="absolute right-2 top-2" aria-label="Clear search"><X className="w-4 h-4 text-slate-400" /></button>}
        </div>
        <select className={sel} value={status} onChange={(e) => setStatus(e.target.value as any)} aria-label="Status"><option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
        <select className={sel} value={stock} onChange={(e) => setStock(e.target.value as any)} aria-label="Stock"><option value="all">All stock</option><option value="in">In stock</option><option value="low">Low stock</option><option value="out">Out of stock</option></select>
        <select className={sel} value={expiry} onChange={(e) => setExpiry(e.target.value as ExpiryFilter)} aria-label="Expiry"><option value="all">Any expiry</option><option value="soon">Expiring soon (90 d)</option><option value="expired">Expired</option><option value="unknown">Unknown expiry</option></select>
        <select className={sel} value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category"><option value="">All categories</option>{categories.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        <select className={sel} value={`${sort.key}:${sort.dir}`} onChange={(e) => { const [key, dir] = e.target.value.split(':'); setSort({ key: key as SortKey, dir: dir as any }); }} aria-label="Sort">
          <option value="name:asc">Medicine A–Z</option><option value="name:desc">Medicine Z–A</option><option value="stock:asc">Stock low → high</option><option value="stock:desc">Stock high → low</option>
          <option value="retail:asc">Retail price ↑</option><option value="retail:desc">Retail price ↓</option><option value="wholesale:desc">Wholesale price ↓</option>
          <option value="expiry:asc">Nearest expiry</option><option value="status:asc">Status</option>
        </select>
        <button onClick={onCreate} className="flex items-center gap-1 px-3 py-2 rounded-lg bg-teal-700 text-white text-xs font-bold"><Plus className="w-4 h-4" /> New medicine</button>
      </div>

      <div className="flex items-center justify-between text-xs text-slate-600 px-1" data-testid="catalog-counts">
        <span>Showing <b>{result.rows.length.toLocaleString()}</b> of <b>{summary.total.toLocaleString()}</b> medicines{query ? <> for “{query.trim()}”</> : ''}{filtered ? ' (filtered)' : ''}
          {result.fuzzy && <span className="ml-2 text-amber-800 font-semibold">No exact match — showing close spellings.</span>}</span>
        {(query || filtered) && <button onClick={() => { setQuery(''); setStatus('all'); setStock('all'); setExpiry('all'); setCategory(''); }} className="font-semibold text-teal-800">Clear search & filters</button>}
      </div>

      {loading && medicines.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-6 text-xs text-slate-500">Loading the catalogue from the cloud…</div>
      ) : result.rows.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-6 text-sm text-slate-700 text-center">
          {query ? <>No medicine matches “<b>{query.trim()}</b>”{filtered ? ' with these filters' : ''}.</> : 'No medicine matches these filters.'}
          <div><button onClick={() => { setQuery(''); setStatus('all'); setStock('all'); setExpiry('all'); setCategory(''); }} className="mt-2 px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold">Clear search</button></div>
        </div>
      ) : (
        <>
          <div className="hidden md:block bg-white border border-slate-200 rounded-xl overflow-hidden">
            <VirtualRows items={result.rows} rowHeight={48} height="calc(100vh - 330px)" minWidth={1720} render={row}
              header={(
                <div className="grid gap-x-2 px-3 py-2 bg-slate-50 border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-500 font-bold sticky top-0 z-10" style={{ gridTemplateColumns: COLS }}>
                  {HEADERS.map(([h, key]) => (
                    key ? (
                      <button key={h} onClick={() => sortBy(key)} className={`text-left flex items-center gap-0.5 ${sort.key === key ? 'text-teal-800' : ''}`}>
                        {h}{sort.key === key && (sort.dir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
                      </button>
                    ) : <div key={h}>{h === 'Purchase' && !showCost ? 'Purchase' : h}</div>
                  ))}
                </div>
              )} />
          </div>
          <div className="md:hidden bg-white border border-slate-200 rounded-xl overflow-hidden">
            <VirtualRows items={result.rows} rowHeight={60} height="calc(100vh - 360px)" render={mobileRow} />
          </div>
        </>
      )}
    </div>
  );
};
