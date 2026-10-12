import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, CheckCircle2, Loader2, PackageCheck, Pencil, Plus, Power, RefreshCw, Search, Trash2, Undo2, XCircle } from 'lucide-react';
import { apiFetch } from '../../services/http';
import { createRequestId } from '../../services/remoteAdmin';
import { Sheet, inputCls, labelCls, btnPrimary, btnSecondary, card, type Draft } from './remoteUi';
import { useRemoteSender } from './remoteSend';
import type { Medicine, PharmacySettings } from '../../types';


/**
 * Online management of ONE selected shop's directory and finance records (Global Admin / shop Admin):
 * suppliers, customers, expenses, purchases, returns and sales. Lists come from the shop's cloud copy;
 * every change is a shop-scoped command applied by the shop computer (never a direct cloud write).
 * Nothing is deleted: suppliers/customers are deactivated, expenses voided, pending purchases
 * cancelled, completed sales voided (never edited), returns approved/rejected.
 */
export type RecordsKind = 'suppliers' | 'customers' | 'expenses' | 'purchases' | 'returns' | 'sales';

interface Field {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'select' | 'textarea';
  options?: readonly string[];
  required?: boolean;
}

const EXPENSE_CATEGORIES = ['Rent', 'Electricity', 'Internet', 'Salaries', 'Transport', 'Maintenance', 'Supplies', 'Miscellaneous'] as const;
const PAYMENT_METHODS = ['Cash', 'M-Pesa', 'Card', 'Bank'] as const;

const FORMS: Partial<Record<RecordsKind, Field[]>> = {
  suppliers: [
    { key: 'name', label: 'Name', required: true }, { key: 'contact_person', label: 'Contact person' }, { key: 'phone', label: 'Phone' },
    { key: 'email', label: 'Email' }, { key: 'address', label: 'Address', type: 'textarea' }, { key: 'tax_pin', label: 'Tax PIN' },
  ],
  customers: [
    { key: 'name', label: 'Name', required: true }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
    { key: 'address', label: 'Address', type: 'textarea' }, { key: 'notes', label: 'Notes', type: 'textarea' },
  ],
  expenses: [
    { key: 'category', label: 'Category', type: 'select', options: EXPENSE_CATEGORIES, required: true },
    { key: 'description', label: 'Description', required: true }, { key: 'amount', label: 'Amount', type: 'number', required: true },
    { key: 'payment_method', label: 'Payment method', type: 'select', options: PAYMENT_METHODS }, { key: 'reference', label: 'Reference' },
    { key: 'date', label: 'Date (empty = today)', type: 'date' },
  ],
};

const TITLES: Record<RecordsKind, string> = {
  suppliers: 'Suppliers', customers: 'Customers', expenses: 'Expenses', purchases: 'Purchases', returns: 'Returns', sales: 'Sales',
};

const ENDPOINT: Record<RecordsKind, string> = {
  suppliers: '/api/suppliers', customers: '/api/customers', expenses: '/api/expenses', purchases: '/api/purchases',
  returns: '/api/returns', sales: '/api/sales?limit=200',
};

const isActive = (kind: RecordsKind, r: any) =>
  kind === 'suppliers' ? (r.status || 'active') === 'active' : kind === 'customers' ? r.active !== false : true;

type Sheetish =
  | { mode: 'form'; record: any | null }
  | { mode: 'reason'; record: any; action: 'active' | 'void' | 'cancel' | 'reject' | 'sale-void' }
  | { mode: 'approve'; record: any }
  | { mode: 'purchase'; record: any | null }
  | { mode: 'receive'; record: any };

