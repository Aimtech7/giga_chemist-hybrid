import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, Database, Loader2, RefreshCw, Store, Wifi, WifiOff } from 'lucide-react';
import { getOverview, type Overview, type ShopOverview } from '../../services/remoteAdmin';
import { setCurrentShopLabel, setSelectedShop } from '../../services/shopContext';
import { purgeShopScopedCache } from '../../services/syncEngine';
import { ago, Pill } from './remoteUi';
import { apiFetch } from '../../services/http';
import { navigateTo } from '../../services/navigation';
import type { PharmacySettings } from '../../types';

/**
 * GIGA CHEMIST — GLOBAL CONTROL CENTER (online app, "All Shops", Global Administrator).
 * Per-shop health and business figures from the cloud copy, plus consolidated totals. READ-ONLY:
 * every change is made after opening one shop ("Manage"), never from this consolidated view.
 */
export const GlobalControlCenter: React.FC<{ settings: PharmacySettings; focusShopId?: string | null }> = ({ settings, focusShopId }) => {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const cur = settings.currency || 'KES';
  const money = (n: number) => `${cur} ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getOverview());
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load the overview.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const manage = async (s: ShopOverview) => {
    if (!window.confirm(`Open ${s.name || s.shop_code}? Every screen and every change will apply to that shop.`)) return;
    setSelectedShop({ shop_id: s.shop_id, shop_code: s.shop_code, name: s.name });
    setCurrentShopLabel({ shop_id: s.shop_id, shop_code: s.shop_code, name: s.name });
    await purgeShopScopedCache().catch(() => {});
    window.location.reload();
  };

  const shops = (data?.shops || []).filter((s) => !focusShopId || s.shop_id === focusShopId);
  const t = data?.totals || {};

  const stat = (label: string, value: React.ReactNode, tone?: 'bad' | 'warn', onClick?: () => void) => (
    <div
      onClick={onClick}
      className={`rounded-lg bg-slate-50 px-2 py-1.5 ${onClick ? 'cursor-pointer hover:bg-slate-100 transition' : ''}`}
    >
      <div className={`text-sm font-bold ${tone === 'bad' ? 'text-rose-700' : tone === 'warn' ? 'text-amber-700' : 'text-slate-900'}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
    </div>
  );

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50">
      <div className="max-w-5xl mx-auto p-3 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-black tracking-tight text-slate-900">GIGA CHEMIST — {focusShopId ? 'SHOP DASHBOARD' : 'GLOBAL CONTROL CENTER'}</h1>
            <p className="text-[11px] text-slate-500">
              {focusShopId ? 'The selected shop only.' : 'All shops, read-only. Open one shop to make changes.'} Figures come from the cloud copy each shop syncs.
              {data ? ` Updated ${ago(data.generated_at)}.` : ''}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={() => navigateTo('history', 'sales')} className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold">View All Sales</button>
            <button onClick={() => navigateTo('history', 'supplies')} className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold">View Supply History</button>
            <button onClick={() => void load()} className="p-2 rounded-lg hover:bg-white" aria-label="Refresh">
              <RefreshCw className={`w-4 h-4 text-slate-500 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
        {error && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</div>}
        {!data && !error && <div className="text-xs text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading shops…</div>}

        {data && !focusShopId && data.shops.length > 1 && (
          <div className="bg-slate-900 text-white rounded-xl p-3">
            <div className="text-[10px] uppercase tracking-widest text-teal-300 font-bold mb-2">All shops — consolidated</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 text-center">
              {([
                ['Shops online', `${t.shops_online ?? 0} / ${t.shops ?? 0}`],
                ['Sales today', money(t.sales_today_total)],
                ['Receipts today', String(t.sales_today_count ?? 0)],
                ['Stock value (cost)', money(t.stock_cost_value)],
                ['Low / out', `${t.low_stock ?? 0} / ${t.out_of_stock ?? 0}`],
                ['Expiring 30 d', String(t.expiring_30d ?? 0)],
                ['Pending / rejected', `${t.pending_commands ?? 0} / ${t.rejected_commands_7d ?? 0}`],
              ] as [string, string][]).map(([k, v]) => (
                <div
                  key={k}
                  onClick={k.includes('rejected') ? () => navigateTo('sync') : undefined}
                  className={`rounded-lg bg-slate-800 py-2 ${k.includes('rejected') ? 'cursor-pointer hover:bg-slate-700 transition' : ''}`}
                >
                  <div className="text-sm font-bold">{v}</div>
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">{k}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className={`grid gap-3 ${focusShopId ? '' : 'md:grid-cols-2'}`}>
          {shops.map((s) => (
            <div key={s.shop_id} className={`bg-white rounded-xl border-2 p-3 ${s.online ? 'border-emerald-300' : 'border-rose-300'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Store className="w-5 h-5 text-amber-600 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-base font-black text-slate-900 truncate">{s.shop_code} — {s.name}</div>
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      <Pill tone={s.online ? 'ok' : 'bad'}>{s.online ? <span className="inline-flex items-center gap-1"><Wifi className="w-3 h-3" /> ONLINE</span> : <span className="inline-flex items-center gap-1"><WifiOff className="w-3 h-3" /> OFFLINE</span>}</Pill>
                      <Pill tone={s.db_healthy === null ? 'muted' : s.db_healthy ? 'ok' : 'bad'}><span className="inline-flex items-center gap-1"><Database className="w-3 h-3" /> DB {s.db_healthy === null ? '?' : s.db_healthy ? 'OK' : 'DOWN'}</span></Pill>
                      <Pill tone={s.sync_healthy === null ? 'muted' : s.sync_healthy ? 'ok' : 'bad'}>SYNC {s.sync_healthy === null ? '?' : s.sync_healthy ? 'HEALTHY' : 'FAILING'}</Pill>
                    </div>
                  </div>
                </div>
                {!focusShopId && (
                  <button onClick={() => void manage(s)} className="flex items-center gap-1 px-3 py-2 rounded-lg bg-teal-700 text-white text-xs font-bold shrink-0">
                    Manage <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {s.error ? (
                <div className="mt-2 text-xs text-rose-700 bg-rose-50 rounded p-2 flex gap-1"><AlertTriangle className="w-4 h-4" /> {s.error}</div>
              ) : (
                <>
                  <div className="text-[11px] text-slate-500 mt-1">
                    Heartbeat {ago(s.last_heartbeat_at)} · last sync {ago(s.last_sync_at)}{s.app_version ? ` · v${s.app_version}` : ''}{s.git_commit ? ` (${s.git_commit.slice(0, 7)})` : ''}
                  </div>
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5 mt-2 text-center">
                    {stat('Sales today', money(s.sales_today.total))}
                    {stat('Receipts', s.sales_today.count)}
                    {stat('Stock units', s.stock_units.toLocaleString())}
                    {stat('Stock value', money(s.stock_cost_value))}
                    {stat('Catalogue', `${s.catalogue.total} (${s.catalogue.active} active)`)}
                    {stat('Low stock', s.low_stock, s.low_stock ? 'warn' : undefined)}
                    {stat('Out of stock', s.out_of_stock, s.out_of_stock ? 'bad' : undefined)}
                    {stat('Expiring 30 d', s.expiring_30d, s.expiring_30d ? 'warn' : undefined)}
                    {stat('Active staff', s.active_staff)}
                    {stat('Pending cmds', s.pending_commands, s.pending_commands ? 'warn' : undefined)}
                    {stat('Rejected 7 d', s.rejected_commands_7d, s.rejected_commands_7d ? 'bad' : undefined, () => navigateTo('sync'))}
                    {stat('Expired w/ stock', s.expired_with_stock, s.expired_with_stock ? 'bad' : undefined)}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
        <ShiftOverviewPanel cur={cur} focusShopId={focusShopId} />
        {focusShopId !== undefined && <RecentActivity money={money} />}
      </div>
    </div>
  );
};

/**
 * Cashier shifts per shop (cloud copy): open shifts, shifts left open from a previous business day,
 * closed today, cash variance today, closed shifts with an unreviewed variance. Physical cash of two
 * shops is never added into one drawer: every figure stays on its own shop's card.
 */
export const ShiftOverviewPanel: React.FC<{ cur: string; focusShopId?: string | null }> = ({ cur, focusShopId }) => {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () => apiFetch<any>('/api/shifts/overview').then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e?.status === 404 ? null : e?.message || 'Shift overview unavailable.'));
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  if (error) return <div className="text-xs text-slate-500">Cashier shifts: {error}</div>;
  if (!data) return null;
  const shops = (data.shops || []).filter((s: any) => !focusShopId || s.shop_id === focusShopId);
  const flagged = (data.flagged || []).filter((f: any) => !focusShopId || f.shop_id === focusShopId);
  const v = (n: number) => {
    const c = Math.round(Number(n || 0) * 100);
    return { text: `${c < 0 ? '-' : c > 0 ? '+' : ''}${cur} ${Math.abs(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`, cls: c < 0 ? 'text-rose-700' : c > 0 ? 'text-amber-700' : 'text-emerald-700' };
  };
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold text-slate-900">Cashier shifts — {data.business_date}</div>
        <button onClick={() => navigateTo('history', 'shifts')} className="text-xs font-semibold text-teal-800">Shift history →</button>
      </div>
      <div className={`grid gap-2 ${shops.length > 1 ? 'md:grid-cols-2' : ''}`}>
        {shops.map((s: any) => (
          <div key={s.shop_id} className="rounded-lg bg-slate-50 p-2">
            <div className="text-xs font-black text-slate-800 mb-1">{s.shop_code} — {s.shop_name}</div>
            <div className="grid grid-cols-5 gap-1 text-center">
              {([
                ['Open', s.open_shifts, s.open_shifts ? 'text-sky-700' : 'text-slate-900'],
                ['Left open', s.open_from_previous_day, s.open_from_previous_day ? 'text-rose-700' : 'text-slate-900'],
                ['Closed today', s.closed_today, 'text-slate-900'],
                ['Variance today', v(s.variance_today).text, v(s.variance_today).cls],
                ['Unreviewed', s.unreviewed_variances, s.unreviewed_variances ? 'text-amber-700' : 'text-slate-900'],
              ] as [string, React.ReactNode, string][]).map(([k, val, cls]) => (
                <div key={k} className="rounded bg-white py-1"><div className={`text-sm font-bold ${cls}`}>{val}</div><div className="text-[9px] uppercase tracking-wide text-slate-500">{k}</div></div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {flagged.length > 0 && (
        <div className="text-xs">
          <div className="font-semibold text-slate-700 mb-0.5">Needs attention</div>
          {flagged.slice(0, 8).map((f: any) => (
            <div key={`${f.shop_id}-${f.id}`} className="flex justify-between gap-2 py-0.5 border-t border-slate-100">
              <span className="truncate">
                <b className={f.flag === 'SHIFT_SHORTAGE' || f.flag === 'SHIFT_LEFT_OPEN' ? 'text-rose-700' : 'text-amber-700'}>{f.flag.replace('SHIFT_', '').replace('_', ' ')}</b>
                {' '}· {f.shop_code} · {f.cashier_name || 'cashier'} · {f.shift_number}
              </span>
              <span className="shrink-0">{f.flag === 'SHIFT_LEFT_OPEN' ? `opened ${String(f.opened_business_date).slice(0, 10)}` : v(f.cash_variance).text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/** Shop dashboard: the latest sales and supplies of the selected shop, with a link to the full history. */
const RecentActivity: React.FC<{ money: (n: number) => string }> = ({ money }) => {
  const [sales, setSales] = useState<any[] | null>(null);
  const [supplies, setSupplies] = useState<any[] | null>(null);
  useEffect(() => {
    // Last 30 days only: the summary over a whole multi-year history is not needed for "recent".
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    apiFetch<any>(`/api/history/sales?page_size=25&from=${from}`).then((d) => setSales(d.rows.slice(0, 6))).catch(() => setSales([]));
    apiFetch<any>(`/api/history/supplies?page_size=25&from=${from}`).then((d) => setSupplies(d.rows.slice(0, 6))).catch(() => setSupplies([]));
  }, []);
  const box = (title: string, tab: string, rows: any[] | null, line: (r: any) => React.ReactNode) => (
    <div className="bg-white rounded-xl border border-slate-200 p-3">
      <div className="flex items-center justify-between mb-1">
        <div className="text-sm font-bold text-slate-900">{title}</div>
        <button onClick={() => navigateTo('history', tab)} className="text-xs font-semibold text-teal-800">View full history →</button>
      </div>
      {rows === null ? <div className="text-xs text-slate-500">Loading…</div> : rows.length === 0 ? <div className="text-xs text-slate-500">Nothing in the last 30 days.</div>
        : rows.map((r) => <div key={r.id} className="text-xs py-1 border-t border-slate-100 first:border-0 flex justify-between gap-2">{line(r)}</div>)}
    </div>
  );
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {box('Recent sales', 'sales', sales, (r) => (<><span className="truncate">{r.date} {r.time?.slice(0, 5)} · {r.receipt_number} · {r.cashier_name || ''}</span><span className="font-semibold">{money(r.total)}</span></>))}
      {box('Recent supplies', 'supplies', supplies, (r) => (<><span className="truncate">{r.received_date || r.order_date} · {r.order_number} · {r.supplier_name || ''}</span><span className="font-semibold">{money(r.total_amount)}</span></>))}
    </div>
  );
};

/** Shown for a shop-specific module while "All Shops" is selected (that view is read-only). */
export const SelectShopPrompt: React.FC<{ settings: PharmacySettings; module: string }> = ({ settings, module }) => (
  <div className="flex-1 overflow-y-auto bg-slate-50">
    <div className="max-w-3xl mx-auto p-4 space-y-3">
      <div className="bg-amber-50 border-2 border-amber-400 rounded-xl p-3 text-sm text-amber-900">
        <b>{module}</b> belongs to one shop. "All Shops" is a read-only overview: choose a shop below (or in the header) to manage it.
      </div>
      <GlobalControlCenter settings={settings} />
    </div>
  </div>
);
