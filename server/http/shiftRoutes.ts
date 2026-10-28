import express, { type Request, type Response, type NextFunction } from 'express';
import { HttpError } from '../db/client';
import type { HistoryScope } from '../db/history';
import { listShifts, shiftDetail, shiftMedicines, shiftOverview, shiftsCsv, type ShiftViewer } from '../db/shifts';

/**
 * CASHIER SHIFT reads, shared by the shop server (local PostgreSQL) and the online API (cloud copy):
 *
 *   GET /shifts/current         the caller's own open shift + live totals (cloud: from giga_cloud.cashier_shifts)
 *   GET /shifts                 shift history: filters, page, summary, per-day + per-cashier reconciliation
 *   GET /shifts/overview        dashboard cards per shop (open, left open, closed today, variance, unreviewed)
 *   GET /shifts/export          CSV of the current filters (Cash Variance / Cashier Reconciliation report)
 *   GET /shifts/:id             one shift: stored closing figures, live recount, refunds, till expenses, voids
 *   GET /shifts/:id/medicines   medicines sold during the shift (sold / returned / net)
 *
 * IMPORTANT: /shifts/current MUST be registered BEFORE /shifts/:id so Express never matches
 * the literal string "current" as a shift UUID (which would throw "Shift id must be a UUID.").
 * Static routes (/shifts/overview, /shifts/export, /shifts/current) always precede parameterised
 * routes (/shifts/:id, /shifts/:id/medicines) for the same reason.
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
  /**
   * Optional: resolves the caller's own open shift for GET /shifts/current.
   *
   * When provided the route returns its result directly (used by the online API to query
   * giga_cloud.cashier_shifts for the cashier's local_user_id and req.shopId).
   *
   * When absent the route answers { shift: null }. The local shop server registers its own
   * /shifts/current BEFORE calling r.use(buildShiftRouter(…)), so this path is never reached
   * by the local API; supplying the handler here protects the online API which mounts the shared
   * router without a preceding local override.
   */
  getCurrentShift?: (req: Request) => Promise<{ shift: Record<string, unknown> | null; live?: Record<string, unknown> }>;
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

  // --- STATIC ROUTES (must precede parameterised routes) -----------------------------------------

  /**
   * GET /shifts/current — the caller's own open shift with live totals.
   *
   * For the online API this queries giga_cloud.cashier_shifts using the cashier's local_user_id and
   * the authorized shop (req.shopId). For the local shop server this is never reached because the
   * local routes.ts registers its own /shifts/current before r.use(buildShiftRouter(…)).
   *
   * Returns { shift: null } when no open shift exists — never throws "Shift id must be a UUID."
   * because it does not pass "current" through the UUID-validated shiftDetail() path.
   */
  r.get('/shifts/current', deps.canView, handle('GET /shifts/current', async (req) => {
    if (deps.getCurrentShift) return deps.getCurrentShift(req);
    // Safety net: local server should never reach here, but respond gracefully anyway.
    return { shift: null };
  }));

  r.get('/shifts', deps.canView, handle('GET /shifts', (req) => deps.withScope(req, (s) => listShifts(s, req.query as any, deps.viewer(req)))));
  r.get('/shifts/overview', deps.canViewAll, handle('GET /shifts/overview', (req) => deps.withScope(req, (s) => shiftOverview(s))));
  r.get('/shifts/export', deps.canView, handle('GET /shifts/export', async (req, res) => {
    const csv = await deps.withScope(req, (s) => shiftsCsv(s, req.query as any, deps.viewer(req)));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="giga-shift-reconciliation.csv"');
    res.send(csv);
  }));

  // --- PARAMETERISED ROUTES (after all static routes) --------------------------------------------

  r.get('/shifts/:id', deps.canView, handle('GET /shifts/:id', (req) => deps.withScope(req, (s) => shiftDetail(s, req.params.id, deps.viewer(req), shopParam(req)))));
  r.get('/shifts/:id/medicines', deps.canView, handle('GET /shifts/:id/medicines', (req) => deps.withScope(req, async (s) => {
    // Same visibility rule as the detail (a cashier: own shifts only), then the medicine list.
    const d = await shiftDetail(s, req.params.id, deps.viewer(req), shopParam(req));
    return shiftMedicines(s, req.params.id, d.shift.shop_id);
  })));
  return r;
}

export const shiftForbidden = () => new HttpError(403, 'Forbidden: you may only view your own shifts.');
