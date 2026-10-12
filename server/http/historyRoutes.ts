import express, { type Request, type Response, type NextFunction } from 'express';
import { HttpError } from '../db/client';
import { historyCsv, saleDetail, salesHistory, soldMedicines, supplyDetail, supplyHistory, type HistoryScope } from '../db/history';
import { stockHistory, stockHistoryCsv, stockHistoryDetail } from '../db/stockHistory';

/**
 * ADMIN HISTORY endpoints, shared by the shop server (local PostgreSQL) and the online API (cloud copy):
 *
 *   GET  /history/sales               filters + page + summary (server-side; never the whole history)
 *   GET  /history/sales/:id           sale detail: items, payments, returns, void, audit
 *   POST /history/sales/:id/reprint   receipt data for a REPRINT (audited; creates nothing)
 *   GET  /history/supplies            supply / purchase history (same pattern)
 *   GET  /history/supplies/:id        purchase detail: lines, batches, stock movements
 *   GET  /history/export/:kind        CSV of the current filters (max 50,000 rows)
 *   GET  /history/stock               DAILY STOCK HISTORY: per day + medicine opening / sold / returned /
 *                                     received / adjustments / closing from the movement ledger
 *   GET  /history/stock/:medicineId   one medicine on one day: batches + movement timeline
 *   GET  /history/export/stock        CSV of the stock history filters
 *   GET  /history/sold                SOLD MEDICINES of one business date (POS "Today's Sold Medicines"):
 *                                     every stock-history role; other dates + money for Administrators only
 *
 * Stock History has its OWN permission (history.stock.view): a cashier may read it (quantities only,
 * own shop) without gaining sales history, supply history, costs or any write.
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
  /** Permission check for stock history (history.stock.view: Administrator, Manager AND Cashier). */
  canStockHistory: (req: Request, res: Response, next: NextFunction) => unknown;
  /** Permission check for the stock history CSV export (Administrator / Manager). */
  canStockExport: (req: Request, res: Response, next: NextFunction) => unknown;
  /** True when the caller may look at another business date than today (sales.view_all). */
  mayPickSoldDate: (req: Request) => boolean;
  /** Runs fn with the request's AUTHORIZED history scope (read-only connection). */
  withScope: <T>(req: Request, fn: (scope: HistoryScope) => Promise<T>) => Promise<T>;
  /** Records a receipt reprint in the audit trail (best effort). */
  auditReprint: (req: Request, sale: { id: string; receipt_number: string; shop_id: string }) => Promise<void>;
  send: (res: Response, err: unknown, label: string) => void;
}

/** The shop a detail request expects (All Shops: the row's shop); verified against the sale and the scope. */
const shopParam = (req: Request) => (typeof req.query.shop_id === 'string' && req.query.shop_id ? req.query.shop_id.toLowerCase() : null);

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
  r.get('/history/sales/:id', deps.canSales, handle('GET /history/sales/:id', (req) => deps.withScope(req, (s) => saleDetail(s, req.params.id, shopParam(req)))));
  r.post('/history/sales/:id/reprint', deps.canSales, handle('POST /history/sales/:id/reprint', async (req) => {
    const detail = await deps.withScope(req, (s) => saleDetail(s, req.params.id, shopParam(req)));
    await deps.auditReprint(req, { id: detail.sale.id, receipt_number: detail.sale.receipt_number, shop_id: detail.sale.shop_id });
    // The receipt is re-rendered from the stored sale: nothing is created or changed.
    return { ...detail, reprint: { copy: true, label: 'REPRINT — COPY', printed_at: new Date().toISOString() } };
  }));
  r.get('/history/supplies', deps.canSupplies, handle('GET /history/supplies', (req) => deps.withScope(req, (s) => supplyHistory(s, req.query as any))));
  r.get('/history/supplies/:id', deps.canSupplies, handle('GET /history/supplies/:id', (req) => deps.withScope(req, (s) => supplyDetail(s, req.params.id))));
  r.get('/history/stock', deps.canStockHistory, handle('GET /history/stock', (req) => deps.withScope(req, (s) => stockHistory(s, req.query as any))));
  r.get('/history/stock/:medicineId', deps.canStockHistory, handle('GET /history/stock/:medicineId',
    (req) => deps.withScope(req, (s) => stockHistoryDetail(s, req.params.medicineId, req.query as any))));

  r.get('/history/sold', deps.canStockHistory, handle('GET /history/sold',
    (req) => deps.withScope(req, (s) => soldMedicines(s, req.query as any, { allowDate: deps.mayPickSoldDate(req) }))));

  const exportCsv = (kind: 'sales' | 'supplies') => handle(`GET /history/export/${kind}`, async (req, res) => {
    const csv = await deps.withScope(req, (s) => historyCsv(s, kind, req.query as any));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="giga-${kind}-history.csv"`);
    res.send(csv);
  });
  r.get('/history/export/sales', deps.canSales, exportCsv('sales'));
  r.get('/history/export/supplies', deps.canSupplies, exportCsv('supplies'));
  r.get('/history/export/stock', deps.canStockHistory, deps.canStockExport, handle('GET /history/export/stock', async (req, res) => {
    const csv = await deps.withScope(req, (s) => stockHistoryCsv(s, req.query as any));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="giga-daily-stock-history.csv"');
    res.send(csv);
  }));
  r.all('/history/*', (_req, res) => res.status(405).json({ error: 'History is read only. Use void / return / refund (sales) or cancel (pending purchases).', code: 'HISTORY_READ_ONLY' }));
  return r;
}

export const historyForbidden = () => new HttpError(403, 'Forbidden: history is for Administrators and Managers.');