export const RemoteRecords: React.FC<{ kind: RecordsKind; settings: PharmacySettings }> = ({ kind, settings }) => {
  const cur = settings.currency || 'KES';
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [sheet, setSheet] = useState<Sheetish | null>(null);
  const [suppliers, setSuppliers] = useState<any[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data: any = await apiFetch(ENDPOINT[kind]);
      setRows(Array.isArray(data) ? data : data?.sales || []);
      if (kind === 'purchases') setSuppliers(await apiFetch<any[]>('/api/suppliers').catch(() => []));
    } catch (err: any) {
      setLoadError(err?.message || 'Could not load from the cloud copy.');
    } finally {
      setLoading(false);
    }
  }, [kind]);
  useEffect(() => {
    setFilter(kind === 'returns' ? 'PENDING' : 'all');
    setQ('');
    void load();
  }, [kind, load]);
  const { review, confirmSheet, trackedList, status } = useRemoteSender(() => void load());

  const filters: [string, string][] = {
    suppliers: [['all', 'All'], ['active', 'Active'], ['inactive', 'Inactive']],
    customers: [['all', 'All'], ['active', 'Active'], ['inactive', 'Inactive']],
    expenses: [['all', 'All'], ['posted', 'Posted'], ['voided', 'Voided']],
    purchases: [['all', 'All'], ['pending', 'Pending'], ['received', 'Received'], ['cancelled', 'Cancelled']],
    returns: [['PENDING', 'Pending'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected'], ['all', 'All']],
    sales: [['all', 'All'], ['completed', 'Completed'], ['voided', 'Voided'], ['returned', 'Returned']],
  }[kind] as [string, string][];

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== 'all') {
        if (kind === 'suppliers' || kind === 'customers') { if ((filter === 'active') !== isActive(kind, r)) return false; }
        else if (kind === 'expenses') { if ((r.status || 'posted') !== filter) return false; }
        else if (kind === 'sales') { if (filter === 'returned' ? !String(r.status).includes('returned') : r.status !== filter) return false; }
        else if (String(r.status) !== filter) return false;
      }
      if (!t) return true;
      return JSON.stringify([r.name, r.phone, r.email, r.description, r.order_number, r.invoice_number, r.supplier_name, r.receipt_number, r.medicine_name, r.customer_name, r.category])
        .toLowerCase().includes(t);
    }).slice(0, 300);
  }, [rows, q, filter, kind]);

  // ------------------------------------------------------------------ drafts
  const formDraft = (record: any | null, values: Record<string, string>) => {
    const fields = FORMS[kind]!;
    const payload: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    const lines: [string, string][] = [];
    for (const f of fields) {
      const v = (values[f.key] ?? '').trim();
      if (f.required && !v) throw new Error(`${f.label} is required.`);
      const old = record ? String(record[f.key] ?? '') : '';
      if (record && v === old.trim()) continue;
      if (!record && !v) continue;
      if (f.type === 'number') {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`${f.label} must be greater than zero.`);
        payload[f.key] = Math.round(n * 100) / 100;
      } else payload[f.key] = v;
      if (record) expected[f.key] = record[f.key] ?? null;
      lines.push([f.label, record ? `${old || '—'} → ${v || '—'}` : v]);
    }
    if (lines.length === 0) throw new Error('Nothing changed.');
    const single = kind === 'suppliers' ? 'supplier' : kind === 'customers' ? 'customer' : 'expense';
    if (record) {
      payload[`${single}_id`] = record.id;
      payload.expected = expected;
    }
    return {
      action: `${single}-${record ? 'update' : 'create'}`, title: `${record ? 'Edit' : 'New'} ${single}`, payload, requestId: createRequestId(),
      lines: [['Action', record ? `EDIT ${single.toUpperCase()}` : `NEW ${single.toUpperCase()}`], ...(record ? [[single, record.name || record.description] as [string, string]] : []), ...lines],
    } as Draft;
  };

  const reasonDraft = (s: Extract<Sheetish, { mode: 'reason' }>, reason: string): Draft => {
    const r = s.record;
    const rid = createRequestId();
    if (s.action === 'active') {
      const single = kind === 'suppliers' ? 'supplier' : 'customer';
      const active = !isActive(kind, r);
      return { action: `${single}-active` as any, title: `${active ? 'Activate' : 'Deactivate'} ${single}`, requestId: rid,
        payload: { [`${single}_id`]: r.id, active, reason }, lines: [[single, r.name], ['Status', active ? 'ACTIVE again' : 'DEACTIVATED (kept for history, not deleted)'], ['Reason', reason]] };
    }
    if (s.action === 'void') return { action: 'expense-void', title: 'Void expense', requestId: rid, payload: { expense_id: r.id, reason },
      lines: [['Expense', `${r.description} — ${cur} ${Number(r.amount).toFixed(2)}`], ['Effect', 'VOIDED: kept for audit, excluded from reports'], ['Reason', reason]] };
    if (s.action === 'cancel') return { action: 'purchase-cancel', title: 'Cancel purchase', requestId: rid, payload: { purchase_id: r.id, reason },
      lines: [['Purchase', `${r.order_number} (${r.supplier_name})`], ['Effect', 'CANCELLED (nothing was in stock yet)'], ['Reason', reason]] };
    if (s.action === 'reject') return { action: 'return-reject', title: 'Reject return', requestId: rid, payload: { return_id: r.id, reason },
      lines: [['Receipt', r.receipt_number], ['Item', `${r.medicine_name} × ${r.quantity}`], ['Effect', 'REJECTED: no stock, refund or report effect'], ['Reason', reason]] };
    return { action: 'sale-void', title: 'Void sale', requestId: rid, payload: { sale_id: r.id, reason },
      lines: [['Receipt', r.receipt_number], ['Total', `${cur} ${Number(r.total).toFixed(2)}`], ['Effect', 'VOIDED: stock returned, sale kept (never edited)'], ['Reason', reason]] };
  };

  // ------------------------------------------------------------------ rows
  const actionBtn = (label: string, Icon: any, onClick: () => void, tone: 'normal' | 'danger' = 'normal') => (
    <button onClick={onClick} className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-semibold ${tone === 'danger' ? 'border-rose-300 text-rose-700 hover:bg-rose-50' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}>
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  );
  const rowView = (r: any) => {
    let title = '', sub = '', right = '', badge = '';
    const acts: React.ReactNode[] = [];
    if (kind === 'suppliers' || kind === 'customers') {
      title = r.name; sub = [r.contact_person, r.phone, r.email].filter(Boolean).join(' · ');
      badge = isActive(kind, r) ? 'Active' : 'Inactive';
      acts.push(actionBtn('Edit', Pencil, () => setSheet({ mode: 'form', record: r })));
      acts.push(actionBtn(isActive(kind, r) ? 'Deactivate' : 'Activate', Power, () => setSheet({ mode: 'reason', record: r, action: 'active' }), isActive(kind, r) ? 'danger' : 'normal'));
    } else if (kind === 'expenses') {
      title = r.description; sub = `${r.category} · ${r.date} · ${r.payment_method}${r.user_name ? ` · ${r.user_name}` : ''}`;
      right = `${cur} ${Number(r.amount).toFixed(2)}`; badge = r.status === 'voided' ? 'Voided' : 'Posted';
      if (r.status !== 'voided') {
        acts.push(actionBtn('Correct', Pencil, () => setSheet({ mode: 'form', record: r })));
        acts.push(actionBtn('Void', Ban, () => setSheet({ mode: 'reason', record: r, action: 'void' }), 'danger'));
      }
    } else if (kind === 'purchases') {
      title = `${r.order_number} — ${r.supplier_name}`; sub = `${r.invoice_number || 'no invoice yet'} · ${r.items?.length || 0} line(s) · ${r.order_date}`;
      right = `${cur} ${Number(r.total_amount).toFixed(2)}`; badge = r.status;
      if (r.status === 'pending') {
        acts.push(actionBtn('Edit', Pencil, () => setSheet({ mode: 'purchase', record: r })));
        acts.push(actionBtn('Receive', PackageCheck, () => setSheet({ mode: 'receive', record: r })));
        acts.push(actionBtn('Cancel', XCircle, () => setSheet({ mode: 'reason', record: r, action: 'cancel' }), 'danger'));
      }
    } else if (kind === 'returns') {
      title = `${r.medicine_name} × ${r.quantity}`; sub = `Receipt ${r.receipt_number} · ${r.reason || ''} · by ${r.user_name || 'staff'}`;
      right = `${cur} ${Number(r.requested_refund ?? r.refund_amount ?? 0).toFixed(2)}`; badge = r.status;
      if (r.status === 'PENDING') {
        acts.push(actionBtn('Approve', CheckCircle2, () => setSheet({ mode: 'approve', record: r })));
        acts.push(actionBtn('Reject', XCircle, () => setSheet({ mode: 'reason', record: r, action: 'reject' }), 'danger'));
      }
    } else {
      title = `Receipt ${r.receipt_number}`; sub = `${r.date} ${r.time || ''} · ${r.cashier_name || ''} · ${r.payment_method || ''}`;
      right = `${cur} ${Number(r.total).toFixed(2)}`; badge = r.status;
      if (r.status === 'completed' && !String(r.idempotency_key || '').startsWith('LEGACY-')) {
        acts.push(actionBtn('Void sale', Undo2, () => setSheet({ mode: 'reason', record: r, action: 'sale-void' }), 'danger'));
      }
    }
    return (
      <div key={r.id} className={card}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900 truncate">{title}</div>
            <div className="text-[11px] text-slate-500 truncate">{sub}</div>
          </div>
          <div className="text-right shrink-0">
            {right && <div className="text-sm font-bold text-slate-900">{right}</div>}
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{badge}</span>
          </div>
        </div>
        {acts.length > 0 && <div className="flex flex-wrap gap-1.5 mt-2">{acts}</div>}
      </div>
    );
  };

  const creatable = kind === 'suppliers' || kind === 'customers' || kind === 'expenses' || kind === 'purchases';

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      <div className="px-3 pt-3 pb-2 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-base font-bold text-slate-900">{TITLES[kind]} — {status?.shop_code || 'shop'}</h1>
            <p className="text-[11px] text-slate-500">Cloud copy of {status?.shop_name || 'the selected shop'}. Changes are sent to the shop computer and applied there.</p>
          </div>
          <div className="flex gap-1.5">
            <button onClick={() => void load()} className="p-2 rounded-lg hover:bg-slate-100" aria-label="Refresh"><RefreshCw className={`w-4 h-4 text-slate-500 ${loading ? 'animate-spin' : ''}`} /></button>
            {creatable && (
              <button onClick={() => setSheet(kind === 'purchases' ? { mode: 'purchase', record: null } : { mode: 'form', record: null })}
                className="flex items-center gap-1 px-3 py-2 rounded-lg bg-teal-700 text-white text-xs font-bold">
                <Plus className="w-4 h-4" /> New
              </button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mt-2">
          <div className="relative flex-1 min-w-[10rem]">
            <Search className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className={`${inputCls} pl-9`} />
          </div>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className={`${inputCls} w-auto`} aria-label="Filter">
            {filters.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2 max-w-3xl w-full mx-auto">
        {trackedList}
        {loadError && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{loadError}</div>}
        {loading && rows.length === 0 && <div className="text-xs text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading from the cloud…</div>}
        <div className="text-[11px] text-slate-500">{shown.length} of {rows.length} shown</div>
        {shown.map(rowView)}
        {!loading && shown.length === 0 && <div className="text-xs text-slate-500 p-4 text-center">Nothing matches.</div>}
      </div>

      {sheet?.mode === 'form' && (
        <FormSheet fields={FORMS[kind]!} record={sheet.record} title={`${sheet.record ? 'Edit' : 'New'} ${TITLES[kind].replace(/s$/, '').toLowerCase()}`}
          onCancel={() => setSheet(null)} onReview={(values) => { review(formDraft(sheet.record, values)); setSheet(null); }} />
      )}
      {sheet?.mode === 'reason' && (
        <ReasonSheet title={{ active: isActive(kind, sheet.record) ? 'Deactivate' : 'Activate', void: 'Void expense', cancel: 'Cancel pending purchase', reject: 'Reject return', 'sale-void': 'Void sale' }[sheet.action]}
          onCancel={() => setSheet(null)} onReview={(reason) => { review(reasonDraft(sheet, reason)); setSheet(null); }} />
      )}
      {sheet?.mode === 'approve' && (
        <ApproveSheet record={sheet.record} currency={cur} onCancel={() => setSheet(null)} onReview={(d) => { review(d); setSheet(null); }} />
      )}
      {sheet?.mode === 'purchase' && (
        <PurchaseSheet record={sheet.record} suppliers={suppliers.filter((s) => (s.status || 'active') === 'active')} currency={cur}
          onCancel={() => setSheet(null)} onReview={(d) => { review(d); setSheet(null); }} />
      )}
      {sheet?.mode === 'receive' && (
        <ReceiveSheet record={sheet.record} currency={cur} onCancel={() => setSheet(null)} onReview={(d) => { review(d); setSheet(null); }} />
      )}
      {confirmSheet}
    </div>
  );
};

// ---------------------------------------------------------------------------- sheets
const FormSheet: React.FC<{ fields: Field[]; record: any | null; title: string; onCancel: () => void; onReview: (v: Record<string, string>) => void }> = ({ fields, record, title, onCancel, onReview }) => {
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, record ? String(record[f.key] ?? '') : (f.type === 'select' && f.options ? f.options[0] : '')])));
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet title={title} onClose={onCancel}>
      <div className="space-y-2">
        {fields.map((f) => (
          <div key={f.key}>
            <label className={labelCls}>{f.label}{f.required ? ' *' : ''}</label>
            {f.type === 'select' ? (
              <select value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} className={inputCls}>
                {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.type === 'textarea' ? (
              <textarea value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} className={inputCls} rows={2} />
            ) : (
              <input type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined} value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} className={inputCls} />
            )}
          </div>
        ))}
        {record && <p className="text-[11px] text-slate-500">The shop compares the values you see here with its own: if someone changed them meanwhile, your edit is rejected (nothing is overwritten).</p>}
        {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button className={btnSecondary} onClick={onCancel}>Cancel</button>
          <button className={btnPrimary} onClick={() => { try { setError(null); onReview(v); } catch (e: any) { setError(e?.message || 'Check the form.'); } }}>Review</button>
        </div>
      </div>
    </Sheet>
  );
};

