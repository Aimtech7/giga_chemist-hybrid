/**
 * In-app navigation requests from screens that do not own the module state (e.g. dashboard shortcuts
 * "View All Sales" / "View Supply History"). The shop context is untouched: it lives in shopContext.
 */
export const NAVIGATE_EVENT = 'giga:navigate';

/**
 * `filters` pre-filter the target list, e.g. Daily Sold Medicines -> "View transactions":
 * navigateTo('history', 'sales', { medicine: 'Paracetamol', from: '2026-10-12', to: '2026-10-12' }).
 */
export function navigateTo(module: string, tab?: string, filters?: Record<string, string>): void {
  try {
    window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { module, tab, filters: filters || null } }));
  } catch {
    /* non-browser */
  }
}
