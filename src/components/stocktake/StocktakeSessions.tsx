import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, ClipboardList, Loader2, Play, Plus, Printer, RefreshCw, RotateCcw, Search, Send, XCircle } from 'lucide-react';
import { apiFetch } from '../../services/http';
import { hasPermission } from '../../services/permissions';
import { MedicineSelector } from '../common/MedicineSelector';
import { db } from '../../db/dexie';
import type { Medicine, PharmacySettings, User } from '../../types';

/**
 * FORMAL STOCKTAKE SESSIONS (local shop server; /api/stocktakes).
 *   DRAFT -> COUNTING -> REVIEW -> COMPLETED (Administrator approval applies the variances) / CANCELLED.
 * Counting changes NO stock. A cashier sees only sessions opened to cashier counting and counts BLIND
 * (no system quantity, cost or variance). Approval applies (counted - system at count time) on top of
 * the stock at approval, as PHYSICAL_STOCK_COUNT movements (visible in Stock History).
 */
const input = 'px-2.5 py-2 border border-slate-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-teal-600 outline-none';
const btn = 'px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-1 disabled:opacity-50';
const STATUS_TONE: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-700', COUNTING: 'bg-sky-100 text-sky-800', REVIEW: 'bg-amber-100 text-amber-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800', CANCELLED: 'bg-rose-100 text-rose-800', APPROVED: 'bg-emerald-100 text-emerald-800',
};
const when = (v?: string | null) => (v ? new Date(v).toLocaleString() : '—');
const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export const StocktakeSessions: React.FC<{ currentUser: User; settings: PharmacySettings }> = ({ currentUser, settings }) => {
  const [list, setList] = useState<any[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const canCreate = hasPermission(currentUser, 'stocktake.create');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setList((await apiFetch<any>('/api/stocktakes')).stocktakes);
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Could not load stocktakes.' });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!openId) void load();
  }, [load, openId]);

  if (openId) return <StocktakeDetail id={openId} currentUser={currentUser} settings={settings} onBack={() => setOpenId(null)} />;
  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-bold text-slate-900 flex items-center gap-1.5"><ClipboardList className="w-4 h-4 text-teal-700" /> Stocktakes</h1>
          <p className="text-[11px] text-slate-500">Count first, approve later: counting never changes stock. An Administrator's approval applies the differences as audited stock movements.</p>
        </div>
        <div className="flex gap-2">
          <button className={`${btn} border border-slate-300`} onClick={() => void load()}>{loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh</button>
          {canCreate && <button className={`${btn} bg-teal-700 text-white`} onClick={() => setCreating(true)}><Plus className="w-3.5 h-3.5" /> New stocktake</button>}
        </div>
      </div>
      {msg && <div className={`text-xs rounded p-2 border ${msg.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>{msg.text}</div>}
      {creating && <CreateForm onCancel={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpenId(id); }} />}
      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-600"><tr>{['Number', 'Status', 'Scope', 'Counted', 'Started', 'Approved', ''].map((c) => <th key={c} className="px-2 py-2 text-left font-semibold">{c}</th>)}</tr></thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => setOpenId(s.id)}>
                <td className="px-2 py-1.5 font-mono font-semibold">{s.stocktake_number}</td>
                <td className="px-2 py-1.5"><span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${STATUS_TONE[s.status] || ''}`}>{s.status}</span></td>
                <td className="px-2 py-1.5">{s.scope_type === 'CATEGORY' ? `Category: ${s.scope_value?.category}` : s.scope_type === 'MEDICINES' ? `${s.scope_value?.medicine_ids?.length || 0} medicine(s)` : 'All stock'}</td>
                <td className="px-2 py-1.5">{s.counted} / {s.lines}</td>
                <td className="px-2 py-1.5">{s.started_by_name} · {when(s.created_at)}</td>
                <td className="px-2 py-1.5">{s.approved_by_name ? `${s.approved_by_name} · ${when(s.approved_at)}` : '—'}</td>
                <td className="px-2 py-1.5 text-teal-800 font-semibold">Open</td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={7} className="px-2 py-6 text-center text-slate-500">{canCreate ? 'No stocktakes yet.' : 'No stocktake is open for cashier counting.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const CreateForm: React.FC<{ onCancel: () => void; onCreated: (id: string) => void }> = ({ onCancel, onCreated }) => {
  const [scope, setScope] = useState<'ALL' | 'CATEGORY' | 'MEDICINES'>('ALL');
  const [category, setCategory] = useState('');
  const [meds, setMeds] = useState<Medicine[]>([]);
  const [catalogue, setCatalogue] = useState<Medicine[]>([]);
  useEffect(() => {
    if (scope === 'MEDICINES' && !catalogue.length) void db.medicines.toArray().then((m) => setCatalogue(m.filter((x) => x.status !== 'inactive')));
  }, [scope, catalogue.length]);
  const [cashiers, setCashiers] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await apiFetch<any>('/api/stocktakes', {
        body: { scope_type: scope, category: scope === 'CATEGORY' ? category : undefined, medicine_ids: scope === 'MEDICINES' ? meds.map((m) => m.id) : undefined, allow_cashier_count: cashiers, notes },
      });
      onCreated(r.id);
    } catch (e: any) {
      setErr(e?.message || 'Could not create the stocktake.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bg-white border border-teal-200 rounded-xl p-3 space-y-2">
      <div className="text-sm font-bold text-slate-800">New stocktake</div>
      <div className="flex flex-wrap gap-2 items-center">
        <select className={input} value={scope} onChange={(e) => setScope(e.target.value as any)}>
          <option value="ALL">All stock</option><option value="CATEGORY">One category</option><option value="MEDICINES">Selected medicines</option>
        </select>
        {scope === 'CATEGORY' && <input className={input} placeholder="Category name" value={category} onChange={(e) => setCategory(e.target.value)} />}
        <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={cashiers} onChange={(e) => setCashiers(e.target.checked)} /> Cashiers may count (blind)</label>
      </div>
      {scope === 'MEDICINES' && (
        <div className="space-y-1">
          <MedicineSelector medicines={catalogue} placeholder="Add a medicine to count" onSelect={(m) => m && setMeds((x) => (x.some((y) => y.id === m.id) ? x : [...x, m]))} />
          <div className="flex flex-wrap gap-1">{meds.map((m) => <span key={m.id} className="text-[11px] bg-slate-100 rounded px-1.5 py-0.5">{m.name} <button onClick={() => setMeds((x) => x.filter((y) => y.id !== m.id))}>×</button></span>)}</div>
        </div>
      )}
      <input className={`${input} w-full`} placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
      {err && <div className="text-xs text-rose-700">{err}</div>}
      <div className="flex gap-2">
        <button className={`${btn} bg-teal-700 text-white`} disabled={busy || (scope === 'CATEGORY' && !category.trim()) || (scope === 'MEDICINES' && !meds.length)} onClick={() => void create()}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Create (DRAFT)
        </button>
        <button className={`${btn} border border-slate-300`} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
};

const StocktakeDetail: React.FC<{ id: string; currentUser: User; settings: PharmacySettings; onBack: () => void }> = ({ id, currentUser, settings, onBack }) => {
  const [data, setData] = useState<any>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const blind = currentUser.role === 'CASHIER';
  const canCreate = hasPermission(currentUser, 'stocktake.create');
  const canApprove = hasPermission(currentUser, 'stocktake.approve');

  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams({ filter });
      if (q.trim()) p.set('search', q.trim());
      setData(await apiFetch<any>(`/api/stocktakes/${id}?${p.toString()}`));
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Could not load the stocktake.' });
    }
  }, [id, filter, q]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  const act = async (path: string, body: Record<string, unknown> = {}, done = 'Done.') => {
    setBusy(true);
    setMsg(null);
    try {
      await apiFetch(`/api/stocktakes/${id}/${path}`, { body });
      setMsg({ ok: true, text: done });
      await load();
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Request failed.' });
    } finally {
      setBusy(false);
    }
  };
  const save = async (lineId: string) => {
    const raw = drafts[lineId];
    if (raw === undefined) return;
    const value = raw.trim() === '' ? null : Number(raw);
    if (value !== null && (!Number.isInteger(value) || value < 0)) return setMsg({ ok: false, text: 'Counts are whole numbers from 0.' });
    try {
      await apiFetch(`/api/stocktakes/${id}/lines/${lineId}`, { method: 'PUT', body: { physical_quantity: value } });
      setDrafts((d) => { const n = { ...d }; delete n[lineId]; return n; });
      await load();
    } catch (err: any) {
      setMsg({ ok: false, text: err?.message || 'Could not save the count.' });
    }
  };

  const s = data?.stocktake;
  const rep = data?.report;
  const print = () => {
    if (!data) return;
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) return;
    const rows = data.lines.map((l: any) => `<tr><td>${esc(l.medicine_name)}</td><td>${esc(l.batch_number)}</td>${blind ? '' : `<td>${l.system_quantity ?? '—'}</td>`}<td>${l.physical_quantity ?? '—'}</td>${blind ? '' : `<td>${l.variance ?? '—'}</td><td>${money(l.variance_cost)}</td>`}<td>${esc(l.counted_by_name || '')}</td></tr>`).join('');
    w.document.write(`<!doctype html><html><head><title>${esc(s.stocktake_number)}</title><style>body{font-family:sans-serif;font-size:12px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:3px 6px}</style></head><body>
      <h2>${esc(settings.pharmacy_name || 'GIGA CHEMIST')} — Stocktake ${esc(s.stocktake_number)} (${esc(s.status)})</h2>
      <p>Started ${esc(when(s.created_at))} by ${esc(s.started_by_name)}${s.approved_by_name ? ` · approved ${esc(when(s.approved_at))} by ${esc(s.approved_by_name)}` : ''}</p>
      ${rep && !blind ? `<p>Items ${rep.total_items} · matched ${rep.matched} · short ${rep.short} · over ${rep.over} · uncounted ${rep.uncounted} · variance ${rep.total_variance_units} units · cost ${money(rep.variance_cost_value)}</p>` : ''}
      <table><thead><tr><th>Medicine</th><th>Batch</th>${blind ? '' : '<th>System</th>'}<th>Counted</th>${blind ? '' : '<th>Variance</th><th>Variance cost</th>'}<th>Counted by</th></tr></thead><tbody>${rows}</tbody></table>
      <p>Printed ${esc(new Date().toLocaleString())}</p></body></html>`);
    w.document.close();
    w.focus();
    w.print();
  };

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      <button className="text-xs font-semibold text-teal-800 flex items-center gap-1" onClick={onBack}><ArrowLeft className="w-3.5 h-3.5" /> All stocktakes</button>
      {s && (
        <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2 justify-between">
            <div className="text-sm font-bold text-slate-900 font-mono">{s.stocktake_number} <span className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold font-sans ${STATUS_TONE[s.status] || ''}`}>{s.status}</span></div>
            <div className="flex flex-wrap gap-2">
              {canCreate && s.status === 'DRAFT' && <button className={`${btn} bg-sky-700 text-white`} disabled={busy} onClick={() => void act('start', {}, 'Counting started.')}><Play className="w-3.5 h-3.5" /> Start counting</button>}
              {canCreate && s.status === 'COUNTING' && <button className={`${btn} bg-amber-600 text-white`} disabled={busy} onClick={() => void act('submit', {}, 'Submitted for review.')}><Send className="w-3.5 h-3.5" /> Submit for review</button>}
              {canCreate && s.status === 'REVIEW' && <button className={`${btn} border border-slate-300`} disabled={busy} onClick={() => void act('reopen', {}, 'Re-opened for counting.')}><RotateCcw className="w-3.5 h-3.5" /> Re-open counting</button>}
              {canApprove && s.status === 'REVIEW' && (
                <button className={`${btn} bg-emerald-700 text-white`} disabled={busy}
                  onClick={() => window.confirm(`Approve ${s.stocktake_number}? Every counted difference is applied to stock now (audited).`) && void act('approve', {}, 'Approved: stock adjusted.')}>
                  <CheckCircle2 className="w-3.5 h-3.5" /> Approve &amp; apply
                </button>
              )}
              <button className={`${btn} border border-slate-300`} onClick={print}><Printer className="w-3.5 h-3.5" /> Print</button>
            </div>
          </div>
          <div className="text-[11px] text-slate-500">
            Started {when(s.created_at)} by {s.started_by_name}{s.notes ? ` · ${s.notes}` : ''}{s.allow_cashier_count ? ' · cashiers may count' : ''}
            {s.approved_by_name ? ` · approved ${when(s.approved_at)} by ${s.approved_by_name}` : ''}{s.cancel_reason ? ` · cancelled: ${s.cancel_reason}` : ''}
          </div>
          {rep && (
            <div className="grid grid-cols-3 sm:grid-cols-8 gap-2">
              {(blind ? [['Items', rep.total_items], ['Counted', rep.counted], ['Uncounted', rep.uncounted]] : [
                ['Items', rep.total_items], ['Counted', rep.counted], ['Matched', rep.matched], ['Short', rep.short], ['Over', rep.over], ['Uncounted', rep.uncounted],
                ['Variance units', rep.total_variance_units], ['Variance cost', money(rep.variance_cost_value)]]).map(([k, v]) => (
                <div key={String(k)} className="bg-slate-50 rounded-lg p-2"><div className="text-[10px] uppercase text-slate-500 font-semibold">{k}</div><div className="text-sm font-bold">{v}</div></div>
              ))}
            </div>
          )}
          {canCreate && ['DRAFT', 'COUNTING', 'REVIEW'].includes(s.status) && (
            <div className="flex gap-2 items-center">
              <input className={`${input} flex-1`} placeholder="Reason to cancel this stocktake" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
              <button className={`${btn} text-rose-700 border border-rose-200`} disabled={busy || !cancelReason.trim()} onClick={() => void act('cancel', { reason: cancelReason }, 'Stocktake cancelled (no stock changed).')}><XCircle className="w-3.5 h-3.5" /> Cancel stocktake</button>
            </div>
          )}
        </div>
      )}
      {msg && <div className={`text-xs rounded p-2 border ${msg.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>{msg.text}</div>}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[180px]"><Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" /><input className={`${input} w-full pl-8`} placeholder="Search medicine, barcode or batch" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <select className={input} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All lines</option><option value="uncounted">Uncounted</option>{!blind && <option value="variance">With variance</option>}
        </select>
      </div>
      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-600"><tr>
            {['Medicine', 'Batch', 'Expiry', ...(blind ? [] : ['System']), 'Counted', ...(blind ? [] : ['Variance', 'Variance cost']), 'Counted by'].map((c) => <th key={c} className="px-2 py-2 text-left font-semibold">{c}</th>)}
          </tr></thead>
          <tbody>
            {(data?.lines || []).map((l: any) => (
              <tr key={l.id} className="border-t border-slate-100">
                <td className="px-2 py-1.5"><div className="font-semibold text-slate-900">{l.medicine_name}</div>{l.generic_name && <div className="text-[10px] text-slate-500">{l.generic_name}</div>}</td>
                <td className="px-2 py-1.5 font-mono">{l.batch_number}</td>
                <td className="px-2 py-1.5">{l.expiry_date ? String(l.expiry_date).slice(0, 10) : '—'}</td>
                {!blind && <td className="px-2 py-1.5">{l.system_quantity ?? <span className="text-slate-400">now {l.current_quantity}</span>}</td>}
                <td className="px-2 py-1.5">
                  {s?.status === 'COUNTING' ? (
                    <input className={`${input} w-20`} inputMode="numeric" value={drafts[l.id] ?? (l.physical_quantity ?? '')}
                      onChange={(e) => setDrafts((d) => ({ ...d, [l.id]: e.target.value }))} onBlur={() => void save(l.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} aria-label={`Count for ${l.medicine_name} ${l.batch_number}`} />
                  ) : (l.physical_quantity ?? '—')}
                </td>
                {!blind && <td className={`px-2 py-1.5 font-semibold ${l.variance < 0 ? 'text-rose-700' : l.variance > 0 ? 'text-sky-700' : ''}`}>{l.variance === null || l.variance === undefined ? '—' : l.variance > 0 ? `+${l.variance}` : l.variance}</td>}
                {!blind && <td className="px-2 py-1.5">{money(l.variance_cost)}</td>}
                <td className="px-2 py-1.5">{l.counted_by_name ? `${l.counted_by_name} · ${when(l.counted_at)}` : '—'}</td>
              </tr>
            ))}
            {data && !data.lines.length && <tr><td colSpan={8} className="px-2 py-6 text-center text-slate-500">No lines match.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
};
