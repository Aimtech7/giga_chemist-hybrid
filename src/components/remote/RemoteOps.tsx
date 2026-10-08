import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Download, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { ApiError } from '../../services/http';
import {
  COMMAND_LABELS,
  ackAlert,
  createRequestId,
  downloadCsv,
  getAlerts,
  getInsights,
  getReport,
  getSecurity,
  getShopHealth,
  getStaff,
  revokeSessions,
  setMaintenance,
  setOnlineUserActive,
  setRemoteWrites,
  type RemoteCommand,
} from '../../services/remoteAdmin';
import {
  Pill, Row, Sheet, StatusBadge, STATUS_TEXT, ago, btnDanger, btnPrimary, btnSecondary, bytes, card, describeRequest, describeResult,
  duration, inputCls, labelCls, when, type Draft,
} from './remoteUi';
import type { User } from '../../types';

const errText = (err: any) => (err instanceof ApiError ? err.message : 'Could not reach the online server.');

function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fn());
      setError(null);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, load };
}

const Header: React.FC<{ title: string; loading?: boolean; onRefresh?: () => void; children?: React.ReactNode }> = ({ title, loading, onRefresh, children }) => (
  <div className="flex items-center justify-between gap-2">
    <div className="text-xs font-bold text-slate-600 uppercase tracking-wide">{title}</div>
    <div className="flex items-center gap-2">
      {children}
      {onRefresh && (
        <button onClick={onRefresh} className="text-xs font-semibold text-teal-800 flex items-center gap-1" aria-label={`Refresh ${title}`}>
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh
        </button>
      )}
    </div>
  </div>
);
const ErrorBox: React.FC<{ text: string | null }> = ({ text }) => (text ? <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{text}</div> : null);

