import express, { type Request, type Response, type NextFunction } from 'express';
import type { HistoryScope } from '../db/history';
import { expiryRisk, movementAnalysis, reorderSuggestions, stockReconciliation } from '../db/inventoryIntel';

/**
 * INVENTORY INTELLIGENCE endpoints (read only), shared by the shop server and the online API:
 *
 *   GET /inventory/insights/reorder          reorder suggestions (recommendations only)
 *   GET /inventory/insights/movement         FAST / NORMAL / SLOW / NO SALES 30 / 60 / 90
 *   GET /inventory/insights/expiry-risk      batch expiry risk (LOW / MEDIUM / HIGH / EXPIRED)
 *   GET /inventory/insights/reconciliation   ledger vs batch quantity (shop computer only)
 *
 * inventory.view (Administrator / Manager); money only for Administrators (scope.includeCost). The
 * caller's withScope decides which shops the request may read; the browser never chooses that.
 */
export interface InventoryDeps {
  canView: (req: Request, res: Response, next: NextFunction) => unknown;
  withScope: <T>(req: Request, fn: (scope: HistoryScope) => Promise<T>) => Promise<T>;
  send: (res: Response, err: unknown, label: string) => void;
}

export function buildInventoryRouter(deps: InventoryDeps) {
  const r = express.Router();
  const get = (path: string, fn: (s: HistoryScope, q: Record<string, unknown>) => Promise<unknown>) =>
    r.get(path, deps.canView, async (req: Request, res: Response) => {
      try {
        res.json(await deps.withScope(req, (s) => fn(s, req.query as Record<string, unknown>)));
      } catch (err) {
        deps.send(res, err, `GET ${path}`);
      }
    });
  get('/inventory/insights/reorder', reorderSuggestions);
  get('/inventory/insights/movement', movementAnalysis);
  get('/inventory/insights/expiry-risk', expiryRisk);
  get('/inventory/insights/reconciliation', stockReconciliation);
  return r;
}
