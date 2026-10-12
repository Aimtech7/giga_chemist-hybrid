import express, { type Request, type Response, type NextFunction } from 'express';
import { HttpError } from '../db/client';
import type { HistoryScope } from '../db/history';
import { listShifts, shiftDetail, shiftMedicines, shiftOverview, shiftsCsv, type ShiftViewer } from '../db/shifts';

/**
 * CASHIER SHIFT reads, shared by the shop server (local PostgreSQL) and the online API (cloud copy):
 *
 *   GET /shifts                 shift history: filters, page, summary, per-day + per-cashier reconciliation
 *   GET /shifts/overview        dashboard cards per shop (open, left open, closed today, variance, unreviewed)
 *   GET /shifts/export          CSV of the current filters (Cash Variance / Cashier Reconciliation report)
 *   GET /shifts/:id             one shift: stored closing figures, live recount, refunds, till expenses, voids
 *   GET /shifts/:id/medicines   medicines sold during the shift (sold / returned / net)
 *
 * Who sees what (decided by the server, never by the browser):
 *   shift.view_all  (Administrator / Manager)  every shift of the authorized shop(s)
 *   shift.view_own  (Cashier)                  ONLY their own shifts; another cashier's shift answers 404
 * Cashiers never receive profit, cost or another person's variance. Writes (open / close / review /
 * correction) live on the shop server only; online review is a SHIFT_REVIEW command to the shop.
 */
export interface ShiftDeps {
  canView: (req: Request, res: Response, next: NextFunction) => unknown;
  canViewAll: (req: Request, res: Response, next: NextFunction) => unknown;
  /** Who the request may see: all shifts in scope, or only one cashier's. */
  viewer: (req: Request) => ShiftViewer;
  withScope: <T>(req: Request, fn: (scope: HistoryScope) => Promise<T>) => Promise<T>;
  send: (res: Response, err: unknown, label: string) => void;
}

const shopParam = (req: Request) => (typeof req.query.shop_id === 'string' && req.query.shop_id ? req.query.shop_id.toLowerCase() : null);

export function buildShiftRouter(deps: ShiftDeps) {
  const r = express.Router();
  const handle = (label: string, fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out);
    } catch (err) {
      deps.send(res, err, label);
    }
  };

  r.get('/shifts', deps.canView, handle('GET /shifts', (req) => deps.withScope(req, (s) => listShifts(s, req.query as any, deps.viewer(req)))));
  r.get('/shifts/overview', deps.canViewAll, handle('GET /shifts/overview', (req) => deps.withScope(req, (s) => shiftOverview(s))));
  r.get('/shifts/export', deps.canView, handle('GET /shifts/export', async (req, res) => {
    const csv = await deps.withScope(req, (s) => shiftsCsv(s, req.query as any, deps.viewer(req)));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="giga-shift-reconciliation.csv"');
    res.send(csv);
  }));
  r.get('/shifts/:id', deps.canView, handle('GET /shifts/:id', (req) => deps.withScope(req, (s) => shiftDetail(s, req.params.id, deps.viewer(req), shopParam(req)))));
  r.get('/shifts/:id/medicines', deps.canView, handle('GET /shifts/:id/medicines', (req) => deps.withScope(req, async (s) => {
    // Same visibility rule as the detail (a cashier: own shifts only), then the medicine list.
    const d = await shiftDetail(s, req.params.id, deps.viewer(req), shopParam(req));
    return shiftMedicines(s, req.params.id, d.shift.shop_id);
  })));
  return r;
}

export const shiftForbidden = () => new HttpError(403, 'Forbidden: you may only view your own shifts.');
