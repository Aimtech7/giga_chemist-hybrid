import React, { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import {
  CATALOG_REFRESHED_EVENT,
  CATALOG_STATE_EVENT,
  getCatalogState,
  isCatalogForCurrentShop,
  replaceCatalog,
} from '../../services/syncEngine';
import { SHOP_CHANGED_EVENT, currentShopLabel } from '../../services/shopContext';

/**
 * Shown above catalogue screens (POS, Medicines, Inventory) while the cached catalogue is NOT the
 * current shop's: loading, or an error with Retry. Screens never read another shop's snapshot
 * (they check isCatalogForCurrentShop() themselves); this only explains the empty list.
 */
export function useCatalogGate() {
  const [gate, setGate] = useState<{ ready: boolean; status: 'loading' | 'ready' | 'error'; error: string | null }>({
    ready: true,
    status: 'ready',
    error: null,
  });
  useEffect(() => {
    let alive = true;
    const check = async () => {
      const ready = await isCatalogForCurrentShop();
      const st = getCatalogState();
      if (!alive) return;
      setGate({ ready, status: ready ? 'ready' : st?.status === 'error' ? 'error' : 'loading', error: st?.status === 'error' ? st.error : null });
    };
    void check();
    const on = () => void check();
    for (const e of [CATALOG_STATE_EVENT, CATALOG_REFRESHED_EVENT, SHOP_CHANGED_EVENT]) window.addEventListener(e, on);
    return () => {
      alive = false;
      for (const e of [CATALOG_STATE_EVENT, CATALOG_REFRESHED_EVENT, SHOP_CHANGED_EVENT]) window.removeEventListener(e, on);
    };
  }, []);
  return gate;
}

export const CatalogStatusBanner: React.FC = () => {
  const gate = useCatalogGate();
  if (gate.ready) return null;
  const shop = currentShopLabel();
  if (gate.status === 'error') {
    return (
      <div role="alert" data-testid="catalog-gate" className="m-3 p-3 rounded border border-rose-200 bg-rose-50 text-rose-900 text-xs flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <span className="flex-1">
          The medicine catalogue for {shop} could not be loaded ({gate.error || 'server unavailable'}). Nothing from another shop is shown.
        </span>
        <button type="button" onClick={() => void replaceCatalog()} className="px-2 py-1 rounded bg-white border border-rose-300 font-semibold flex items-center gap-1 cursor-pointer">
          <RefreshCw className="w-3.5 h-3.5" /> Retry
        </button>
      </div>
    );
  }
  return (
    <div data-testid="catalog-gate" className="m-3 p-3 rounded border border-slate-200 bg-slate-50 text-slate-700 text-xs flex items-center gap-2">
      <Loader2 className="w-4 h-4 animate-spin shrink-0" />
      <span>Loading the medicine catalogue for {shop}…</span>
    </div>
  );
};
