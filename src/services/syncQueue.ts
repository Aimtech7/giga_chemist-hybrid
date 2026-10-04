/**
 * CANONICAL SYNC ADAPTER (Consolidated into syncEngine.ts)
 * Re-exports the unified canonical sync engine functions.
 */
export {
  enqueueSyncItem,
  getPendingCount,
  refreshPendingCount,
  runSync,
  subscribeToSyncStatus,
} from './syncEngine';

import { runSync } from './syncEngine';

/**
 * Legacy processSyncQueue alias routing to canonical runSync
 */
export async function processSyncQueue(): Promise<{ processed: number; errors: number }> {
  const success = await runSync();
  return { processed: success ? 1 : 0, errors: success ? 0 : 1 };
}
