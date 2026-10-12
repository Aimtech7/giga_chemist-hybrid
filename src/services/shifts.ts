import { apiFetch } from './http';

/**
 * Cashier shift API (local POS server; the online app has the read endpoints only).
 * Expected cash, every total and the variance are computed by the SERVER from the transactions tagged
 * with the shift; the browser only sends the opening float, the counted cash and notes.
 */
export interface ShiftFigures {
  total_transactions: number | null;
  total_sales: number | null;
  cash_sales: number | null;
  mpesa_sales: number | null;
  card_sales: number | null;
  bank_sales: number | null;
  other_sales: number | null;
  units_sold: number | null;
  voided_count: number | null;
  voided_total: number | null;
  returns_count: number | null;
  refund_total: number | null;
  cash_refunds: number | null;
  cash_expenses: number | null;
  expected_cash: number | null;
}

export interface Shift extends ShiftFigures {
  id: string;
  shop_id: string | null;
  shop_code: string | null;
  shop_name: string | null;
  shift_number: string;
  cashier_id: string;
  cashier_name: string | null;
  device_id: string | null;
  status: 'OPEN' | 'CLOSED' | 'REVIEWED';
  opened_at: string;
  opened_business_date: string;
  opening_float: number;
  closed_at: string | null;
  closed_by_name: string | null;
  close_method: 'CASHIER' | 'ADMIN' | null;
  admin_close_reason: string | null;
  actual_cash: number | null;
  cash_variance: number | null;
  variance_status: 'BALANCED' | 'SHORT' | 'OVER' | null;
  effective_actual_cash: number | null;
  effective_variance: number | null;
  corrected: boolean;
  closing_notes: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  live: boolean;
}

export interface LiveTotals extends ShiftFigures {
  mixed_transactions: number;
  non_cash_refunds: number;
  net_sales: number;
}

export interface ShiftMedicine { medicine_id: string; name: string; quantity_sold: number; returned: number; net_sold: number }

export const getCurrentShift = () => apiFetch<{ shift: Shift | null; live?: LiveTotals }>('/api/shifts/current');
export const openShift = (opening_float: number) => apiFetch<{ created: boolean; shift: Shift; live: LiveTotals }>('/api/shifts/open', { body: { opening_float } });
export const closeShift = (id: string, body: { actual_cash: number; closing_notes?: string; expected_cash_seen?: number; admin_close_reason?: string }) =>
  apiFetch<{ success: true; shift: Shift; medicines: ShiftMedicine[] }>(`/api/shifts/${id}/close`, { body });
export const reviewShift = (id: string, notes: string) => apiFetch<any>(`/api/shifts/${id}/review`, { body: { notes } });
export const correctShift = (id: string, corrected_actual_cash: number, reason: string) =>
  apiFetch<any>(`/api/shifts/${id}/corrections`, { body: { corrected_actual_cash, reason } });
export const getShiftMedicines = (id: string, shopId?: string | null) =>
  apiFetch<{ medicines: ShiftMedicine[]; totals: { quantity_sold: number; returned: number; net_sold: number } }>(
    `/api/shifts/${id}/medicines${shopId ? `?shop_id=${encodeURIComponent(shopId)}` : ''}`);
export const getShiftDetail = (id: string, shopId?: string | null) => apiFetch<any>(`/api/shifts/${id}${shopId ? `?shop_id=${encodeURIComponent(shopId)}` : ''}`);
export const getOpenTills = () => apiFetch<{ tills: { id: string; shift_number: string; cashier_name: string | null; opened_at: string }[] }>('/api/shifts/open-tills');

export function varianceLabel(v: number | null | undefined): 'BALANCED' | 'SHORT' | 'OVER' | null {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  const c = Math.round(Number(v) * 100);
  return c === 0 ? 'BALANCED' : c < 0 ? 'SHORT' : 'OVER';
}

