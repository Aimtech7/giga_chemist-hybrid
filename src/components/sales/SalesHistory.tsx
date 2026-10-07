import React, { useState, useEffect } from 'react';
import {
  RotateCcw,
  Search,
  Printer,
  FileSpreadsheet,
  AlertTriangle,
  CheckCircle,
  Ban,
  Clock,
  Eye,
  ShieldCheck,
  Lock,
  UserCheck,
} from 'lucide-react';
import { db } from '../../db/dexie';
import { isExpired, normalizeExpiryDate } from '../../utils/expiry';
import { downloadCSV } from '../../services/exportUtils';
import { ReceiptModal } from '../pos/ReceiptModal';
import { canViewCostData, isCashier, isAdmin, isManager } from '../../services/permissions';
import type { Sale, CustomerReturn, PharmacySettings, User, SaleItem } from '../../types';
import { apiFetch } from '../../services/http';
import { applyServerStockResult, refreshCacheAfterCommit } from '../../services/stockCache';

interface SalesHistoryProps {
  currentUser: User | null;
  settings: PharmacySettings;
}

export const SalesHistory: React.FC<SalesHistoryProps> = ({ currentUser, settings }) => {
  const [sales, setSales] = useState<Sale[]>([]);
  const [search, setSearch] = useState('');
  const [selectedSaleForReceipt, setSelectedSaleForReceipt] = useState<Sale | null>(null);

  // Today Sales Summary state
  const [todaySummary, setTodaySummary] = useState<{
    totalSales: number;
    cashTotal: number;
    mpesaTotal: number;
    transactionCount: number;
    refundsTotal: number;
  }>({
    totalSales: 0,
    cashTotal: 0,
    mpesaTotal: 0,
    transactionCount: 0,
    refundsTotal: 0,
  });

  // Cashier filter mode: 'today' or 'all_mine' or 'all'
  const isCashierUser = isCashier(currentUser);
  const showCost = canViewCostData(currentUser);
  const [cashierFilterMode, setCashierFilterMode] = useState<'today' | 'all_mine'>(
    'today'
  );

  // Return modal state
  const [returnSale, setReturnSale] = useState<Sale | null>(null);
  const [selectedItemToReturn, setSelectedItemToReturn] = useState<SaleItem | null>(null);
  const [itemReturnedQtyMap, setItemReturnedQtyMap] = useState<Record<string, number>>({});
  const [isCurrentBatchExpired, setIsCurrentBatchExpired] = useState(false);
  const [returnQty, setReturnQty] = useState<number>(1);
  const [returnReason, setReturnReason] = useState<string>('');
  const [isProcessingReturn, setIsProcessingReturn] = useState(false);
  const [returnSuccess, setReturnSuccess] = useState<string | null>(null);
  const [returnError, setReturnError] = useState<string | null>(null);

  // Void modal state with Supervisor Authorization
  const [voidingSale, setVoidingSale] = useState<Sale | null>(null);
  const [voidReason, setVoidReason] = useState<string>('');
  const [supervisorError, setSupervisorError] = useState<string | null>(null);

  // Totals are aggregated by PostgreSQL (server decides Cashier vs Admin scope from the token).
  // Never summed from cached/visible Dexie rows: an unavailable server shows an error instead.
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const loadSummary = async () => {
    try {
      const data = await apiFetch<typeof todaySummary>('/api/sales/today-summary');
      setTodaySummary({
        totalSales: Number(data.totalSales) || 0,
        cashTotal: Number(data.cashTotal) || 0,
        mpesaTotal: Number(data.mpesaTotal) || 0,
        transactionCount: Number(data.transactionCount) || 0,
        refundsTotal: Number(data.refundsTotal) || 0,
      });
      setSummaryError(null);
    } catch (err: any) {
      setSummaryError(err?.message || 'Today\'s summary is unavailable.');
    }
  };

  // Server-side pagination/search over ALL sales in PostgreSQL (not the browser's cached subset).
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState({ total: 0, totalPages: 1 });
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [paymentFilter, setPaymentFilter] = useState('');
  const [priceModeFilter, setPriceModeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [cashierFilter, setCashierFilter] = useState('');
  const [cashierOptions, setCashierOptions] = useState<{ id: string; name: string }[]>([]);
  const [listNotice, setListNotice] = useState<string | null>(null);
  const nairobiToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });

  const loadSales = async () => {
    const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    let from = startDate;
    let to = endDate;
    if (isCashierUser && cashierFilterMode === 'today') from = to = nairobiToday();
    if (from) qs.set('startDate', from);
    if (to) qs.set('endDate', to);
    if (search.trim()) qs.set('search', search.trim());
    if (paymentFilter) qs.set('paymentMethod', paymentFilter);
    if (priceModeFilter) qs.set('priceMode', priceModeFilter);
    if (statusFilter) qs.set('status', statusFilter);
    if (!isCashierUser && cashierFilter) qs.set('cashierId', cashierFilter);
    try {
      const r = await apiFetch<{ sales: Sale[]; total: number; totalPages: number }>(`/api/sales?${qs}`);
      setSales(r.sales);
      setPageInfo({ total: r.total, totalPages: r.totalPages });
      setListNotice(null);
    } catch (err: any) {
      // Server unreachable: show this browser's cached recent sales, clearly marked as incomplete.
      const cached = await db.sales.reverse().sortBy('timestamp');
      setSales(cached.slice(0, PAGE_SIZE));
      setPageInfo({ total: cached.length, totalPages: 1 });
      setListNotice(`${err?.message || 'POS server unreachable.'} Showing cached recent sales only (may be incomplete).`);
    }
    await loadSummary();
  };

  useEffect(() => {
    const t = setTimeout(() => void loadSales(), search ? 350 : 0);
    return () => clearTimeout(t);
  }, [currentUser, page, search, startDate, endDate, paymentFilter, priceModeFilter, statusFilter, cashierFilter, cashierFilterMode]);

  useEffect(() => {
    setPage(1);
  }, [search, startDate, endDate, paymentFilter, priceModeFilter, statusFilter, cashierFilter, cashierFilterMode]);

  useEffect(() => {
    if (isCashierUser) return;
    apiFetch<{ id: string; name: string; role: string }[]>('/api/users')
      .then((u) => setCashierOptions(u.map((x) => ({ id: x.id, name: x.name }))))
      .catch(() => setCashierOptions([]));
  }, [currentUser]);

  const handleOpenReturn = async (s: Sale) => {
    setReturnSale(s);
    setReturnError(null);

    // Already-returned quantities come from the server (sale.returned_items); the server re-checks them.
    const qtyMap: Record<string, number> = {};
    for (const ret of s.returned_items || []) {
      const key = `${ret.medicine_id}_${ret.batch_id}`;
      // Approved AND pending-approval quantities are no longer requestable.
      qtyMap[key] = (qtyMap[key] || 0) + ret.quantity + (ret.pending || 0);
    }
    setItemReturnedQtyMap(qtyMap);

    if (s.items.length > 0) {
      await handleItemSelectFor(s.items[0], qtyMap);
    }
    setReturnReason('');
  };

  const handleItemSelectFor = async (item: SaleItem, qtyMap: Record<string, number>) => {
    setSelectedItemToReturn(item);
    const key = `${item.medicine_id}_${item.batch_id}`;
    const maxAvailable = Math.max(0, item.quantity - (qtyMap[key] || 0));
    setReturnQty(maxAvailable > 0 ? 1 : 0);

    const batch = await db.medicine_batches.get(item.batch_id);
    const expired = batch ? isExpired(batch.expiry_date) : isExpired(item.expiry_date);
    setIsCurrentBatchExpired(expired);
  };

  const handleItemSelect = (item: SaleItem) => handleItemSelectFor(item, itemReturnedQtyMap);

  // Submits a RETURN REQUEST (status PENDING). The server applies nothing until an Administrator
  // approves it in Returns: no stock, refund, movement or report change happens here.
  const handleProcessReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!returnSale || !selectedItemToReturn || !currentUser) return;
    setReturnError(null);

    const key = `${selectedItemToReturn.medicine_id}_${selectedItemToReturn.batch_id}`;
    const maxReturnable = selectedItemToReturn.quantity - (itemReturnedQtyMap[key] || 0);
    if (!Number.isInteger(returnQty) || returnQty <= 0 || returnQty > maxReturnable) {
      setReturnError(`Invalid return quantity. At most ${maxReturnable} unit(s) of this item can still be returned.`);
      return;
    }
    if (!returnReason.trim()) {
      setReturnError('A return reason is required.');
      return;
    }

    setIsProcessingReturn(true);
    try {
      const result = await apiFetch<{ return: CustomerReturn; sale: Sale }>('/api/returns', {
        body: {
          sale_id: returnSale.id,
          medicine_id: selectedItemToReturn.medicine_id,
          batch_id: selectedItemToReturn.batch_id,
          quantity: returnQty,
          reason: returnReason.trim(),
        },
      });

      // Cache the request and the sale (now showing the pending quantity); stock is untouched.
      await refreshCacheAfterCommit(async () => {
        await db.customer_returns.put(result.return);
        await db.sales.put(result.sale);
      });

      setReturnSale(null);
      setReturnSuccess(
        `Return request submitted (${returnQty}x ${selectedItemToReturn.medicine_name}) — PENDING ADMIN APPROVAL. ` +
          'Stock will not be adjusted and no refund is final until an administrator approves the return.'
      );
      setTimeout(() => setReturnSuccess(null), 8000);
      await loadSales();
    } catch (err: any) {
      setReturnError(err?.message || 'Failed to process return.');
    } finally {
      setIsProcessingReturn(false);
    }
  };

  const handleOpenVoidModal = (s: Sale) => {
    setVoidingSale(s);
    setVoidReason('');
    setSupervisorError(null);
  };

  // Void is an explicit server-side reversal (ADMIN only): the original sale is kept and marked
  // voided, its stock is restored with reverse movements, and it leaves completed revenue.
  const handleAuthorizeAndVoid = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!voidingSale || !currentUser) return;
    setSupervisorError(null);

    if (!voidReason.trim()) {
      setSupervisorError('Void justification reason is mandatory.');
      return;
    }
    if (currentUser.role !== 'ADMIN') {
      setSupervisorError('Only an Administrator can void a sale. Ask an Administrator to log in.');
      return;
    }

    try {
      const result = await apiFetch<{ sale: Sale; medicines: any[]; batches: any[] }>(
        `/api/sales/${voidingSale.id}/void`,
        { body: { void_reason: voidReason.trim() } }
      );
      const cacheWarning = await refreshCacheAfterCommit(async () => {
        await db.sales.put(result.sale);
        await applyServerStockResult({ batches: result.batches });
        for (const m of result.medicines) await applyServerStockResult({ medicine: m });
      });
      setReturnSuccess(
        `Transaction ${voidingSale.receipt_number} voided; stock restored and removed from completed revenue.` +
          (cacheWarning ? ` ${cacheWarning}` : '')
      );
      setTimeout(() => setReturnSuccess(null), 6000);
      setVoidingSale(null);
      await loadSales();
    } catch (err: any) {
      setSupervisorError(err?.message || 'Failed to void sale.');
    }
  };

  const handleExportCSV = () => {
    const headers = [
      'Sale #',
      'Receipt #',
      'Date',
      'Time',
      'Cashier',
      'Customer',
      'Total Amount',
      'Tender Method',
      'Status',
    ];
    const rows = filteredSales.map((s) => [
      s.sale_number,
      s.receipt_number,
      s.date,
      s.time,
      s.cashier_name,
      s.customer_name || 'Walk-in',
      s.total.toFixed(2),
      s.payment_method,
      s.status.toUpperCase(),
    ]);
    downloadCSV(`giga-chemist-sales-${new Date().toISOString().split('T')[0]}.csv`, headers, rows);
  };


  // Role scope and filters are applied by the server (a Cashier only ever receives own sales).
  const filteredSales = sales;

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      <div className="p-4 bg-white border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold text-slate-900 tracking-tight">
              {isCashierUser ? 'Sales History & Receipts' : 'Sales Management'}
            </h1>
            {isCashierUser && (
              <span className="px-2 py-0.5 rounded bg-teal-50 border border-teal-200 text-teal-800 text-[10px] font-semibold">
                Cashier View
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            {isCashierUser
              ? 'View completed sales tickets, reprint customer thermal receipts, and initiate returns.'
              : 'Transaction log, receipt reprinting, customer returns, and administrative voids.'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isCashierUser && (
            <div className="flex border border-slate-300 rounded overflow-hidden text-xs">
              <button
                onClick={() => setCashierFilterMode('today')}
                className={`px-2.5 py-1 font-semibold ${
                  cashierFilterMode === 'today' ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-100'
                }`}
              >
                Today's Shift
              </button>
              <button
                onClick={() => setCashierFilterMode('all_mine')}
                className={`px-2.5 py-1 font-semibold ${
                  cashierFilterMode === 'all_mine' ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-100'
                }`}
              >
                My All Sales
              </button>
            </div>
          )}

          <button
            onClick={handleExportCSV}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-medium transition cursor-pointer"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-slate-600" />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* TODAY'S SALES SUMMARY CARDS */}
      <div className="p-4 bg-white border-b border-slate-200">
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-1.5 text-xs font-bold text-slate-800 uppercase tracking-wider">
            <Clock className="w-3.5 h-3.5 text-teal-600" />
            <span>{isCashierUser ? "Today's Shift Summary" : "Today's Pharmacy Sales Summary"}</span>
          </div>
          <span className="text-[11px] font-mono text-slate-500">
            {new Date().toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
          </span>
        </div>

        {summaryError && (
          <div className="mb-2.5 px-3 py-2 rounded border border-rose-200 bg-rose-50 text-xs text-rose-800">
            Summary unavailable — figures below are not current. {summaryError}
          </div>
        )}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Card 1: Today's Total Sales */}
          <div className="p-3.5 rounded border border-teal-200 bg-teal-50/60 flex flex-col justify-between shadow-2xs">
            <span className="text-[10px] font-bold uppercase tracking-wider text-teal-800">
              Today's Sales
            </span>
            <div className="text-xl font-black font-mono text-teal-950 mt-1">
              {settings.currency} {todaySummary.totalSales.toFixed(2)}
            </div>
            <span className="text-[10px] text-teal-700 mt-0.5">Net completed revenue</span>
          </div>

          {/* Card 2: Cash Total */}
          <div className="p-3.5 rounded border border-emerald-200 bg-emerald-50/60 flex flex-col justify-between shadow-2xs">
            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-800">
              Cash
            </span>
            <div className="text-xl font-black font-mono text-emerald-950 mt-1">
              {settings.currency} {todaySummary.cashTotal.toFixed(2)}
            </div>
            <span className="text-[10px] text-emerald-700 mt-0.5">Physical cash drawer</span>
          </div>

          {/* Card 3: M-Pesa Total */}
          <div className="p-3.5 rounded border border-sky-200 bg-sky-50/60 flex flex-col justify-between shadow-2xs">
            <span className="text-[10px] font-bold uppercase tracking-wider text-sky-800">
              M-Pesa
            </span>
            <div className="text-xl font-black font-mono text-sky-950 mt-1">
              {settings.currency} {todaySummary.mpesaTotal.toFixed(2)}
            </div>
            <span className="text-[10px] text-sky-700 mt-0.5">Mobile money till</span>
          </div>

          {/* Card 4: Transactions */}
          <div className="p-3.5 rounded border border-slate-200 bg-slate-50 flex flex-col justify-between shadow-2xs">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-700">
              Transactions
            </span>
            <div className="text-xl font-black font-mono text-slate-900 mt-1">
              {todaySummary.transactionCount}
            </div>
            <span className="text-[10px] text-slate-500 mt-0.5">Completed tickets</span>
          </div>
        </div>
      </div>

      {returnSuccess && (
        <div className="mx-4 mt-3 p-3 bg-emerald-50 border border-emerald-300 text-emerald-800 rounded text-xs flex items-center gap-2 animate-fadeIn">
          <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{returnSuccess}</span>
        </div>
      )}

      {/* Search Bar */}
      <div className="p-3 bg-white border-b border-slate-200 flex items-center justify-between gap-2 text-xs shrink-0">
        <div className="relative w-full max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search receipt #, customer, M-Pesa ref..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
          />
        </div>
        <div className="text-slate-500 font-medium">{pageInfo.total} transactions</div>
      </div>

      <div className="px-3 py-2 bg-white border-b border-slate-200 flex flex-wrap items-center gap-2 text-xs shrink-0">
        {!(isCashierUser && cashierFilterMode === 'today') && (
          <>
            <label className="flex items-center gap-1">From <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="border border-slate-300 rounded px-1.5 py-1" /></label>
            <label className="flex items-center gap-1">To <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="border border-slate-300 rounded px-1.5 py-1" /></label>
          </>
        )}
        <select value={paymentFilter} onChange={(e) => setPaymentFilter(e.target.value)} className="border border-slate-300 rounded px-1.5 py-1" aria-label="Payment method">
          <option value="">All payments</option>
          <option value="Cash">Cash</option>
          <option value="M-Pesa">M-Pesa</option>
          <option value="Mixed">Mixed</option>
          <option value="Card">Card</option>
          <option value="Bank">Bank</option>
        </select>
        <select value={priceModeFilter} onChange={(e) => setPriceModeFilter(e.target.value)} className="border border-slate-300 rounded px-1.5 py-1" aria-label="Price mode">
          <option value="">Retail &amp; Wholesale</option>
          <option value="RETAIL">Retail</option>
          <option value="WHOLESALE">Wholesale</option>
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border border-slate-300 rounded px-1.5 py-1" aria-label="Status">
          <option value="">All statuses</option>
          <option value="not_voided">Not voided</option>
          <option value="completed">Completed</option>
          <option value="partially_returned">Partially returned</option>
          <option value="returned">Returned</option>
          <option value="voided">Voided</option>
        </select>
        {!isCashierUser && (
          <select value={cashierFilter} onChange={(e) => setCashierFilter(e.target.value)} className="border border-slate-300 rounded px-1.5 py-1" aria-label="Cashier">
            <option value="">All cashiers</option>
            {cashierOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="px-2 py-1 border border-slate-300 rounded disabled:opacity-40 cursor-pointer">‹ Prev</button>
          <span className="text-slate-600">Page {page} of {pageInfo.totalPages}</span>
          <button type="button" disabled={page >= pageInfo.totalPages} onClick={() => setPage(page + 1)} className="px-2 py-1 border border-slate-300 rounded disabled:opacity-40 cursor-pointer">Next ›</button>
        </div>
      </div>
      {listNotice && <div className="mx-4 mt-2 p-2 rounded border border-amber-300 bg-amber-50 text-amber-800 text-xs">{listNotice}</div>}

      {/* Sales Table */}
      <div className="flex-1 overflow-auto p-4">
        <div className="bg-white rounded border border-slate-200 overflow-hidden">
          <table className="w-full text-left text-xs text-slate-700">
            <thead className="bg-slate-50 text-slate-600 uppercase font-semibold text-[10px] tracking-wider border-b border-slate-200">
              <tr>
                <th className="py-2.5 px-3 font-mono">Receipt #</th>
                <th className="py-2.5 px-3">Date / Time</th>
                {!isCashierUser && <th className="py-2.5 px-3">Cashier</th>}
                <th className="py-2.5 px-3">Customer</th>
                <th className="py-2.5 px-3">Items Dispensed</th>
                <th className="py-2.5 px-3 text-right">Subtotal</th>
                <th className="py-2.5 px-3 text-right">Discount</th>
                <th className="py-2.5 px-3 text-right">Total Amount</th>
                <th className="py-2.5 px-3">Tender Method</th>
                <th className="py-2.5 px-3 text-center">Status</th>
                <th className="py-2.5 px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredSales.length === 0 ? (
                <tr>
                  <td colSpan={isCashierUser ? 10 : 11} className="py-12 text-center text-slate-400">
                    No sales records match your criteria.
                  </td>
                </tr>
              ) : (
                filteredSales.map((s) => {
                  const saleSubtotal = s.subtotal || s.total;
                  const discountAmt = s.discount_total || 0;
                  const discountPct = s.discount_percent || 0;

                  return (
                    <tr key={s.id} className="hover:bg-slate-50 transition">
                      <td className="py-2 px-3 font-mono font-bold text-slate-900">
                        {s.receipt_number}
                        {s.price_mode === 'WHOLESALE' && (
                          <span className="ml-1.5 align-middle text-[9px] px-1.5 py-0.5 rounded bg-amber-600 text-white font-bold uppercase tracking-wider">
                            Wholesale
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 font-mono text-[11px] text-slate-600">
                        {s.date} {s.time}
                      </td>
                      {!isCashierUser && <td className="py-2 px-3 text-slate-800">{s.cashier_name}</td>}
                      <td className="py-2 px-3 text-slate-800">{s.customer_name || 'Walk-in'}</td>
                      <td className="py-2 px-3 text-slate-600 max-w-xs truncate">
                        {/* Price actually charged at the time of sale (stored on the sale line). */}
                        {s.items
                          .map((i) => `${i.quantity}x ${i.medicine_name} @ ${settings.currency} ${i.unit_price.toFixed(2)}${i.price_mode === 'WHOLESALE' ? ' (WS)' : ''}`)
                          .join(', ')}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-slate-600">
                        {settings.currency} {saleSubtotal.toFixed(2)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono">
                        {discountAmt > 0 ? (
                          <span className="text-emerald-700 font-semibold">
                            -{settings.currency} {discountAmt.toFixed(2)}
                            {discountPct > 0 && <span className="text-[10px] text-emerald-600 block">({discountPct}%)</span>}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right font-mono font-bold text-slate-900">
                        {settings.currency} {s.total.toFixed(2)}
                      </td>
                      <td className="py-2 px-3 font-medium">
                        <span>{s.payment_method}</span>
                        {s.payment_reference && (
                          <div className="text-[10px] text-slate-400 font-mono">{s.payment_reference}</div>
                        )}
                      </td>
                      <td className="py-2 px-3 text-center">
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              s.status === 'completed'
                                ? 'bg-emerald-600'
                                : s.status === 'returned'
                                ? 'bg-amber-600'
                                : s.status === 'voided'
                                ? 'bg-rose-600'
                                : 'bg-slate-400'
                            }`}
                          />
                          <span className="capitalize text-slate-700">{s.status}</span>
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => setSelectedSaleForReceipt(s)}
                            className="p-1 rounded border border-slate-200 hover:bg-slate-100 text-slate-700 transition cursor-pointer"
                            title="Reprint Thermal Receipt"
                          >
                            <Printer className="w-3.5 h-3.5" />
                          </button>

                          {(s.status === 'completed' || s.status === 'partially_returned') && (
                            <button
                              onClick={() => handleOpenReturn(s)}
                              className="p-1 rounded border border-slate-200 hover:bg-amber-50 text-amber-700 transition cursor-pointer"
                              title="Process Return"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </button>
                          )}

                          {s.status === 'completed' && currentUser?.role === 'ADMIN' && (
                            <button
                              onClick={() => handleOpenVoidModal(s)}
                              className="p-1 rounded border border-rose-200 hover:bg-rose-50 text-rose-600 transition cursor-pointer"
                              title="Void Transaction (Administrator)"
                            >
                              <Ban className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* RETURN MODAL */}
      {returnSale && selectedItemToReturn && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="w-full max-w-md bg-white rounded border border-slate-300 shadow-lg overflow-hidden text-slate-800">
            <div className="bg-slate-900 px-4 py-3 text-white flex justify-between items-center">
              <span className="font-bold text-xs">
                Request Return: Receipt {returnSale.receipt_number}
              </span>
              <button onClick={() => setReturnSale(null)} className="text-slate-400 hover:text-white p-1 rounded cursor-pointer">
                &times;
              </button>
            </div>

            <form onSubmit={handleProcessReturn} className="p-4 space-y-3 text-xs">

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Select Item to Return</label>
                <select
                  value={`${selectedItemToReturn.medicine_id}_${selectedItemToReturn.batch_id}`}
                  onChange={(e) => {
                    const it = returnSale.items.find((x) => `${x.medicine_id}_${x.batch_id}` === e.target.value);
                    if (it) {
                      handleItemSelect(it);
                    }
                  }}
                  className="w-full p-2 border border-slate-300 rounded bg-white focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                >
                  {returnSale.items.map((it, idx) => {
                    const key = `${it.medicine_id}_${it.batch_id}`;
                    const returned = itemReturnedQtyMap[key] || 0;
                    const remaining = Math.max(0, it.quantity - returned);
                    return (
                      <option key={idx} value={key} disabled={remaining === 0}>
                        {it.medicine_name} (Batch: {it.batch_number}, Sold: {it.quantity}x, Returnable: {remaining}x)
                      </option>
                    );
                  })}
                </select>
              </div>

              {isCurrentBatchExpired && (
                <div className="p-2 rounded bg-amber-50 border border-amber-200 text-amber-800 text-[11px] flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                  <span>
                    Batch {selectedItemToReturn.batch_number} has expired. The administrator will not be able to return it to sellable stock.
                  </span>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div>
                  {(() => {
                    const key = `${selectedItemToReturn.medicine_id}_${selectedItemToReturn.batch_id}`;
                    const returned = itemReturnedQtyMap[key] || 0;
                    const maxReturnable = Math.max(0, selectedItemToReturn.quantity - returned);
                    return (
                      <>
                        <label className="block font-semibold text-slate-700 mb-1">
                          Return Quantity (Max: {maxReturnable}) *
                        </label>
                        <input
                          type="number"
                          min="1"
                          max={maxReturnable}
                          value={returnQty}
                          disabled={maxReturnable <= 0}
                          onChange={(e) => setReturnQty(Math.min(maxReturnable, Math.max(1, parseInt(e.target.value) || 1)))}
                          className="w-full p-2 border border-slate-300 rounded font-mono font-bold focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden disabled:bg-slate-100"
                        />
                      </>
                    );
                  })()}
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Requested Refund (price paid, after discount)</label>
                  <div className="p-2 border border-slate-200 bg-slate-50 rounded font-mono font-bold text-slate-900">
                    {settings.currency}{' '}
                    {((selectedItemToReturn.total / selectedItemToReturn.quantity) * returnQty).toFixed(2)}
                  </div>
                </div>
              </div>

              <div className="p-2 rounded bg-sky-50 border border-sky-200 text-sky-900 text-[11px]">
                This creates a <strong>return request</strong> for administrator approval. Nothing is returned to stock and no refund is final until an administrator approves it.
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Return Reason / Justification *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Physician adjusted prescription dosage"
                  value={returnReason}
                  onChange={(e) => setReturnReason(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                />
              </div>

              {returnError && (
                <div className="p-2 rounded bg-rose-50 border border-rose-200 text-rose-800 text-[11px] flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-rose-600 shrink-0" />
                  <span>{returnError}</span>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setReturnSale(null)}
                  className="px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isProcessingReturn}
                  className="px-4 py-1.5 rounded bg-teal-700 hover:bg-teal-800 text-white font-semibold transition cursor-pointer"
                >
                  {isProcessingReturn ? 'Submitting...' : 'Submit Return Request'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* SUPERVISOR-PROTECTED VOID MODAL */}
      {voidingSale && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="w-full max-w-md bg-white rounded border border-slate-300 shadow-lg overflow-hidden text-slate-800">
            <div className="bg-slate-900 px-4 py-3 text-white flex justify-between items-center">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-rose-400" />
                <span className="font-bold text-xs uppercase tracking-wider">
                  Void Sale — Administrator
                </span>
              </div>
              <button onClick={() => setVoidingSale(null)} className="text-slate-400 hover:text-white p-1 rounded cursor-pointer">
                &times;
              </button>
            </div>

            <form onSubmit={handleAuthorizeAndVoid} className="p-4 space-y-3 text-xs">

              <div className="p-3 bg-rose-50 border border-rose-200 rounded text-rose-800">
                <p className="font-semibold">The sale is kept and marked VOIDED; its stock is restored and it leaves completed revenue.</p>
                <p className="text-[11px] mt-1">
                  Receipt: <strong>{voidingSale.receipt_number}</strong> | Amount: {settings.currency} {voidingSale.total.toFixed(2)}
                </p>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Mandatory Void Justification Reason *
                </label>
                <textarea
                  required
                  rows={2}
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  placeholder="e.g. Accidental double tender or incorrect payment method"
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                />
              </div>

              {supervisorError && (
                <div className="p-2 rounded bg-rose-50 border border-rose-200 text-rose-800 text-[11px] flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-rose-600 shrink-0" />
                  <span>{supervisorError}</span>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setVoidingSale(null)}
                  className="px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded bg-rose-700 hover:bg-rose-800 text-white font-semibold transition cursor-pointer"
                >
                  Authorize &amp; Void Transaction
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* REPRINT RECEIPT MODAL */}
      <ReceiptModal
        isOpen={!!selectedSaleForReceipt}
        onClose={() => setSelectedSaleForReceipt(null)}
        sale={selectedSaleForReceipt}
        settings={settings}
      />
    </div>
  );
};
