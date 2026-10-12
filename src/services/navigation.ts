/**
 * In-app navigation requests from screens that do not own the module state (e.g. dashboard shortcuts
 * "View All Sales" / "View Supply History"). The shop context is untouched: it lives in shopContext.
 */
export const NAVIGATE_EVENT = 'giga:navigate';

export function navigateTo(module: string, tab?: string): void {
  try {
    window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { module, tab } }));
  } catch {
    /* non-browser */
  }
}
