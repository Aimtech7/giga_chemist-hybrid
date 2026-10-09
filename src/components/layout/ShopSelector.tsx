import React, { useEffect, useState } from 'react';
import { Store, Loader2 } from 'lucide-react';
import { getShops, type OnlineShop } from '../../services/remoteAdmin';
import { getSelectedShop, setCurrentShopLabel, setSelectedShop } from '../../services/shopContext';
import { purgeShopScopedCache } from '../../services/syncEngine';

/**
 * ONLINE app, Administrators only: which shop every screen and every remote change applies to.
 * A Global Administrator can switch between active shops; a shop's own Administrator sees their
 * shop, locked. Switching empties this browser's data cache and reloads, so nothing from the
 * previous shop can be displayed under the new shop's name. The server re-checks every request.
 */
export const ShopSelector: React.FC = () => {
  const [shops, setShops] = useState<OnlineShop[]>([]);
  const [scope, setScope] = useState<'GLOBAL' | 'SHOP' | null>(null);
  const [current, setCurrent] = useState<OnlineShop | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let alive = true;
    getShops()
      .then((d) => {
        if (!alive) return;
        setShops(d.shops);
        setScope(d.scope);
        const cur = d.shops.find((s) => s.shop_id === d.selected_shop_id) || null;
        setCurrent(cur);
        setCurrentShopLabel(cur ? { shop_id: cur.shop_id, shop_code: cur.shop_code, name: cur.name } : null);
      })
      .catch(() => alive && setScope(null));
    return () => {
      alive = false;
    };
  }, []);

  if (!scope || !current) return null;

  const change = async (shopId: string) => {
    const next = shops.find((s) => s.shop_id === shopId);
    if (!next || next.shop_id === current.shop_id) return;
    if (!window.confirm(`Switch to ${next.name || next.shop_code}? Every screen and every remote change will apply to that shop.`)) return;
    setSwitching(true);
    setSelectedShop({ shop_id: next.shop_id, shop_code: next.shop_code, name: next.name });
    setCurrentShopLabel({ shop_id: next.shop_id, shop_code: next.shop_code, name: next.name });
    await purgeShopScopedCache().catch(() => {});
    window.location.reload();
  };

  const dot = current.online === null ? 'bg-slate-500' : current.online ? 'bg-emerald-400' : 'bg-rose-500';
  const status = current.online === null ? 'no heartbeat' : current.online ? 'online' : 'offline';
  const canSwitch = scope === 'GLOBAL' && shops.length > 1;
  const remembered = getSelectedShop();

  return (
    <div className="flex items-center gap-1.5 min-w-0 rounded-md border border-amber-500/60 bg-amber-950/40 px-2 py-1" title={`Current shop: ${current.name || ''} (${current.shop_code || ''}) — ${status}`}>
      <Store className="w-3.5 h-3.5 text-amber-300 shrink-0" />
      <span className="text-[10px] uppercase tracking-wide text-amber-300/80 hidden lg:inline">Shop</span>
      {canSwitch ? (
        <select
          aria-label="Current shop"
          disabled={switching}
          value={current.shop_id}
          onChange={(e) => void change(e.target.value)}
          className="bg-transparent text-xs font-bold text-amber-100 max-w-[11rem] truncate focus:outline-hidden cursor-pointer"
        >
          {shops.map((s) => (
            <option key={s.shop_id} value={s.shop_id} className="text-slate-900">
              {s.shop_code} — {s.name}{s.online === false ? ' (offline)' : ''}
            </option>
          ))}
        </select>
      ) : (
        <span className="text-xs font-bold text-amber-100 truncate max-w-[11rem]">{current.shop_code} — {current.name}</span>
      )}
      {switching ? <Loader2 className="w-3 h-3 animate-spin text-amber-200" /> : <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} aria-label={status} />}
      {scope === 'GLOBAL' && !remembered && shops.length > 1 && <span className="sr-only">default shop</span>}
    </div>
  );
};
