import express, { type Request, type Response, type NextFunction } from 'express';
import { HttpError } from '../db/client';
import { historyCsv, saleDetail, salesHistory, supplyDetail, supplyHistory, type HistoryScope } from '../db/history';

/**
 * ADMIN HISTORY endpoints, shared by the shop server (local PostgreSQL) and the online API (cloud copy):
 *
 *   GET  /history/sales               filters + page + summary (server-side; never the whole history)
 *   GET  /history/sales/:id           sale detail: items, payments, returns, void, audit
 *   POST /history/sales/:id/reprint   receipt data for a REPRINT (audited; creates nothing)
 *   GET  /history/supplies            supply / purchase history (same pattern)
 *   GET  /history/supplies/:id        purchase detail: lines, batches, stock movements
 *   GET  /history/export/:kind        CSV of the current filters (max 50,000 rows)
 *
 * Read only: no history row can be edited here. Corrections stay in their audited workflows
 * (void, return, refund; purchases: cancel while pending, never delete once received).
 * The caller supplies the authorized scope (shops) and the reprint audit; the browser never chooses
 * which shops it may see.
 */
export interface HistoryDeps {
  /** Permission check for sales history (Admin / Manager; never a cashier). */
  canSales: (req: Request, res: Response, next: NextFunction) => unknown;
  /** Permission check for supply history. */
  canSupplies: (req: Request, res: Response, next: NextFunction) => unknown;
  /** Runs fn with the request's AUTHORIZED history scope (read-only connection). */
  withScope: <T>(req: Request, fn: (scope: HistoryScope) => Promise<T>) => Promise<T>;
  /** Records a receipt reprint in the audit trail (best effort). */
  auditReprint: (req: Request, sale: { id: string; receipt_number: string; shop_id: string }) => Promise<void>;
  send: (res: Response, err: unknown, label: string) => void;
}

export function buildHistoryRouter(deps: HistoryDeps) {
  const r = express.Router();
  const handle = (label: string, fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out);
    } catch (err) {
      deps.send(res, err, label);
    }
  };

  r.get('/history/sales', deps.canSales, handle('GET /history/sales', (req) => deps.withScope(req, (s) => salesHistory(s, req.query as any))));
  r.get('/history/sales/:id', deps.canSales, handle('GET /history/sales/:id', (req) => deps.withScope(req, (s) => saleDetail(s, req.params.id))));
  r.post('/history/sales/:id/reprint', deps.canSales, handle('POST /history/sales/:id/reprint', async (req) => {
    const detail = await deps.withScope(req, (s) => saleDetail(s, req.params.id));
    await deps.auditReprint(req, { id: detail.sale.id, receipt_number: detail.sale.receipt_number, shop_id: detail.sale.shop_id });
    // The receipt is re-rendered from the stored sale: nothing is created or changed.
    return { ...detail, reprint: { copy: true, label: 'REPRINT — COPY', printed_at: new Date().toISOString() } };
  }));
  r.get('/history/supplies', deps.canSupplies, handle('GET /history/supplies', (req) => deps.withScope(req, (s) => supplyHistory(s, req.query as any))));
  r.get('/history/supplies/:id', deps.canSupplies, handle('GET /history/supplies/:id', (req) => deps.withScope(req, (s) => supplyDetail(s, req.params.id))));

  const exportCsv = (kind: 'sales' | 'supplies') => handle(`GET /history/export/${kind}`, async (req, res) => {
    const csv = await deps.withScope(req, (s) => historyCsv(s, kind, req.query as any));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="giga-${kind}-history.csv"`);
    res.send(csv);
  });
  r.get('/history/export/sales', deps.canSales, exportCsv('sales'));
  r.get('/history/export/supplies', deps.canSupplies, exportCsv('supplies'));
  r.all('/history/*', (_req, res) => res.status(405).json({ error: 'History is read only. Use void / return / refund (sales) or cancel (pending purchases).', code: 'HISTORY_READ_ONLY' }));
  return r;
}

export const historyForbidden = () => new HttpError(403, 'Forbidden: history is for Administrators and Managers.');
