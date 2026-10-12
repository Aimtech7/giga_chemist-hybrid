import React, { useEffect, useState } from 'react';
import { Store, Loader2, Globe2 } from 'lucide-react';
import { getShopHealth, getShops, type OnlineShop } from '../../services/remoteAdmin';
import { getSelectedShop, isAllShopsScope, setAllShopsScope, setCurrentShopLabel, setSelectedShop } from '../../services/shopContext';
import { purgeShopScopedCache } from '../../services/syncEngine';

/**
 * ONLINE app, Administrators only: which shop every screen and every remote change applies to.
 * A Global Administrator can switch between active shops or choose ALL SHOPS (a read-only
 * consolidated view); a shop's own Administrator sees their shop, locked. Switching empties this
 * browser's data cache and reloads, so nothing from the previous shop can be displayed under the new
 * shop's name. The server re-checks every request.
 */
const ALL = '__ALL_SHOPS__';

export const ShopSelector: React.FC = () => {
  const [shops, setShops] = useState<OnlineShop[]>([]);
  const [scope, setScope] = useState<'GLOBAL' | 'SHOP' | null>(null);
  const [current, setCurrent] = useState<OnlineShop | null>(null);
  const [switching, setSwitching] = useState(false);
  const allShops = isAllShopsScope();

  useEffect(() => {
    let alive = true;
    getShops()
      .then((d) => {
        if (!alive) return;
        setShops(d.shops);
        setScope(d.scope);
        const cur = d.shops.find((s) => s.shop_id === d.selected_shop_id) || null;
        setCurrent(cur);
        setCurrentShopLabel(cur && !isAllShopsScope() ? { shop_id: cur.shop_id, shop_code: cur.shop_code, name: cur.name } : null);
      })
      .catch(() => alive && setScope(null));
    return () => {
      alive = false;
    };
  }, []);

  if (!scope || (!current && !allShops)) return null;

  const change = async (value: string) => {
    if (value === ALL) {
      if (allShops) return;
      if (!window.confirm('Show ALL SHOPS? This is a read-only overview; open one shop to make changes.')) return;
      setSwitching(true);
      setAllShopsScope(true);
      setCurrentShopLabel(null);
    } else {
      const next = shops.find((s) => s.shop_id === value);
      if (!next || (!allShops && next.shop_id === current?.shop_id)) return;
      if (!window.confirm(`Switch to ${next.name || next.shop_code}? Every screen and every remote change will apply to that shop.`)) return;
      setSwitching(true);
      setSelectedShop({ shop_id: next.shop_id, shop_code: next.shop_code, name: next.name });
      setCurrentShopLabel({ shop_id: next.shop_id, shop_code: next.shop_code, name: next.name });
    }
    await purgeShopScopedCache().catch(() => {});
    window.location.reload();
  };

  const dot = allShops ? 'bg-sky-400' : current!.online === null ? 'bg-slate-500' : current!.online ? 'bg-emerald-400' : 'bg-rose-500';
  const status = allShops ? 'all shops' : current!.online === null ? 'no heartbeat' : current!.online ? 'online' : 'offline';
  const canSwitch = scope === 'GLOBAL' && shops.length >= 1;
  const remembered = getSelectedShop();

  return (
    <div className="flex items-center gap-1.5 min-w-0 rounded-md border border-amber-500/60 bg-amber-950/40 px-2 py-1"
      title={allShops ? 'All shops (read-only overview)' : `Current shop: ${current!.name || ''} (${current!.shop_code || ''}) — ${status}`}>
      {allShops ? <Globe2 className="w-3.5 h-3.5 text-sky-300 shrink-0" /> : <Store className="w-3.5 h-3.5 text-amber-300 shrink-0" />}
      <span className="text-[10px] uppercase tracking-wide text-amber-300/80 hidden lg:inline">Shop</span>
      {canSwitch ? (
        <select
          aria-label="Current shop"
          disabled={switching}
          value={allShops ? ALL : current!.shop_id}
          onChange={(e) => void change(e.target.value)}
          className="bg-transparent text-xs font-bold text-amber-100 max-w-[11rem] truncate focus:outline-hidden cursor-pointer"
        >
          <option value={ALL} className="text-slate-900">ALL SHOPS (overview)</option>
          {shops.map((s) => (
            <option key={s.shop_id} value={s.shop_id} className="text-slate-900">
              {s.shop_code} — {s.name}{s.online === false ? ' (offline)' : ''}
            </option>
          ))}
        </select>
      ) : (
        <span className="text-xs font-bold text-amber-100 truncate max-w-[11rem]">{current!.shop_code} — {current!.name}</span>
      )}
      {switching ? <Loader2 className="w-3 h-3 animate-spin text-amber-200" /> : <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} aria-label={status} />}
      {scope === 'GLOBAL' && !remembered && !allShops && shops.length > 1 && <span className="sr-only">default shop</span>}
    </div>
  );
};

/**
 * Prominent strip under the header (online Administrator): WHICH shop is being managed and its state,
 * e.g. "SHOP1 — Main · ONLINE · SYNC HEALTHY". In All Shops: "ALL SHOPS — read-only overview".
 */
export const ShopContextStrip: React.FC = () => {
  const [h, setH] = useState<any>(null);
  const [label, setLabel] = useState<{ code: string | null; name: string | null } | null>(null);
  const allShops = isAllShopsScope();

  useEffect(() => {
    if (allShops) return;
    let alive = true;
    const load = () => {
      getShopHealth().then((x) => alive && setH(x)).catch(() => alive && setH(null));
      getShops().then((d) => {
        const cur = d.shops.find((s) => s.shop_id === d.selected_shop_id);
        if (alive && cur) setLabel({ code: cur.shop_code, name: cur.name });
      }).catch(() => {});
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [allShops]);

  if (allShops) {
    return (
      <div className="bg-sky-900 text-sky-50 text-[11px] font-bold tracking-wide px-3 py-1 flex items-center gap-2 shrink-0">
        <Globe2 className="w-3.5 h-3.5" /> ALL SHOPS — READ-ONLY OVERVIEW · open one shop to make changes
      </div>
    );
  }
  if (!label) return null;
  const online = h?.online;
  const sync = h?.sync;
  return (
    <div className={`${online ? 'bg-emerald-900' : 'bg-rose-900'} text-white text-[11px] font-bold tracking-wide px-3 py-1 flex flex-wrap items-center gap-x-3 shrink-0`}>
      <span className="flex items-center gap-1"><Store className="w-3.5 h-3.5" /> {label.code} — {label.name}</span>
      <span>{online === undefined ? '…' : online ? 'ONLINE' : 'OFFLINE'}</span>
      {sync && <span>SYNC {sync === 'HEALTHY' ? 'HEALTHY' : 'FAILING'}</span>}
      {h?.last_sync_at && <span className="font-normal opacity-80">last sync {new Date(h.last_sync_at).toLocaleTimeString()}</span>}
    </div>
  );
};
