import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Loader2,
  MinusCircle,
  PackagePlus,
  Pencil,
  RefreshCw,
  Search,
  Send,
  Tag,
  CalendarClock,
  ClipboardCheck,
  Wifi,
  WifiOff,
  X,
  XCircle,
} from 'lucide-react';
import { apiFetch, ApiError } from '../../services/http';
import {
  COMMAND_LABELS,
  STOCK_REMOVE_REASONS,
  createRequestId,
  getRemoteCommand,
  getRemoteStatus,
  isFinal,
  listRemoteCommands,
  queueRemoteCommand,
  type RemoteAction,
  type RemoteCommand,
  type RemoteStatus,
} from '../../services/remoteAdmin';
import { Sheet, StatusBadge, STATUS_TEXT, ago, when, inputCls, labelCls, btnPrimary, btnSecondary, describeResult, describeRequest, type Draft } from './remoteUi';
import { AlertsTab, CommandDetail, HealthTab, InsightsTab, SecurityTab, StaffTab } from './RemoteOps';
import type { Medicine, MedicineBatch, PharmacySettings, User } from '../../types';

/**
 * Remote Admin (online app, ADMIN only). Everything shown comes from the cloud copy; every change
 * is QUEUED for the shop computer, which applies it to the authoritative local database and syncs
 * the result back. Nothing here says "changed" until the shop reports APPLIED.
 */
interface Props {
  currentUser: User | null;
  settings: PharmacySettings;
}

type Tab = 'medicines' | 'changes' | 'health' | 'alerts' | 'insights' | 'staff' | 'security' | 'shop';

type ActionKind = 'add' | 'remove' | 'count' | 'price' | 'details' | 'expiry';