const ReasonSheet: React.FC<{ title: string; onCancel: () => void; onReview: (reason: string) => void }> = ({ title, onCancel, onReview }) => {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet title={title} onClose={onCancel}>
      <label className={labelCls}>Reason (recorded in the shop audit trail)</label>
      <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} />
      {error && <div className="mt-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}
      <div className="grid grid-cols-2 gap-2 mt-3">
        <button className={btnSecondary} onClick={onCancel}>Cancel</button>
        <button className={btnPrimary} onClick={() => (reason.trim().length < 3 ? setError('Give a reason (at least 3 characters).') : onReview(reason.trim()))}>Review</button>
      </div>
    </Sheet>
  );
};

const ApproveSheet: React.FC<{ record: any; currency: string; onCancel: () => void; onReview: (d: Draft) => void }> = ({ record, currency, onCancel, onReview }) => {
  const [restock, setRestock] = useState(true);
  const [disposition, setDisposition] = useState('quarantine');
  const [notes, setNotes] = useState('');
  return (
    <Sheet title="Approve return" onClose={onCancel}>
      <div className="space-y-2 text-sm">
        <div className="bg-slate-50 rounded p-2 text-xs">{record.medicine_name} × {record.quantity} · receipt {record.receipt_number} · requested {currency} {Number(record.requested_refund ?? 0).toFixed(2)}</div>
        <label className="flex items-center gap-2"><input type="radio" checked={restock} onChange={() => setRestock(true)} /> Return to sellable stock</label>
        <label className="flex items-center gap-2"><input type="radio" checked={!restock} onChange={() => setRestock(false)} /> Do NOT restock</label>
        {!restock && (
          <select value={disposition} onChange={(e) => setDisposition(e.target.value)} className={inputCls}>
            <option value="quarantine">Quarantine</option><option value="damaged">Damaged</option><option value="dispose">Dispose</option>
          </select>
        )}
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" className={inputCls} />
        <p className="text-[11px] text-slate-500">The refund is computed by the shop from the ORIGINAL sale price. Only an approved return affects stock, refunds and reports.</p>
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button className={btnSecondary} onClick={onCancel}>Cancel</button>
          <button className={btnPrimary} onClick={() => onReview({
            action: 'return-approve', title: 'Approve return', requestId: createRequestId(),
            payload: { return_id: record.id, restock, ...(restock ? {} : { disposition }), ...(notes.trim().length >= 3 ? { notes: notes.trim() } : {}) },
            lines: [['Receipt', record.receipt_number], ['Item', `${record.medicine_name} × ${record.quantity}`], ['Stock', restock ? 'RETURN TO SELLABLE STOCK' : `not restocked (${disposition})`], ['Refund', 'computed by the shop from the original sale']],
          })}>Review</button>
        </div>
      </div>
    </Sheet>
  );
};

