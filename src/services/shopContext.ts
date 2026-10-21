import { getCachedUser } from './session';

/**
 * ONLINE app only (https://gigachem.vercel.app): which shop the signed-in Administrator is looking at,
 * and what kind of online account they have. NOT authorization — the server re-checks the shop on
 * every request (X-GIGA-SHOP-ID) and answers 403 for a shop the account may not use.
 *
 * Stored in localStorage so every tab of this browser shows the SAME shop (they share one local data
 * cache); a change in one tab reloads the others. The selection belongs to the user who made it: it
 * is ignored for anyone else signing in on this browser. The local pharmacy app never sets it.
 */
export interface OnlineAccount {
  type: 'GLOBAL_ADMIN' | 'SHOP_USER';
  shop_id: string | null;
  local_user_id: string | null;
  username: string | null;
}

export interface ShopRef {
  shop_id: string;
  shop_code: string | null;
  name: string | null;
}

const SELECTED_KEY = 'giga_online_selected_shop';
const ACCOUNT_KEY = 'giga_online_account';
const LABEL_KEY = 'giga_online_current_shop';
export const SHOP_CHANGED_EVENT = 'giga:shop-changed';

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the server default shop applies */
  }
}
const currentUserId = () => getCachedUser()?.id || null;

// ---------------------------------------------------------------- account
export function setOnlineAccount(account: OnlineAccount | null | undefined): void {
  write(ACCOUNT_KEY, account ? { ...account, user_id: currentUserId() } : null);
}

export function getOnlineAccount(): OnlineAccount | null {
  const a = read<OnlineAccount & { user_id: string | null }>(ACCOUNT_KEY);
  if (a && a.user_id === currentUserId()) return a;

  // Resilient fallback: Decode server JWT payload if cached storage key is missing or desynced
  try {
    const rawToken = localStorage.getItem('giga_chemist_auth_token');
    if (rawToken) {
      const parts = rawToken.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (payload?.account_type === 'GLOBAL_ADMIN' || (payload?.role === 'ADMIN' && !payload?.shop_id)) {
          const synthesized: OnlineAccount = {
            type: 'GLOBAL_ADMIN',
            shop_id: null,
            local_user_id: payload.local_user_id ?? null,
            username: payload.username ?? null,
          };
          write(ACCOUNT_KEY, { ...synthesized, user_id: currentUserId() });
          return synthesized;
        }
      }
    }
  } catch {}

  const user = getCachedUser();
  if (user && user.role === 'ADMIN' && !(user as any).shop_id) {
    return {
      type: 'GLOBAL_ADMIN',
      shop_id: null,
      local_user_id: user.id,
      username: (user as any).username || null,
    };
  }
  return null;
}

export const isGlobalAdminAccount = (): boolean => {
  const acc = getOnlineAccount();
  if (acc?.type === 'GLOBAL_ADMIN') return true;
  const user = getCachedUser();
  return Boolean(user && user.role === 'ADMIN' && !(user as any).shop_id);
};

// ---------------------------------------------------------------- "All Shops" (Global Admin, read-only)
const SCOPE_KEY = 'giga_online_scope';
/**
 * True while a Global Administrator views ALL SHOPS: a consolidated, READ-ONLY view. Requests then
 * carry X-GIGA-SCOPE: ALL (the server refuses shop-scoped writes) and no shop's catalogue is cached.
 */
export function isAllShopsScope(): boolean {
  const s = read<{ scope: string; user_id: string | null }>(SCOPE_KEY);
  return Boolean(s && s.scope === 'ALL' && s.user_id === currentUserId() && isGlobalAdminAccount());
}
export function setAllShopsScope(on: boolean): void {
  write(SCOPE_KEY, on ? { scope: 'ALL', user_id: currentUserId() } : null);
  try {
    window.dispatchEvent(new CustomEvent(SHOP_CHANGED_EVENT));
  } catch {
    /* non-browser */
  }
}

// ---------------------------------------------------------------- selected shop
export function getSelectedShop(): ShopRef | null {
  const s = read<ShopRef & { user_id: string | null }>(SELECTED_KEY);
  return s && s.user_id === currentUserId() && s.shop_id ? s : null;
}
/** Header value for API requests (null = the server's default shop / the account's own shop). */
export function selectedShopId(): string | null {
  return getSelectedShop()?.shop_id ?? null;
}
export function setSelectedShop(shop: ShopRef | null): void {
  write(SELECTED_KEY, shop ? { shop_id: shop.shop_id, shop_code: shop.shop_code, name: shop.name, user_id: currentUserId() } : null);
  if (shop) write(SCOPE_KEY, null); // choosing a shop leaves the All Shops view
  try {
    window.dispatchEvent(new CustomEvent(SHOP_CHANGED_EVENT));
  } catch {
    /* non-browser */
  }
}

/** Name of the shop the server resolved for this browser (shown in confirmations). */
export function setCurrentShopLabel(shop: ShopRef | null): void {
  write(LABEL_KEY, shop);
}
export function currentShopLabel(): string {
  const s = read<ShopRef>(LABEL_KEY);
  if (!s) return 'the selected shop';
  return [s.name, s.shop_code ? `(${s.shop_code})` : ''].filter(Boolean).join(' ');
}

/**
 * Which shop's data this browser's cache must hold for the signed-in account: the selected shop
 * (Global Admin), else the account's own shop (shop users), else 'default' (the server's default
 * shop — and always 'default' on the single-shop local pharmacy app). Two shop users of different
 * shops therefore never share a cache key, even though neither selects a shop.
 */
export function shopCacheKey(): string {
  if (isAllShopsScope()) return 'ALL'; // never holds any one shop's catalogue
  return selectedShopId() || getOnlineAccount()?.shop_id || 'default';
}

// Another tab switched shop: reload so this tab never shows one shop's data under another's name.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if ((e.key === SELECTED_KEY || e.key === SCOPE_KEY) && e.oldValue !== e.newValue) window.location.reload();
  });
}