// ============================================================================ HEALTH
export const HealthTab: React.FC<{ onDraft: (d: Draft) => void }> = ({ onDraft }) => {
  const { data: h, error, loading, load } = useLoad(getShopHealth);
  useEffect(() => {
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);
  if (!h) return <div className="space-y-2"><Header title="Shop computer" loading={loading} onRefresh={load} /><ErrorBox text={error} />{!error && <Loader2 className="w-5 h-5 animate-spin text-slate-400" />}</div>;
  if (h.heartbeat_supported === false || h.online === false && !h.last_heartbeat_at) {
    return <div className="space-y-2"><Header title="Shop computer" loading={loading} onRefresh={load} /><div className={card}><Pill tone="bad">NO HEARTBEAT</Pill><p className="text-sm text-slate-700 mt-2">{h.message}</p></div></div>;
  }
  const b = h.backup || {};
  const u = h.update || {};
  const backupTone = b.last_attempt_status === 'FAILED' ? 'bad' : b.last_success_at && (b.age_hours ?? 99) <= 26 ? 'ok' : 'warn';
  const freePct = h.disk?.total_bytes ? Math.round((h.disk.free_bytes / h.disk.total_bytes) * 100) : null;
  const updateAvailable = u.status === 'UPDATE_AVAILABLE' && u.available_commit;
  return (
    <div className="space-y-3">
      <Header title="Shop computer" loading={loading} onRefresh={load} />
      <ErrorBox text={error} />
      <div className={card}>
        <div className="flex items-center justify-between">
          <div className="text-base font-bold text-slate-900">Shop PC</div>
          <Pill tone={h.online ? 'ok' : 'bad'}>{h.online ? 'ONLINE' : 'OFFLINE'}</Pill>
        </div>
        <Row k="Last contact">{ago(h.last_heartbeat_at)} <span className="text-slate-400 font-normal">({when(h.last_heartbeat_at)})</span></Row>
        <Row k="PostgreSQL"><Pill tone={h.database === 'HEALTHY' ? 'ok' : 'bad'}>{h.database}</Pill></Row>
        <Row k="Sync"><Pill tone={h.sync === 'HEALTHY' ? 'ok' : 'bad'}>{h.sync}</Pill></Row>
        <Row k="Pending uploads">{h.pending_uploads ?? '—'}</Row>
        <Row k="Pending commands">{(h.commands?.pending || 0) + (h.commands?.delivered || 0)}</Row>
        <Row k="Failed events"><span className={h.failed_events ? 'text-rose-700' : ''}>{h.failed_events ?? '—'}</span></Row>
        <Row k="Last sync">{ago(h.last_sync_at)}</Row>
        <Row k="Version">{h.app_version || '—'} <span className="font-mono text-slate-400 font-normal">{h.git_commit ? h.git_commit.slice(0, 10) : ''}</span></Row>
        {!h.online && <p className="mt-2 text-[11px] text-rose-700 bg-rose-50 rounded p-2">No heartbeat for {ago(h.last_heartbeat_at)}: the shop computer is off, has no internet, or the GIGA service stopped. Remote changes wait as PENDING.</p>}
      </div>

      <div className={card}>
        <div className="text-sm font-bold text-slate-900 mb-1">Diagnostics</div>
        <Row k="Server up for">{duration(h.uptime_seconds)}</Row>
        <Row k="Last restart">{when(h.server_started_at)}</Row>
        <Row k="Restarts (1 h)"><span className={h.restarts_last_hour >= 3 ? 'text-rose-700' : ''}>{h.restarts_last_hour ?? '—'}</span></Row>
        <Row k="Disk free">{h.disk ? `${bytes(h.disk.free_bytes)} (${freePct}%)` : '—'}</Row>
        <Row k="Unacknowledged commands">{h.unacknowledged_commands ?? '—'}</Row>
        <Row k="Rejected commands">{h.commands?.rejected ?? 0}</Row>
        <Row k="Mode">{h.mode || '—'}</Row>
        {h.last_error && <div className="text-[12px] text-amber-800 bg-amber-50 rounded p-2 mt-2">Last sync error: {h.last_error}</div>}
      </div>

      <div className={card}>
        <div className="flex items-center justify-between mb-1">
          <div className="text-sm font-bold text-slate-900">Backups</div>
          <Pill tone={backupTone}>{b.last_attempt_status === 'FAILED' ? 'FAIL' : backupTone === 'ok' ? 'PASS' : b.enabled === false ? 'DISABLED' : 'STALE'}</Pill>
        </div>
        <Row k="Last backup">{when(b.last_success_at)}</Row>
        <Row k="Size">{bytes(b.last_success_size_bytes)}</Row>
        <Row k="Archive verification">{b.last_success_at ? (b.last_success_verified === false ? 'NOT VERIFIED' : 'PASS (pg_restore --list)') : '—'}</Row>
        <Row k="Next backup">{b.enabled ? when(b.next_backup_at) : 'automatic backups disabled'}</Row>
        <Row k="Retention">{b.keep ?? '—'} daily · {b.keep_weekly ?? '—'} weekly ({b.weekly_count ?? 0} kept)</Row>
        <Row k="Off-site (cloud) backup">{h.remote_backup?.enabled ? 'enabled but not implemented' : 'not configured'}</Row>
        {b.last_error && <div className="text-[12px] text-rose-800 bg-rose-50 rounded p-2 mt-2">Last error: {b.last_error}</div>}
      </div>

      <div className={card}>
        <div className="flex items-center justify-between mb-1">
          <div className="text-sm font-bold text-slate-900">Software updates</div>
          <Pill tone={updateAvailable ? 'warn' : u.status === 'NO_UPDATE' ? 'ok' : u.status ? 'muted' : 'muted'}>{u.status || 'UPDATER NOT INSTALLED'}</Pill>
        </div>
        <Row k="Installed">{u.current_version || h.app_version || '—'} <span className="font-mono text-slate-400 font-normal">{(u.current_commit || h.git_commit || '').slice(0, 10)}</span></Row>
        <Row k="Approved channel">{u.channel || 'production'}</Row>
        <Row k="Available">{u.available_commit ? <>{u.available_version || ''} <span className="font-mono">{u.available_commit.slice(0, 10)}</span></> : '—'}</Row>
        <Row k="Last check">{ago(u.checked_at)}</Row>
        {u.last_install && <Row k="Last install">{u.last_install.result} · {when(u.last_install.at)}</Row>}
        {u.message && <div className="text-[12px] text-slate-600 mt-1">{u.message}</div>}
        {updateAvailable && (
          <button className={`${btnPrimary} mt-2`} onClick={() => onDraft({
            action: 'app-update', title: 'Install update', requestId: createRequestId(), payload: { target_commit: u.available_commit },
            lines: [['Action', 'INSTALL SOFTWARE UPDATE'], ['From', `${u.current_version || ''} ${(u.current_commit || '').slice(0, 12)}`], ['To', `${u.available_version || ''} ${u.available_commit.slice(0, 12)}`],
              ['Safety', 'Verified backup first; automatic rollback if the new version is unhealthy. The POS restarts (a few minutes).']],
          })}>Install update</button>
        )}
      </div>
    </div>
  );
};

// ============================================================================ ALERTS
export const AlertsTab: React.FC = () => {
  const [all, setAll] = useState(false);
  const { data, error, loading, load } = useLoad(() => getAlerts(all), [all]);
  const [busy, setBusy] = useState<number | null>(null);
  const ack = async (id: number) => {
    setBusy(id);
    try {
      await ackAlert(id);
      await load();
    } finally {
      setBusy(null);
    }
  };
  const tone = (s: string) => (s === 'CRITICAL' ? 'bad' : s === 'WARNING' ? 'warn' : 'muted');
  return (
    <div className="space-y-2">
      <Header title={all ? 'Alert history' : 'Active alerts'} loading={loading} onRefresh={load}>
        <button className="text-xs font-semibold text-slate-600 underline" onClick={() => setAll(!all)}>{all ? 'Show active' : 'Show history'}</button>
      </Header>
      <ErrorBox text={error} />
      {data && !data.supported && <div className={card}>{data.message}</div>}
      {data?.alerts?.length === 0 && <div className="text-xs text-slate-500 p-4 text-center">No {all ? '' : 'active '}alerts.</div>}
      {data?.alerts?.map((a: any) => (
        <div key={a.id} className={card}>
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold text-slate-900 min-w-0">{a.title}</div>
            <Pill tone={a.status === 'RESOLVED' ? 'ok' : tone(a.severity) as any}>{a.status === 'ACTIVE' ? a.severity : a.status}</Pill>
          </div>
          {a.detail && <div className="text-[12px] text-slate-600 mt-1 break-words">{a.detail}</div>}
          <div className="text-[11px] text-slate-500 mt-1">
            {a.kind} · since {when(a.first_seen_at)} · last {ago(a.last_seen_at)}
            {a.acknowledged_by ? ` · ack by ${a.acknowledged_by}` : ''}{a.resolved_at ? ` · resolved ${when(a.resolved_at)}` : ''}
          </div>
          {a.status === 'ACTIVE' && (
            <button className="mt-2 text-xs font-semibold text-teal-800 flex items-center gap-1" disabled={busy === a.id} onClick={() => void ack(a.id)}>
              {busy === a.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Acknowledge
            </button>
          )}
        </div>
      ))}
    </div>
  );
};

// ============================================================================ INSIGHTS & REPORTS
const money = (v: unknown, cur: string) => `${cur} ${Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const InsightsTab: React.FC<{ currency: string }> = ({ currency }) => {
  const [range, setRange] = useState<'today' | 'week' | 'month'>('today');
  const [days, setDays] = useState(30);
  const rep = useLoad(() => getReport(range), [range]);
  const ins = useLoad(() => getInsights(days), [days]);
  const r = rep.data;
  const i = ins.data;
  const section = (title: string, rows: any[] | undefined, cols: [string, (x: any) => React.ReactNode][], file: string) => (
    <div className={card}>
      <div className="flex items-center justify-between mb-1">
        <div className="text-sm font-bold text-slate-900">{title} <span className="text-slate-400 font-normal">({rows?.length ?? 0})</span></div>
        {rows && rows.length > 0 && <button onClick={() => downloadCsv(file, rows)} className="text-xs text-teal-800 font-semibold flex items-center gap-1"><Download className="w-3.5 h-3.5" />CSV</button>}
      </div>
      {(rows || []).slice(0, 15).map((x, n) => (
        <div key={n} className="flex justify-between gap-2 text-[12px] py-1 border-b border-slate-100 last:border-0">
          <span className="min-w-0 truncate text-slate-800">{cols[0][1](x)}</span>
          <span className="shrink-0 text-right text-slate-600">{cols.slice(1).map(([k, f]) => <span key={k} className="ml-2">{f(x)}</span>)}</span>
        </div>
      ))}
      {rows && rows.length > 15 && <div className="text-[11px] text-slate-400 mt-1">+{rows.length - 15} more in the CSV</div>}
    </div>
  );
  return (
    <div className="space-y-3">
      <Header title="Sales report" loading={rep.loading} onRefresh={rep.load}>
        <select value={range} onChange={(e) => setRange(e.target.value as any)} className="text-xs border border-slate-300 rounded px-1.5 py-1 bg-white">
          <option value="today">Today</option><option value="week">This week</option><option value="month">This month</option>
        </select>
      </Header>
      <ErrorBox text={rep.error} />
      {r && (
        <div className={card}>
          <div className="grid grid-cols-2 gap-2">
            {([['Net sales', r.netSales], ['Gross profit', r.grossProfit], ['Cash', r.cash], ['M-Pesa', r.mpesa], ['Refunds', r.refunds], ['Purchases', r.purchases?.total ?? r.purchases]] as [string, any][]).map(([k, v]) => (
              <div key={k} className="rounded-lg bg-slate-50 p-2">
                <div className="text-[10px] uppercase text-slate-500">{k}</div>
                <div className="text-sm font-bold text-slate-900">{typeof v === 'number' ? money(v, currency) : '—'}</div>
              </div>
            ))}
          </div>
          <div className="text-[12px] text-slate-600 mt-2">{r.transactionCount} sales · {r.unitsSold} units · margin {r.grossMarginPercent}% · voids {r.voids?.count ?? 0}</div>
          <div className="text-[12px] text-slate-600 mt-1">Payment split: {Object.entries(r.tenders || {}).map(([k, v]) => `${k} ${money(v, currency)}`).join(' · ') || '—'}</div>
          {r.cashierStats && Object.keys(r.cashierStats).length > 0 && (
            <div className="mt-2">
              <div className="text-[11px] font-bold text-slate-500 uppercase">Cashier totals</div>
              {Object.entries(r.cashierStats as Record<string, any>).map(([name, c]) => (
                <div key={name} className="flex justify-between text-[12px]"><span>{name} ({c.count})</span><span>{money(c.net, currency)}</span></div>
              ))}
            </div>
          )}
          <div className="flex gap-2 mt-2">
            <button onClick={() => downloadCsv(`top-medicines-${range}.csv`, r.medicines || [])} className="text-xs text-teal-800 font-semibold flex items-center gap-1"><Download className="w-3.5 h-3.5" />Top medicines CSV</button>
            <button onClick={() => downloadCsv(`returns-${range}.csv`, r.returns || [])} className="text-xs text-teal-800 font-semibold flex items-center gap-1"><Download className="w-3.5 h-3.5" />Returns CSV</button>
          </div>
        </div>
      )}
      {r?.medicines && section('Top-selling medicines', r.medicines, [['name', (x) => x.name], ['qty', (x) => `${x.quantity} u`], ['rev', (x) => money(x.revenue, currency)]], `top-medicines-${range}.csv`)}

      <Header title="Inventory intelligence" loading={ins.loading} onRefresh={ins.load}>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="text-xs border border-slate-300 rounded px-1.5 py-1 bg-white">
          <option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option>
        </select>
      </Header>
      <ErrorBox text={ins.error} />
      {i && (
        <>
          <div className={card}>
            <Row k="Stock value (cost)">{money(i.totals.stock_cost_value, currency)}</Row>
            <Row k="Stock value (retail)">{money(i.totals.stock_retail_value, currency)}</Row>
            {(i.retail_vs_wholesale || []).map((s: any) => <Row key={s.mode} k={`${s.mode} sales (${i.window_days} d)`}>{s.sales} · {money(s.total, currency)} · GP {money(s.gross_profit, currency)}</Row>)}
            <p className="text-[11px] text-slate-500 mt-2">{i.method}</p>
          </div>
          {section('Out of stock', i.out_of_stock, [['name', (x) => x.name], ['sold', (x) => `${x.sold_qty} sold`]], 'out-of-stock.csv')}
          {section('Low stock', i.low_stock, [['name', (x) => x.name], ['stock', (x) => `${x.stock}/${x.reorder_level}`]], 'low-stock.csv')}
          {section('Reorder suggestions', i.reorder_suggestions, [['name', (x) => x.name], ['q', (x) => <b>suggest {x.suggested_reorder_qty}</b>], ['c', (x) => `${x.days_of_cover ?? '–'} d cover`]], 'reorder-suggestions.csv')}
          {section('Fast moving', i.fast_moving, [['name', (x) => x.name], ['r', (x) => `${x.daily_rate}/day`]], 'fast-moving.csv')}
          {section('Slow moving', i.slow_moving, [['name', (x) => x.name], ['c', (x) => `${x.days_of_cover} d cover`]], 'slow-moving.csv')}
          {section('Dead stock (no sale in 90 days)', i.dead_stock, [['name', (x) => x.name], ['v', (x) => money(x.cost_value, currency)]], 'dead-stock.csv')}
          {section('Expired (stock on hand)', i.expired, [['name', (x) => `${x.medicine_name} · ${x.batch_number}`], ['e', (x) => x.expiry_date], ['q', (x) => `${x.quantity} u`]], 'expired.csv')}
          {section('Near expiry (90 days)', i.near_expiry, [['name', (x) => `${x.medicine_name} · ${x.batch_number}`], ['e', (x) => x.expiry_date], ['q', (x) => `${x.quantity} u`]], 'near-expiry.csv')}
        </>
      )}
    </div>
  );
};

// ============================================================================ STAFF
export const StaffTab: React.FC<{ onDraft: (d: Draft) => void }> = ({ onDraft }) => {
  const { data, error, loading, load } = useLoad(getStaff);
  const [edit, setEdit] = useState<any | null>(null);
  const [reason, setReason] = useState('');
  const [role, setRole] = useState('CASHIER');
  const [err, setErr] = useState<string | null>(null);
  const staff = (data || []).filter((u: any) => u.email);
  const queue = (kind: 'active' | 'role') => {
    if (reason.trim().length < 3) return setErr('Give a reason (at least 3 characters).');
    if (kind === 'active') {
      onDraft({ action: 'user-active', title: 'Staff account', requestId: createRequestId(), payload: { user_id: edit.id, active: !edit.active, reason: reason.trim() },
        lines: [['Staff', `${edit.name} (${edit.role})`], ['Action', edit.active ? 'DEACTIVATE ACCOUNT' : 'ACTIVATE ACCOUNT'], ['Reason', reason.trim()]] });
    } else {
      if (role === edit.role) return setErr('Choose a different role.');
      onDraft({ action: 'user-role', title: 'Staff role', requestId: createRequestId(), payload: { user_id: edit.id, role, reason: reason.trim() },
        lines: [['Staff', edit.name], ['Role', `${edit.role} → ${role}`], ['Reason', reason.trim()]] });
    }
    setEdit(null);
  };
  return (
    <div className="space-y-2">
      <Header title="Shop staff (as last synced)" loading={loading} onRefresh={load} />
      <ErrorBox text={error} />
      <p className="text-[11px] text-slate-500">Changes are applied by the shop computer. The last active Administrator can never be disabled or demoted. Password / PIN resets are done on the shop computer (not remotely).</p>
      {staff.map((u: any) => (
        <button key={u.id} className={`${card} w-full text-left`} onClick={() => { setEdit(u); setReason(''); setRole(u.role === 'ADMIN' ? 'CASHIER' : 'ADMIN'); setErr(null); }}>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0"><div className="text-sm font-semibold text-slate-900 truncate">{u.name}</div><div className="text-[11px] text-slate-500 truncate">{u.email}</div></div>
            <div className="flex gap-1 shrink-0"><Pill tone="muted">{u.role}</Pill><Pill tone={u.active ? 'ok' : 'bad'}>{u.active ? 'ACTIVE' : 'DISABLED'}</Pill></div>
          </div>
        </button>
      ))}
      {edit && (
        <Sheet title={edit.name} onClose={() => setEdit(null)}>
          <div className="space-y-3">
            <div><label className={labelCls}>Reason</label><input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Staff left the pharmacy" /></div>
            <button className={edit.active ? btnDanger : btnPrimary} onClick={() => queue('active')}>{edit.active ? 'Deactivate account' : 'Activate account'}</button>
            <div className="flex gap-2 items-end">
              <div className="flex-1"><label className={labelCls}>New role</label>
                <select className={inputCls} value={role} onChange={(e) => setRole(e.target.value)}><option value="CASHIER">CASHIER</option><option value="ADMIN">ADMIN</option></select></div>
              <button className={`${btnSecondary} w-auto`} onClick={() => queue('role')}>Change role</button>
            </div>
            <ErrorBox text={err} />
          </div>
        </Sheet>
      )}
    </div>
  );
};

// ============================================================================ SECURITY
export const SecurityTab: React.FC<{ currentUser: User | null }> = ({ currentUser }) => {
  const { data, error, loading, load } = useLoad(getSecurity);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const act = async (fn: () => Promise<any>, confirmText: string) => {
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    try {
      const r = await fn();
      setNote(r?.note || 'Done.');
      await load();
    } catch (err) {
      setNote(errText(err));
    } finally {
      setBusy(false);
    }
  };
  const c = data?.controls;
  return (
    <div className="space-y-3">
      <Header title="Emergency controls" loading={loading} onRefresh={load} />
      <ErrorBox text={error} />
      {note && <div className="text-xs bg-slate-100 rounded p-2">{note}</div>}
      {c && (
        <div className={card}>
          <div className="flex items-center justify-between"><div className="text-sm font-bold flex items-center gap-1"><ShieldAlert className="w-4 h-4 text-rose-700" /> Remote business changes</div><Pill tone={c.remote_writes_enabled ? 'ok' : 'bad'}>{c.remote_writes_enabled ? 'ENABLED' : 'DISABLED'}</Pill></div>
          <p className="text-[11px] text-slate-500 my-2">Disabling immediately blocks NEW remote commands (stock, prices, staff, updates). Commands already queued still reach the shop.</p>
          <button disabled={busy} className={c.remote_writes_enabled ? btnDanger : btnPrimary}
            onClick={() => act(() => setRemoteWrites(!c.remote_writes_enabled), c.remote_writes_enabled ? 'Disable all remote changes now?' : 'Re-enable remote changes?')}>
            {c.remote_writes_enabled ? 'Disable remote changes' : 'Enable remote changes'}</button>
          <div className="flex items-center justify-between mt-4"><div className="text-sm font-bold">Maintenance mode</div><Pill tone={c.maintenance_mode ? 'warn' : 'ok'}>{c.maintenance_mode ? 'ON' : 'OFF'}</Pill></div>
          <p className="text-[11px] text-slate-500 my-2">While ON, only Administrators can use the online app. The shop POS is not affected.</p>
          {!c.maintenance_mode && <input className={`${inputCls} mb-2`} placeholder="Message for other users (optional)" value={msg} onChange={(e) => setMsg(e.target.value)} />}
          <button disabled={busy} className={btnSecondary} onClick={() => act(() => setMaintenance(!c.maintenance_mode, msg), c.maintenance_mode ? 'Turn maintenance mode OFF?' : 'Turn maintenance mode ON?')}>
            {c.maintenance_mode ? 'End maintenance' : 'Start maintenance'}</button>
        </div>
      )}
      {data?.online_users && (
        <div className={card}>
          <div className="flex items-center justify-between mb-2"><div className="text-sm font-bold">Online accounts</div>
            <button disabled={busy} className="text-xs font-semibold text-rose-700" onClick={() => act(() => revokeSessions({ all: true }), 'Sign out EVERY online account (including you) now?')}>Sign out all</button></div>
          {data.online_users.map((u: any) => (
            <div key={u.id} className="py-2 border-b border-slate-100 last:border-0">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0"><div className="text-sm font-semibold truncate">{u.name} {u.id === currentUser?.id && <span className="text-[10px] text-slate-400">(you)</span>}</div><div className="text-[11px] text-slate-500 truncate">{u.email} · last login {ago(u.last_login_at)}</div></div>
                <div className="flex gap-1 shrink-0"><Pill tone="muted">{u.role}</Pill><Pill tone={u.active ? 'ok' : 'bad'}>{u.active ? 'ACTIVE' : 'OFF'}</Pill></div>
              </div>
              <div className="flex gap-3 mt-1">
                <button disabled={busy} className="text-xs font-semibold text-teal-800" onClick={() => act(() => revokeSessions({ user_id: u.id }), `Sign out ${u.email} everywhere?`)}>Sign out sessions</button>
                <button disabled={busy} className={`text-xs font-semibold ${u.active ? 'text-rose-700' : 'text-teal-800'}`}
                  onClick={() => act(() => setOnlineUserActive(u.id, !u.active), `${u.active ? 'Deactivate' : 'Reactivate'} online account ${u.email}?`)}>{u.active ? 'Deactivate' : 'Reactivate'}</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {data?.recent_events && (
        <div className={card}>
          <div className="text-sm font-bold mb-1">Recent security / remote events</div>
          {data.recent_events.map((e: any, n: number) => (
            <div key={n} className="text-[11px] py-1 border-b border-slate-100 last:border-0 flex justify-between gap-2">
              <span className="min-w-0 truncate"><b>{e.action}</b>{e.command_type ? ` ${e.command_type}` : ''} · {e.user_email || '—'}</span><span className="shrink-0 text-slate-500">{ago(e.at)}</span>
            </div>
          ))}
        </div>
      )}
      <p className="text-[11px] text-slate-500 flex gap-1"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />Shop staff accounts (POS logins) are managed on the Staff tab; a stolen phone is handled here.</p>
    </div>
  );
};

// ============================================================================ COMMAND DETAIL
export const CommandDetail: React.FC<{ cmd: RemoteCommand; onClose: () => void }> = ({ cmd, onClose }) => {
  const res = describeResult(cmd);
  return (
    <Sheet title={COMMAND_LABELS[cmd.command_type] || cmd.command_type} onClose={onClose}>
      <div className="space-y-2">
        <div className="flex items-center justify-between"><span className="text-sm text-slate-700">{STATUS_TEXT[cmd.status]}</span><StatusBadge status={cmd.status} /></div>
        <div className="bg-slate-50 rounded-lg p-2">
          <Row k="What">{describeRequest(cmd) || '—'}</Row>
          <Row k="Requested by">{cmd.created_by || '—'}</Row>
          <Row k="Requested">{when(cmd.created_at)}</Row>
          <Row k="Delivered to shop">{cmd.delivered_at ? `${when(cmd.delivered_at)} (${cmd.delivery_count}x)` : '—'}</Row>
          <Row k={cmd.status === 'REJECTED' ? 'Rejected' : 'Applied'}>{when(cmd.acked_at)}</Row>
          {cmd.display?.cloud_stock_before !== undefined && <Row k="Cloud stock when requested">{String(cmd.display.cloud_stock_before)}</Row>}
          {cmd.payload?.reason && <Row k="Reason">{String(cmd.payload.reason)}</Row>}
          {cmd.audit_reference && <Row k="Audit reference"><span className="font-mono text-[11px]">{cmd.audit_reference}</span></Row>}
          <Row k="Command id"><span className="font-mono text-[11px]">{cmd.command_id}</span></Row>
        </div>
        {cmd.status === 'APPLIED' && res && <div className="text-sm text-emerald-800 bg-emerald-50 rounded p-2">{res}</div>}
        {cmd.status === 'REJECTED' && cmd.error && <div className="text-sm text-rose-800 bg-rose-50 rounded p-2">Reason: {cmd.error}</div>}
      </div>
    </Sheet>
  );
};