const ReceiveSheet: React.FC<{ record: any; currency: string; onCancel: () => void; onReview: (d: Draft) => void }> = ({ record, currency, onCancel, onReview }) => {
  const [invoice, setInvoice] = useState(record.invoice_number || '');
  const [pay, setPay] = useState(record.payment_status || 'paid');
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet title={`Receive ${record.order_number}`} onClose={onCancel}>
      <div className="space-y-2">
        <div className="text-xs bg-slate-50 rounded p-2 space-y-0.5">
          {(record.items || []).map((it: any) => <div key={it.id}>{it.medicine_name} · batch {it.batch_number} · × {it.quantity} @ {currency} {Number(it.purchase_price).toFixed(2)}</div>)}
        </div>
        <div><label className={labelCls}>Supplier invoice number</label><input value={invoice} onChange={(e) => setInvoice(e.target.value)} className={inputCls} /></div>
        <div><label className={labelCls}>Payment status</label>
          <select value={pay} onChange={(e) => setPay(e.target.value)} className={inputCls}><option value="paid">Paid</option><option value="partial">Partial</option><option value="unpaid">Unpaid</option></select>
        </div>
        {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button className={btnSecondary} onClick={onCancel}>Cancel</button>
          <button className={btnPrimary} onClick={() => {
            if (!invoice.trim()) return setError('The supplier invoice number is required to receive goods.');
            onReview({
              action: 'purchase-receive', title: 'Receive purchase', requestId: createRequestId(),
              payload: { purchase_id: record.id, invoice_number: invoice.trim(), payment_status: pay },
              lines: [['Purchase', `${record.order_number} — ${record.supplier_name}`], ['Invoice', invoice.trim().toUpperCase()], ['Lines', String(record.items?.length || 0)],
                ['Total', `${currency} ${Number(record.total_amount).toFixed(2)}`], ['Effect', 'STOCK IN: batches, movements and purchase state in ONE shop transaction']],
            });
          }}>Review</button>
        </div>
      </div>
    </Sheet>
  );
};

