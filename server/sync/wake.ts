/**
 * Event-driven sync wake mechanism.
 * Decouples transaction outbox writers from the background sync worker.
 */
let wakeHandler: (() => void) | null = null;

export function registerSyncWakeHandler(handler: () => void): void {
  wakeHandler = handler;
}

export function notifySyncWake(): void {
  if (wakeHandler) {
    try {
      wakeHandler();
    } catch (err: any) {
      console.warn('[Sync] Post-commit wake trigger error:', err?.message || err);
    }
  }
}