export const fmtMoney = (currency: string, n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `${currency} ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const fmtVariance = (currency: string, v: number | null | undefined) => {
  if (v === null || v === undefined) return '—';
  const label = varianceLabel(v);
  if (label === 'BALANCED') return `${currency} 0.00 BALANCED`;
  return `${v < 0 ? '-' : '+'} ${currency} ${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${label}`;
};

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * Printable SHIFT CLOSING REPORT (no profit / cost). `reprint` marks every copy printed after the
 * close itself clearly as a REPRINT.
 */
export function printShiftReport(shift: Shift, opts: { pharmacyName?: string; currency: string; medicines?: ShiftMedicine[]; reprint?: boolean }): boolean {
  const m = (n: number | null | undefined) => fmtMoney(opts.currency, n);
  const row = (k: string, v: string) => `<tr><td>${esc(k)}</td><td class="r">${esc(v)}</td></tr>`;
  const when = (d: string | null) => (d ? new Date(d).toLocaleString() : '—');
  const units = shift.units_sold ?? (opts.medicines || []).reduce((t, x) => t + x.quantity_sold, 0);
  const meds = (opts.medicines || []).slice(0, 40).map((x) => `<tr><td>${esc(x.name)}</td><td class="r">${x.quantity_sold}${x.returned ? ` (-${x.returned})` : ''}</td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(shift.shift_number)}</title>
<style>body{font-family:monospace;font-size:12px;width:280px;margin:8px auto;color:#000}h1,h2{text-align:center;margin:2px 0}h1{font-size:15px}h2{font-size:12px}
table{width:100%;border-collapse:collapse}td{padding:1px 0;vertical-align:top}.r{text-align:right}hr{border:0;border-top:1px dashed #000;margin:6px 0}
.big{font-weight:bold;font-size:13px}.rp{text-align:center;font-weight:bold;border:2px solid #000;padding:2px;margin:4px 0}</style></head><body>
<h1>${esc(opts.pharmacyName || 'GIGA CHEMIST')}</h1><h2>SHIFT CLOSING REPORT</h2>
${opts.reprint ? `<div class="rp">REPRINT — COPY (${esc(new Date().toLocaleString())})</div>` : ''}
<hr><table>
${row('Shop:', shift.shop_name || shift.shop_code || 'This shop')}${row('Shift:', shift.shift_number)}${row('Cashier:', shift.cashier_name || '')}
${row('Opened:', when(shift.opened_at))}${row('Closed:', when(shift.closed_at))}${shift.close_method === 'ADMIN' ? row('Closed by admin:', `${shift.closed_by_name || ''} — ${shift.admin_close_reason || ''}`) : ''}
</table><hr><table>
${row('Opening Float:', m(shift.opening_float))}${row('Cash Sales:', m(shift.cash_sales))}${row('M-Pesa:', m(shift.mpesa_sales))}${row('Card:', m(shift.card_sales))}
${row('Bank:', m(shift.bank_sales))}${shift.other_sales ? row('Other:', m(shift.other_sales)) : ''}${row('Total Sales:', m(shift.total_sales))}
${row('Returns / Refunds:', m(shift.refund_total))}${row('  of which cash:', m(shift.cash_refunds))}${row('Cash Expenses:', m(shift.cash_expenses))}
${shift.voided_count ? row('Voided:', `${shift.voided_count} (${m(shift.voided_total)})`) : ''}
</table><hr><table>
<tr class="big"><td>Expected Cash:</td><td class="r">${esc(m(shift.expected_cash))}</td></tr>
<tr class="big"><td>Actual Cash:</td><td class="r">${esc(m(shift.actual_cash))}</td></tr>
<tr class="big"><td>Variance:</td><td class="r">${esc(fmtVariance(opts.currency, shift.cash_variance))}</td></tr>
</table>${shift.closing_notes ? `<div>Notes: ${esc(shift.closing_notes)}</div>` : ''}
${shift.corrected ? `<div>Corrected count: ${esc(m(shift.effective_actual_cash))} (variance ${esc(fmtVariance(opts.currency, shift.effective_variance))})</div>` : ''}
<hr><table>${row('Transactions:', String(shift.total_transactions ?? 0))}${row('Units Sold:', String(units ?? 0))}</table>
${meds ? `<hr><b>Medicines sold</b><table>${meds}</table>` : ''}
<hr><p>Expected cash = opening float + cash sales - cash refunds - cash expenses</p>
<p><br>Cashier signature:<br><br>____________________</p><p><br>Supervisor signature:<br><br>____________________</p>
<script>window.onload=function(){window.print();}</script></body></html>`;
  const w = window.open('', '_blank', 'width=420,height=700');
  if (!w) return false; // pop-ups blocked: the caller tells the user
  w.document.open();
  w.document.write(html);
  w.document.close();
  return true;
}