interface Line { medicine_id: string; medicine_name: string; batch_number: string; expiry_date: string; quantity: string; purchase_price: string }

const PurchaseSheet: React.FC<{ record: any | null; suppliers: any[]; currency: string; onCancel: () => void; onReview: (d: Draft) => void }> = ({ record, suppliers, currency, onCancel, onReview }) => {
  const [supplierId, setSupplierId] = useState(record?.supplier_id || suppliers[0]?.id || '');
  const [invoice, setInvoice] = useState(record?.invoice_number || '');
  const [lines, setLines] = useState<Line[]>(() => (record?.items || []).map((it: any) => ({
    medicine_id: it.medicine_id, medicine_name: it.medicine_name, batch_number: it.batch_number, expiry_date: it.expiry_date || '',
    quantity: String(it.quantity), purchase_price: String(it.purchase_price),
  })));
  const [catalog, setCatalog] = useState<Medicine[]>([]);
  const [find, setFind] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiFetch<Medicine[]>('/api/medicines').then((m) => setCatalog(Array.isArray(m) ? m : [])).catch(() => setCatalog([]));
  }, []);
  const hits = useMemo(() => {
    const t = find.trim().toLowerCase();
    if (t.length < 2) return [];
    return catalog.filter((m) => [m.name, m.barcode, m.generic_name].some((v) => (v || '').toLowerCase().includes(t))).slice(0, 8);
  }, [catalog, find]);
  const set = (i: number, k: keyof Line, v: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const build = () => {
    if (!supplierId) throw new Error('Choose an active supplier.');
    if (lines.length === 0) throw new Error('Add at least one line.');
    const items = lines.map((l, i) => {
      const qty = Number(l.quantity), price = Number(l.purchase_price);
      if (!/^\d+$/.test(l.quantity.trim()) || qty < 1) throw new Error(`Line ${i + 1}: quantity must be a whole number of at least 1.`);
      if (!Number.isFinite(price) || price < 0 || l.purchase_price.trim() === '') throw new Error(`Line ${i + 1}: purchase price is required.`);
      if (!l.batch_number.trim()) throw new Error(`Line ${i + 1}: batch number is required.`);
      return { medicine_id: l.medicine_id, batch_number: l.batch_number.trim(), expiry_date: l.expiry_date || null, quantity: qty, purchase_price: Math.round(price * 100) / 100 };
    });
    const total = items.reduce((s, it) => s + it.quantity * it.purchase_price, 0);
    const sup = suppliers.find((s) => s.id === supplierId);
    return { items, total, sup };
  };
  return (
    <Sheet title={record ? `Edit pending ${record.order_number}` : 'New purchase (pending)'} onClose={onCancel}>
      <div className="space-y-2">
        <div><label className={labelCls}>Supplier</label>
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={inputCls}>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div><label className={labelCls}>Supplier invoice (optional until received)</label><input value={invoice} onChange={(e) => setInvoice(e.target.value)} className={inputCls} /></div>
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="border border-slate-200 rounded-lg p-2 space-y-1.5">
              <div className="flex justify-between items-center text-xs font-semibold"><span className="truncate">{l.medicine_name}</span>
                <button onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove line"><Trash2 className="w-4 h-4 text-rose-600" /></button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <input value={l.batch_number} onChange={(e) => set(i, 'batch_number', e.target.value)} placeholder="Batch number" className={inputCls} />
                <input type="date" value={l.expiry_date} onChange={(e) => set(i, 'expiry_date', e.target.value)} className={inputCls} aria-label="Expiry" />
                <input inputMode="numeric" value={l.quantity} onChange={(e) => set(i, 'quantity', e.target.value)} placeholder="Quantity" className={inputCls} />
                <input inputMode="decimal" value={l.purchase_price} onChange={(e) => set(i, 'purchase_price', e.target.value)} placeholder={`Unit cost (${currency})`} className={inputCls} />
              </div>
            </div>
          ))}
        </div>
        <div className="relative">
          <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Add a medicine: type its name or barcode" className={inputCls} />
          {hits.length > 0 && (
            <div className="absolute z-10 left-0 right-0 bg-white border border-slate-200 rounded-lg shadow-lg mt-1 max-h-56 overflow-y-auto">
              {hits.map((m) => (
                <button key={m.id} className="w-full text-left px-3 py-2 text-xs hover:bg-slate-50" onClick={() => {
                  setLines([...lines, { medicine_id: m.id, medicine_name: m.name, batch_number: '', expiry_date: '', quantity: '', purchase_price: String(m.purchase_price ?? '') }]);
                  setFind('');
                }}>{m.name} <span className="text-slate-400">{m.barcode}</span></button>
              ))}
            </div>
          )}
        </div>
        {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button className={btnSecondary} onClick={onCancel}>Cancel</button>
          <button className={btnPrimary} onClick={() => {
            try {
              setError(null);
              const { items, total, sup } = build();
              const payload: Record<string, unknown> = record
                ? { purchase_id: record.id, supplier_id: supplierId, invoice_number: invoice.trim(), items }
                : { supplier_id: supplierId, items, ...(invoice.trim() ? { invoice_number: invoice.trim() } : {}) };
              onReview({
                action: record ? 'purchase-update' : 'purchase-create', title: record ? 'Edit pending purchase' : 'New purchase', requestId: createRequestId(), payload,
                lines: [['Supplier', sup?.name || '—'], ['Invoice', invoice.trim() || 'not yet'], ['Lines', String(items.length)], ['Total', `${currency} ${total.toFixed(2)}`],
                  ['Effect', 'PENDING purchase: nothing goes into stock until it is received']],
              });
            } catch (e: any) {
              setError(e?.message || 'Check the purchase.');
            }
          }}>Review</button>
        </div>
      </div>
    </Sheet>
  );
};