export const RemoteAdminPanel: React.FC<Props> = ({ currentUser, settings }) => {
  const [tab, setTab] = useState<Tab>('medicines');
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [batches, setBatches] = useState<MedicineBatch[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<{ kind: ActionKind; batchId?: string } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [tracked, setTracked] = useState<RemoteCommand[]>([]);
  const [history, setHistory] = useState<RemoteCommand[]>([]);
  const [now, setNow] = useState(Date.now());
  const [detail, setDetail] = useState<RemoteCommand | null>(null);
  const cur = settings.currency || 'KES';

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [meds, bts, cats] = await Promise.all([
        apiFetch<Medicine[]>('/api/medicines'),
        apiFetch<MedicineBatch[]>('/api/batches'),
        apiFetch<{ name: string }[]>('/api/categories').catch(() => []),
      ]);
      setMedicines(Array.isArray(meds) ? meds : []);
      setBatches(Array.isArray(bts) ? bts : []);
      setCategories([...new Set((cats || []).map((c) => c.name).filter(Boolean))].sort());
    } catch (err: any) {
      setLoadError(err?.message || 'Could not load medicines from the cloud.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await getRemoteStatus());
      setStatusError(null);
    } catch (err: any) {
      setStatusError(err?.message || 'Cloud status unavailable.');
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      setHistory((await listRemoteCommands(40)).commands);
    } catch {
      /* the status card already reports cloud trouble */
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
    void loadStatus();
    void loadHistory();
    const t = setInterval(() => {
      setNow(Date.now());
      void loadStatus();
    }, 15_000);
    return () => clearInterval(t);
  }, [loadCatalog, loadStatus, loadHistory]);

  // Follow commands sent from this screen until the shop reports a final status.
  const trackedRef = useRef(tracked);
  trackedRef.current = tracked;
  useEffect(() => {
    const open = tracked.filter((c) => !isFinal(c.status));
    const anyOpenInHistory = history.some((c) => !isFinal(c.status));
    if (open.length === 0 && !anyOpenInHistory) return;
    const t = setTimeout(async () => {
      let becameApplied = false;
      const updated = await Promise.all(trackedRef.current.map(async (c) => {
        if (isFinal(c.status)) return c;
        try {
          const fresh = await getRemoteCommand(c.command_id);
          if (fresh.status === 'APPLIED') becameApplied = true;
          return fresh;
        } catch {
          return c;
        }
      }));
      setTracked(updated);
      void loadHistory();
      void loadStatus();
      if (becameApplied) void loadCatalog(); // the shop's result has synced: show the new figures
      setNow(Date.now());
    }, 4000);
    return () => clearTimeout(t);
  }, [tracked, history, loadCatalog, loadHistory, loadStatus]);

  const selected = useMemo(() => medicines.find((m) => m.id === selectedId) || null, [medicines, selectedId]);
  const selectedBatches = useMemo(
    () => batches.filter((b) => b.medicine_id === selectedId).sort((a, b) => (a.expiry_date || '9999').localeCompare(b.expiry_date || '9999')),
    [batches, selectedId]
  );
  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? medicines.filter((m) => [m.name, m.generic_name, m.brand_name, m.barcode, m.sku].some((v) => (v || '').toLowerCase().includes(q)))
      : medicines;
    return list.slice(0, 60);
  }, [medicines, search]);

  const openCommandsFor = (medicineId: string) =>
    [...tracked, ...history].filter((c, i, all) => all.findIndex((x) => x.command_id === c.command_id) === i)
      .filter((c) => !isFinal(c.status) && c.payload?.medicine_id === medicineId);

  if (currentUser?.role !== 'ADMIN') {
    return <div className="p-6 text-sm text-rose-700">Remote administration is available to administrators only.</div>;
  }

  // ------------------------------------------------------------------ send
  const send = async () => {
    if (!draft) return;
    setSending(true);
    setSendError(null);
    try {
      const q = await queueRemoteCommand(draft.action, draft.payload, draft.requestId);
      const cmd: RemoteCommand = {
        command_id: q.command_id, command_type: q.command_type, status: q.status, payload: draft.payload,
        created_at: q.created_at, created_by: currentUser?.name || null, delivered_at: null, delivery_count: 0, acked_at: null, result: null, error: null,
      };
      setTracked((t) => [cmd, ...t.filter((x) => x.command_id !== cmd.command_id)]);
      setDraft(null);
      setForm(null);
      void loadHistory();
      void loadStatus();
    } catch (err: any) {
      setSendError(err instanceof ApiError ? err.message : 'Could not reach the online server. Nothing was queued; you can retry safely.');
    } finally {
      setSending(false);
    }
  };

  // ------------------------------------------------------------------ views
  const shopCard = (
    <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-xs">
      {status ? (
        <>
          <div className="flex items-center gap-2">
            {status.shop_in_contact ? <Wifi className="w-5 h-5 text-emerald-600" /> : <WifiOff className="w-5 h-5 text-rose-600" />}
            <div className="flex-1 min-w-0">
              <div className={`text-sm font-bold ${status.shop_in_contact ? 'text-emerald-800' : 'text-rose-800'}`}>
                {!status.shop_registered ? 'Shop not registered in the cloud' : status.shop_in_contact ? 'Shop computer is online' : 'Shop computer is NOT in contact'}
              </div>
              <div className="text-[11px] text-slate-500 truncate">
                {status.shop_name || status.shop_code || 'Shop'} · last contact {ago(status.last_shop_contact_at, now)} · last sync {ago(status.last_sync_at, now)}
              </div>
            </div>
            <button onClick={() => { void loadStatus(); void loadHistory(); }} className="p-2 rounded-lg hover:bg-slate-100" aria-label="Refresh status">
              <RefreshCw className="w-4 h-4 text-slate-500" />
            </button>
          </div>
          {!status.shop_in_contact && status.shop_registered && (
            <p className="mt-2 text-[11px] text-rose-700 bg-rose-50 border border-rose-100 rounded p-2">
              Changes you send now stay PENDING until the shop computer is on and connected to the internet. They are applied once, when it reconnects.
            </p>
          )}
          <div className="grid grid-cols-4 gap-1.5 mt-2 text-center">
            {(['pending', 'delivered', 'applied', 'rejected'] as const).map((k) => (
              <div key={k} className="rounded-lg bg-slate-50 py-1.5">
                <div className={`text-base font-bold ${k === 'rejected' && status.commands.rejected ? 'text-rose-700' : 'text-slate-800'}`}>{status.commands[k]}</div>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">{k}</div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="text-xs text-slate-500 flex items-center gap-2">
          {statusError ? <><WifiOff className="w-4 h-4 text-rose-600" /> {statusError}</> : <><Loader2 className="w-4 h-4 animate-spin" /> Checking shop status…</>}
        </div>
      )}
    </div>
  );

  const commandRow = (c: RemoteCommand) => (
    <button key={c.command_id} onClick={() => setDetail(c)} className="w-full text-left bg-white border border-slate-200 rounded-xl p-3 hover:border-teal-600">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-slate-900 truncate">
          {COMMAND_LABELS[c.command_type] || c.command_type}
          {c.payload?.quantity != null && <span className="text-slate-500 font-normal"> · qty {String(c.payload.quantity)}</span>}
        </div>
        <StatusBadge status={c.status} />
      </div>
      <div className="text-[11px] text-slate-500 mt-0.5">
        {describeRequest(c) || medicines.find((m) => m.id === c.payload?.medicine_id)?.name || ''} · sent {ago(c.created_at, now)}
        {c.created_by ? ` by ${c.created_by.replace(/\s*<.*>$/, '')}` : ''}
      </div>
      <div className="text-[11px] mt-1 text-slate-600">{STATUS_TEXT[c.status]}{c.acked_at ? ` · ${when(c.acked_at)}` : ''}</div>
      {c.status === 'APPLIED' && describeResult(c) && <div className="text-[12px] mt-1 text-emerald-800 font-medium">{describeResult(c)}</div>}
      {c.status === 'REJECTED' && c.error && <div className="text-[12px] mt-1 text-rose-800 bg-rose-50 rounded p-1.5">{c.error}</div>}
    </button>
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      <div className="px-3 pt-3 pb-2 bg-white border-b border-slate-200 shrink-0">
        <h1 className="text-base font-bold text-slate-900">Remote Admin</h1>
        <p className="text-[11px] text-slate-500">Changes are sent to the shop computer, which applies them to the shop database and syncs the result back.</p>
        <div className="flex gap-1 mt-2 bg-slate-100 p-1 rounded-lg overflow-x-auto">
          {([['medicines', 'Medicines'], ['changes', 'Activity'], ['health', 'Health'], ['alerts', 'Alerts'], ['insights', 'Reports'],
            ['staff', 'Staff'], ['security', 'Security'], ['shop', 'Settings']] as [Tab, string][]).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} className={`shrink-0 px-3 py-2 rounded-md text-xs font-semibold whitespace-nowrap ${tab === id ? 'bg-white text-teal-800 shadow-xs' : 'text-slate-600'}`}>
              {label}
              {id === 'changes' && status && status.commands.pending + status.commands.delivered > 0 ? ` (${status.commands.pending + status.commands.delivered})` : ''}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3 max-w-2xl w-full mx-auto">
        {shopCard}

        {tracked.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-bold text-slate-600 uppercase tracking-wide">Sent from this screen</div>
            {tracked.slice(0, 5).map(commandRow)}
          </div>
        )}

        {tab === 'medicines' && !selected && (
          <>
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search medicine, barcode…" className={`${inputCls} pl-9`} />
            </div>
            {loadError && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{loadError}</div>}
            {loading && medicines.length === 0 ? (
              <div className="text-xs text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading from the cloud…</div>
            ) : (
              <div className="space-y-2">
                {results.map((m) => (
                  <button key={m.id} onClick={() => setSelectedId(m.id)} className="w-full text-left bg-white border border-slate-200 rounded-xl p-3 hover:border-teal-600">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-900 truncate">{m.name}</div>
                        <div className="text-[11px] text-slate-500 truncate">{[m.dosage_strength, m.dosage_form, m.category].filter(Boolean).join(' · ')}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className={`text-sm font-bold ${m.current_stock <= 0 ? 'text-rose-700' : 'text-slate-900'}`}>{m.current_stock}</div>
                        <div className="text-[11px] text-slate-500">{cur} {Number(m.selling_price).toFixed(2)}</div>
                      </div>
                    </div>
                    {openCommandsFor(m.id).length > 0 && <div className="mt-1 text-[11px] text-amber-700 font-medium">{openCommandsFor(m.id).length} change(s) waiting for the shop</div>}
                  </button>
                ))}
                {results.length === 0 && !loading && <div className="text-xs text-slate-500 p-4 text-center">No medicines match.</div>}
              </div>
            )}
          </>
        )}

        {tab === 'medicines' && selected && (
          <div className="space-y-3">
            <button onClick={() => setSelectedId(null)} className="flex items-center gap-1 text-xs font-semibold text-teal-800">
              <ArrowLeft className="w-4 h-4" /> All medicines
            </button>
            <div className="bg-white border border-slate-200 rounded-xl p-3">
              <div className="text-base font-bold text-slate-900">{selected.name}</div>
              <div className="text-[11px] text-slate-500">{[selected.generic_name, selected.dosage_strength, selected.dosage_form, selected.category].filter(Boolean).join(' · ')}</div>
              <div className="grid grid-cols-2 gap-2 mt-2 text-xs">
                <div><span className="text-slate-500">Cloud stock</span><div className="text-lg font-bold">{selected.current_stock}</div></div>
                <div><span className="text-slate-500">Selling</span><div className="text-lg font-bold">{cur} {Number(selected.selling_price).toFixed(2)}</div></div>
                <div><span className="text-slate-500">Wholesale</span><div className="font-semibold">{selected.wholesale_price != null ? `${cur} ${Number(selected.wholesale_price).toFixed(2)}` : '—'}</div></div>
                <div><span className="text-slate-500">Min / Purchase</span><div className="font-semibold">{selected.min_selling_price ? Number(selected.min_selling_price).toFixed(2) : '—'} / {Number(selected.purchase_price).toFixed(2)}</div></div>
              </div>
              <p className="text-[10px] text-slate-400 mt-2">Cloud figures as last synced from the shop. The shop computer's own figures are the authority.</p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {([
                ['add', 'Add Stock', PackagePlus],
                ['remove', 'Remove Stock', MinusCircle],
                ['count', 'Set Physical Count', ClipboardCheck],
                ['price', 'Edit Price', Tag],
                ['details', 'Edit Medicine', Pencil],
                ['expiry', 'Edit Expiry', CalendarClock],
              ] as [ActionKind, string, any][]).map(([kind, label, Icon]) => (
                <button key={kind} onClick={() => { setSendError(null); setForm({ kind, batchId: selectedBatches[0]?.id }); }}
                  className="flex items-center gap-2 px-3 py-3 rounded-xl bg-white border border-slate-200 hover:border-teal-600 text-sm font-semibold text-slate-800">
                  <Icon className="w-4 h-4 text-teal-700" /> {label}
                </button>
              ))}
            </div>

            <div className="bg-white border border-slate-200 rounded-xl">
              <div className="px-3 py-2 text-xs font-bold text-slate-600 uppercase tracking-wide border-b border-slate-100">Batches</div>
              {selectedBatches.length === 0 && <div className="p-3 text-xs text-slate-500">No batches in the cloud copy.</div>}
              {selectedBatches.map((b) => (
                <div key={b.id} className="px-3 py-2 border-b border-slate-100 last:border-0 flex items-center justify-between text-xs">
                  <div>
                    <div className="font-mono font-semibold text-slate-800">{b.batch_number}</div>
                    <div className="text-slate-500">Expiry {b.expiry_date || 'unknown'} · {b.status}</div>
                  </div>
                  <div className="text-sm font-bold">{b.quantity_available}</div>
                </div>
              ))}
            </div>

            {openCommandsFor(selected.id).length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-bold text-amber-700 uppercase tracking-wide">Waiting for the shop</div>
                {openCommandsFor(selected.id).map(commandRow)}
              </div>
            )}
          </div>
        )}

        {tab === 'changes' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-bold text-slate-600 uppercase tracking-wide">Remote activity (tap for details)</div>
              <button onClick={() => void loadHistory()} className="text-xs font-semibold text-teal-800 flex items-center gap-1"><RefreshCw className="w-3.5 h-3.5" /> Refresh</button>
            </div>
            {history.length === 0 && <div className="text-xs text-slate-500 p-4 text-center">No remote changes yet.</div>}
            {history.map(commandRow)}
          </div>
        )}

        {tab === 'health' && <HealthTab onDraft={(d) => { setSendError(null); setDraft(d); }} />}
        {tab === 'alerts' && <AlertsTab />}
        {tab === 'insights' && <InsightsTab currency={cur} />}
        {tab === 'staff' && <StaffTab onDraft={(d) => { setSendError(null); setDraft(d); }} />}
        {tab === 'security' && <SecurityTab currentUser={currentUser} />}

        {tab === 'shop' && (
          <ShopSettingsForms settings={settings} onDraft={(d) => { setSendError(null); setDraft(d); }} />
        )}
      </div>

      {detail && <CommandDetail cmd={[...tracked, ...history].find((x) => x.command_id === detail.command_id) || detail} onClose={() => setDetail(null)} />}

      {form && selected && !draft && (
        <ActionSheet
          kind={form.kind}
          medicine={selected}
          batches={selectedBatches}
          initialBatchId={form.batchId}
          categories={categories}
          currency={cur}
          onCancel={() => setForm(null)}
          onReview={(d) => { setSendError(null); setDraft(d); }}
        />
      )}

      {draft && (
        <Sheet title="Confirm remote change" onClose={() => (sending ? null : setDraft(null))}>
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1.5 text-sm">
            {draft.lines.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3"><span className="text-slate-500">{k}</span><span className="font-semibold text-slate-900 text-right break-words">{v}</span></div>
            ))}
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            This is sent to the shop computer and applied there to the shop database. You will see PENDING, then DELIVERED, then APPLIED (or REJECTED with the reason).
            {status && !status.shop_in_contact ? ' The shop computer is not in contact right now: the change will wait until it reconnects.' : ''}
          </p>
          {sendError && <div className="mt-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{sendError}</div>}
          <div className="grid grid-cols-2 gap-2 mt-3">
            <button className={btnSecondary} disabled={sending} onClick={() => setDraft(null)}>Back</button>
            <button className={btnPrimary} disabled={sending} onClick={() => void send()}>
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Confirm
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------- sheets & forms
const ActionSheet: React.FC<{
  kind: ActionKind;
  medicine: Medicine;
  batches: MedicineBatch[];
  initialBatchId?: string;
  categories: string[];
  currency: string;
  onCancel: () => void;
  onReview: (d: Draft) => void;
}> = ({ kind, medicine, batches, initialBatchId, categories, currency, onCancel, onReview }) => {
  const [batchId, setBatchId] = useState(initialBatchId || (batches[0]?.id ?? 'NEW'));
  const [newBatch, setNewBatch] = useState('');
  const [newExpiry, setNewExpiry] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [removeReason, setRemoveReason] = useState<string>(STOCK_REMOVE_REASONS[0]);
  const [expiry, setExpiry] = useState(batches.find((b) => b.id === (initialBatchId || batches[0]?.id))?.expiry_date || '');
  const [price, setPrice] = useState({
    selling_price: String(medicine.selling_price ?? ''),
    wholesale_price: medicine.wholesale_price != null ? String(medicine.wholesale_price) : '',
    min_selling_price: medicine.min_selling_price ? String(medicine.min_selling_price) : '',
    purchase_price: String(medicine.purchase_price ?? ''),
  });
  const [details, setDetails] = useState({
    name: medicine.name || '', generic_name: medicine.generic_name || '', brand_name: medicine.brand_name || '',
    manufacturer: medicine.manufacturer || '', dosage_form: String(medicine.dosage_form || ''), dosage_strength: medicine.dosage_strength || '',
    unit: medicine.unit || '', category: medicine.category || '', description: medicine.description || '',
    prescription_required: Boolean(medicine.prescription_required),
    sku: medicine.sku || '', barcode: medicine.barcode || '', reorder_level: String(medicine.reorder_level ?? 0),
    status: (medicine.status || 'active') as string,
  });
  const [error, setError] = useState<string | null>(null);
  const batch = batches.find((b) => b.id === batchId) || null;
  const isNew = batchId === 'NEW';
  const titles: Record<ActionKind, string> = {
    add: 'Add Stock', remove: 'Remove Stock', count: 'Set Physical Count', price: 'Edit Price', details: 'Edit Medicine', expiry: 'Edit Expiry',
  };

  const wholeQty = (min: number) => {
    const n = Number(qty);
    if (!/^\d+$/.test(qty.trim()) || n < min) throw new Error(min === 0 ? 'Enter a whole number (0 or more).' : 'Enter a whole number greater than 0.');
    return n;
  };
  const money = (v: string, label: string) => {
    const n = Number(v);
    if (v.trim() === '' || !Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative amount.`);
    return Math.round(n * 100) / 100;
  };

  const review = () => {
    setError(null);
    try {
      const base: [string, string][] = [['Medicine', medicine.name]];
      const batchLine = (): [string, string] => ['Batch', isNew ? `${newBatch.trim().toUpperCase()} (new)` : `${batch?.batch_number} (cloud qty ${batch?.quantity_available})`];
      const rid = createRequestId();
      if (kind === 'add' || kind === 'count') {
        const n = wholeQty(kind === 'add' ? 1 : 0);
        if (reason.trim().length < 3) throw new Error('Give a reason (at least 3 characters).');
        if (isNew && !newBatch.trim()) throw new Error('Enter the new batch number.');
        const payload: Record<string, unknown> = { medicine_id: medicine.id, quantity: n, reason: reason.trim() };
        if (isNew) {
          payload.batch_number = newBatch.trim();
          if (kind === 'add') payload.expiry_date = newExpiry || null;
        } else payload.batch_id = batchId;
        onReview({
          action: kind === 'add' ? 'stock-add' : 'stock-set', title: titles[kind], payload, requestId: rid,
          lines: [...base, ['Current cloud quantity', String(medicine.current_stock)], batchLine(),
            ['Action', kind === 'add' ? 'ADD STOCK' : 'SET PHYSICAL COUNT'], [kind === 'add' ? 'Quantity to add' : 'Counted quantity', String(n)], ['Reason', reason.trim()],
            ...(kind === 'count' ? [['Note', 'The shop sets this batch to the count; the difference is recorded as a movement.'] as [string, string]] : [])],
        });
      } else if (kind === 'remove') {
        if (!batch) throw new Error('Choose a batch.');
        const n = wholeQty(1);
        if (n > batch.quantity_available) throw new Error(`The cloud copy shows only ${batch.quantity_available} in this batch. The shop rejects removals larger than its real quantity.`);
        if (removeReason === 'Other' && reason.trim().length < 3) throw new Error('Describe the reason.');
        onReview({
          action: 'stock-remove', title: titles.remove, requestId: rid,
          payload: { medicine_id: medicine.id, batch_id: batch.id, quantity: n, reason: removeReason, ...(reason.trim() ? { notes: reason.trim() } : {}) },
          lines: [...base, ['Current cloud quantity', String(medicine.current_stock)], batchLine(), ['Action', 'REMOVE STOCK'], ['Quantity to remove', String(n)],
            ['Reason', removeReason + (reason.trim() ? ` — ${reason.trim()}` : '')]],
        });
      } else if (kind === 'expiry') {
        if (!batch) throw new Error('Choose a batch.');
        onReview({
          action: 'batch-expiry', title: titles.expiry, requestId: rid,
          payload: { medicine_id: medicine.id, batch_id: batch.id, expiry_date: expiry || null, ...(reason.trim().length >= 3 ? { reason: reason.trim() } : {}) },
          lines: [...base, ['Batch', batch.batch_number], ['Expiry now', batch.expiry_date || 'unknown'], ['New expiry', expiry || 'unknown']],
        });
      } else if (kind === 'price') {
        const payload: Record<string, unknown> = { medicine_id: medicine.id };
        const lines: [string, string][] = [...base];
        const sp = money(price.selling_price, 'Selling price');
        if (sp !== Number(medicine.selling_price)) { payload.selling_price = sp; lines.push(['Selling price', `${Number(medicine.selling_price).toFixed(2)} → ${sp.toFixed(2)}`]); }
        const wp = price.wholesale_price.trim() === '' ? null : money(price.wholesale_price, 'Wholesale price');
        if (wp !== (medicine.wholesale_price ?? null)) { payload.wholesale_price = wp; lines.push(['Wholesale price', `${medicine.wholesale_price ?? '—'} → ${wp ?? 'none'}`]); }
        if (price.min_selling_price.trim() !== '') {
          const mp = money(price.min_selling_price, 'Minimum selling price');
          if (mp !== Number(medicine.min_selling_price || 0)) { payload.min_selling_price = mp; lines.push(['Minimum price', `${medicine.min_selling_price || '—'} → ${mp.toFixed(2)}`]); }
        }
        const pp = money(price.purchase_price, 'Purchase price');
        if (pp !== Number(medicine.purchase_price)) { payload.purchase_price = pp; lines.push(['Purchase price', `${Number(medicine.purchase_price).toFixed(2)} → ${pp.toFixed(2)}`]); }
        if (lines.length === 1) throw new Error('Nothing changed.');
        lines.push(['Currency', currency]);
        onReview({ action: 'price-update', title: titles.price, payload, lines, requestId: rid });
      } else {
        const payload: Record<string, unknown> = { medicine_id: medicine.id };
        const lines: [string, string][] = [...base];
        for (const [k, v] of Object.entries(details)) {
          const old = k === 'prescription_required' ? Boolean(medicine.prescription_required) : String((medicine as any)[k] ?? (k === 'reorder_level' ? 0 : ''));
          const val = typeof v === 'string' ? v.trim() : v;
          if (k === 'reorder_level' && !/^d+$/.test(String(val))) throw new Error('Reorder level must be a whole number.');
          if ((k === 'sku' || k === 'barcode') && val === '' && old !== '') throw new Error(`${k} cannot be cleared remotely.`);
          if (val !== old) { payload[k] = k === 'reorder_level' ? Number(val) : val; lines.push([k.replace(/_/g, ' '), `${String(old) || '—'} → ${String(val) || '—'}`]); }
        }
        if (details.name.trim() === '') throw new Error('Name cannot be empty.');
        if (lines.length === 1) throw new Error('Nothing changed.');
        onReview({ action: 'medicine-update', title: titles.details, payload, lines, requestId: rid });
      }
    } catch (err: any) {
      setError(err?.message || 'Check the form.');
    }
  };

  const batchPicker = (allowNew: boolean) => (
    <div>
      <label className={labelCls}>Batch</label>
      <select value={batchId} onChange={(e) => { setBatchId(e.target.value); setExpiry(batches.find((b) => b.id === e.target.value)?.expiry_date || ''); }} className={inputCls}>
        {batches.map((b) => <option key={b.id} value={b.id}>{b.batch_number} — qty {b.quantity_available} — exp {b.expiry_date || 'unknown'}</option>)}
        {allowNew && <option value="NEW">+ New batch…</option>}
      </select>
      {allowNew && isNew && (
        <div className="grid grid-cols-2 gap-2 mt-2">
          <input value={newBatch} onChange={(e) => setNewBatch(e.target.value)} placeholder="Batch number" className={inputCls} />
          {kind === 'add' && <input type="date" value={newExpiry} onChange={(e) => setNewExpiry(e.target.value)} className={inputCls} aria-label="Expiry date" />}
        </div>
      )}
    </div>
  );

  return (
    <Sheet title={`${titles[kind]} — ${medicine.name}`} onClose={onCancel}>
      <div className="space-y-3">
        {(kind === 'add' || kind === 'count') && (
          <>
            {batchPicker(true)}
            <div>
              <label className={labelCls}>{kind === 'add' ? 'Quantity to add' : 'Counted quantity (physical)'}</label>
              <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} className={inputCls} placeholder="0" />
            </div>
            <div>
              <label className={labelCls}>Reason</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} placeholder={kind === 'add' ? 'e.g. New delivery from supplier' : 'e.g. Shelf count by pharmacist'} />
            </div>
          </>
        )}
        {kind === 'remove' && (
          <>
            {batchPicker(false)}
            <div>
              <label className={labelCls}>Quantity to remove</label>
              <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} className={inputCls} placeholder="0" />
            </div>
            <div>
              <label className={labelCls}>Reason</label>
              <select value={removeReason} onChange={(e) => setRemoveReason(e.target.value)} className={inputCls}>
                {STOCK_REMOVE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Notes {removeReason === 'Other' ? '(required)' : '(optional)'}</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} />
            </div>
          </>
        )}
        {kind === 'expiry' && (
          <>
            {batchPicker(false)}
            <div>
              <label className={labelCls}>New expiry date (empty = unknown)</label>
              <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Reason (optional)</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} />
            </div>
          </>
        )}
        {kind === 'price' && (
          <div className="grid grid-cols-2 gap-2">
            {([['selling_price', 'Retail / selling'], ['wholesale_price', 'Wholesale (empty = none)'], ['min_selling_price', 'Minimum selling'], ['purchase_price', 'Purchase / cost']] as const).map(([k, label]) => (
              <div key={k}>
                <label className={labelCls}>{label}</label>
                <input inputMode="decimal" value={price[k]} onChange={(e) => setPrice({ ...price, [k]: e.target.value })} className={inputCls} />
              </div>
            ))}
          </div>
        )}
        {kind === 'details' && (
          <div className="space-y-2">
            {([['name', 'Name'], ['generic_name', 'Generic name'], ['brand_name', 'Brand'], ['manufacturer', 'Manufacturer'], ['dosage_form', 'Dosage form'],
              ['dosage_strength', 'Strength'], ['unit', 'Unit'], ['description', 'Description'], ['sku', 'SKU'], ['barcode', 'Barcode'],
              ['reorder_level', 'Reorder level']] as const).map(([k, label]) => (
              <div key={k}>
                <label className={labelCls}>{label}</label>
                <input value={details[k]} onChange={(e) => setDetails({ ...details, [k]: e.target.value })} className={inputCls} />
              </div>
            ))}
            <div>
              <label className={labelCls}>Category</label>
              <input list="remote-categories" value={details.category} onChange={(e) => setDetails({ ...details, category: e.target.value })} className={inputCls} />
              <datalist id="remote-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700 py-1">
              <input type="checkbox" checked={details.prescription_required} onChange={(e) => setDetails({ ...details, prescription_required: e.target.checked })} className="w-4 h-4" />
              Prescription required
            </label>
            <div>
              <label className={labelCls}>Status</label>
              <select value={details.status} onChange={(e) => setDetails({ ...details, status: e.target.value })} className={inputCls}>
                <option value="active">Active (sellable)</option>
                <option value="inactive">Inactive (hidden from POS)</option>
              </select>
            </div>
          </div>
        )}
        {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button className={btnSecondary} onClick={onCancel}>Cancel</button>
          <button className={btnPrimary} onClick={review}>Review</button>
        </div>
      </div>
    </Sheet>
  );
};

const ShopSettingsForms: React.FC<{ settings: PharmacySettings; onDraft: (d: Draft) => void }> = ({ settings, onDraft }) => {
  const [cat, setCat] = useState({ name: '', description: '' });
  const fields = ['pharmacy_name', 'tagline', 'address', 'phone', 'email', 'receipt_header', 'receipt_footer'] as const;
  const [s, setS] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f, String((settings as any)[f] ?? '')])));
  const [error, setError] = useState<string | null>(null);

  const reviewCategory = () => {
    setError(null);
    if (!cat.name.trim()) return setError('Category name is required.');
    onDraft({
      action: 'category', title: 'Category', requestId: createRequestId(),
      payload: { name: cat.name.trim(), ...(cat.description.trim() ? { description: cat.description.trim() } : {}) },
      lines: [['Action', 'ADD / UPDATE CATEGORY'], ['Name', cat.name.trim()], ['Description', cat.description.trim() || '—']],
    });
  };
  const reviewSettings = () => {
    setError(null);
    const payload: Record<string, unknown> = {};
    const lines: [string, string][] = [['Action', 'PHARMACY SETTINGS']];
    for (const f of fields) {
      const v = (s[f] || '').trim();
      if (v !== String((settings as any)[f] ?? '').trim()) { payload[f] = v; lines.push([f.replace(/_/g, ' '), v || '—']); }
    }
    if (lines.length === 1) return setError('Nothing changed.');
    if (payload.pharmacy_name === '') return setError('Pharmacy name cannot be empty.');
    onDraft({ action: 'settings', title: 'Settings', requestId: createRequestId(), payload, lines });
  };

  return (
    <div className="space-y-3">
      {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}
      <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-2">
        <div className="text-sm font-bold text-slate-900">Add / update a category</div>
        <input value={cat.name} onChange={(e) => setCat({ ...cat, name: e.target.value })} placeholder="Category name" className={inputCls} />
        <input value={cat.description} onChange={(e) => setCat({ ...cat, description: e.target.value })} placeholder="Description (optional)" className={inputCls} />
        <button className={btnPrimary} onClick={reviewCategory}>Review</button>
      </div>
      <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-2">
        <div className="text-sm font-bold text-slate-900">Pharmacy settings</div>
        {fields.map((f) => (
          <div key={f}>
            <label className={labelCls}>{f.replace(/_/g, ' ')}</label>
            <input value={s[f]} onChange={(e) => setS({ ...s, [f]: e.target.value })} className={inputCls} />
          </div>
        ))}
        <button className={btnPrimary} onClick={reviewSettings}>Review</button>
      </div>
    </div>
  );
};
