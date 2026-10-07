import React, { useState, useEffect } from 'react';
import {
  BarChart3,
  Calendar,
  FileSpreadsheet,
  TrendingUp,
  DollarSign,
  Download,
  Boxes,
  Users,
  CreditCard,
  Pill,
  RotateCcw,
  Receipt,
  ArrowDownRight,
  TrendingDown,
} from 'lucide-react';
import { apiFetch } from '../../services/http';
import { downloadCSV } from '../../services/exportUtils';
import type { Sale, PharmacySettings, User } from '../../types';

interface ServerReport {
  range: string;
  start: string;
  end: string;
  today: string;
  grossSales: number;
  discounts: number;
  refunds: number;
  refundCount: number;
  netSales: number;
  cash: number;
  mpesa: number;
  tenders: Record<string, number>;
  voids: { count: number; total: number };
  transactionCount: number;
  unitsSold: number;
  unitsReturned: number;
  netCogs: number;
  grossProfit: number;
  grossMarginPercent: number;
  operatingExpenses: number;
  netProfit: number;
  netMarginPercent: number;
  purchases: { count: number; total: number };
  expenses: any[];
  expenseCategoryStats: Record<string, number>;
  cashierStats: Record<string, { count: number; gross: number; refunds: number; net: number; profit: number }>;
  medicines: { name: string; quantity: number; revenue: number; profit: number }[];
  returns: any[];
  stock: { totalMedicines: number; inStock: number; lowStock: number; outOfStock: number };
}

interface ReportsDashboardProps {
  currentUser: User | null;
  settings: PharmacySettings;
}

type ReportTab = 'summary' | 'sales' | 'returns' | 'expenses' | 'medicines' | 'cashiers' | 'tenders';

export const ReportsDashboard: React.FC<ReportsDashboardProps> = ({ currentUser, settings }) => {
  // All totals come from PostgreSQL (GET /api/reports/summary) over the FULL history, on
  // Africa/Nairobi business days — never from the browser's cached sales.
  const [dateRange, setDateRange] = useState<'today' | 'week' | 'month' | 'custom'>('month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [activeTab, setActiveTab] = useState<ReportTab>('summary');
  const [report, setReport] = useState<ServerReport | null>(null);
  const [filteredSales, setFilteredSales] = useState<Sale[]>([]);
  const [salesTotal, setSalesTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (dateRange === 'custom' && (!customStart || !customEnd)) return;
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const qs = dateRange === 'custom' ? `range=custom&start=${customStart}&end=${customEnd}` : `range=${dateRange}`;
        const r = await apiFetch<ServerReport>(`/api/reports/summary?${qs}`);
        const page = await apiFetch<{ sales: Sale[]; total: number }>(
          `/api/sales?page=1&limit=200&status=not_voided&startDate=${r.start}&endDate=${r.end}`
        );
        if (!alive) return;
        setReport(r);
        setFilteredSales(page.sales);
        setSalesTotal(page.total);
        setError(null);
      } catch (err: any) {
        if (alive) setError(err?.message || 'Report unavailable: the POS server could not be reached.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [dateRange, customStart, customEnd]);

  const todayStr = report?.today || new Date().toISOString().split('T')[0];
  const grossSales = report?.grossSales || 0;
  const totalRefunds = report?.refunds || 0;
  const netSales = report?.netSales || 0;
  const netCogs = report?.netCogs || 0;
  const grossProfit = report?.grossProfit || 0;
  const operatingExpenses = report?.operatingExpenses || 0;
  const netProfit = report?.netProfit || 0;
  const grossMarginPercent = report?.grossMarginPercent || 0;
  const netMarginPercent = report?.netMarginPercent || 0;
  const cashierStats = report?.cashierStats || {};
  const sortedMeds = report?.medicines || [];
  const tenderStats: Record<string, number> = report?.tenders || { Cash: 0, 'M-Pesa': 0, Card: 0, Bank: 0 };
  const expenseCategoryStats = report?.expenseCategoryStats || {};
  const filteredReturns = (report?.returns || []) as any[];
  const filteredExpenses = (report?.expenses || []) as any[];
  void currentUser;

  const handleExportCSV = () => {
    if (activeTab === 'medicines') {
      const headers = ['Medicine Name', 'Net Units Sold', 'Net Revenue (KES)', 'Gross Profit (KES)'];
      const rows = sortedMeds.map((m) => [m.name, m.quantity, m.revenue.toFixed(2), m.profit.toFixed(2)]);
      downloadCSV(`giga-chemist-medicine-velocity-${dateRange}-${todayStr}.csv`, headers, rows);
    } else if (activeTab === 'cashiers') {
      const headers = ['Cashier Name', 'Transactions Count', 'Gross Sales (KES)', 'Refunds (KES)', 'Net Sales (KES)', 'Profit (KES)'];
      const rows = Object.entries(cashierStats).map(([name, stat]) => [
        name,
        stat.count,
        stat.gross.toFixed(2),
        stat.refunds.toFixed(2),
        stat.net.toFixed(2),
        stat.profit.toFixed(2),
      ]);
      downloadCSV(`giga-chemist-cashier-performance-${dateRange}-${todayStr}.csv`, headers, rows);
    } else if (activeTab === 'returns') {
      const headers = ['Receipt #', 'Date', 'Medicine', 'Batch', 'Qty Returned', 'Refund Paid', 'Reason', 'Action'];
      const rows = filteredReturns.map((r) => [
        r.receipt_number,
        r.date,
        r.medicine_name,
        r.batch_number,
        r.quantity,
        r.refund_amount.toFixed(2),
        r.reason,
        r.action,
      ]);
      downloadCSV(`giga-chemist-returns-report-${dateRange}-${todayStr}.csv`, headers, rows);
    } else if (activeTab === 'expenses') {
      const headers = ['Date', 'Category', 'Description', 'Payment Method', 'Amount (KES)', 'Recorded By'];
      const rows = filteredExpenses.map((e) => [
        e.date,
        e.category,
        e.description,
        e.payment_method,
        e.amount.toFixed(2),
        e.user_name,
      ]);
      downloadCSV(`giga-chemist-expenses-report-${dateRange}-${todayStr}.csv`, headers, rows);
    } else {
      const headers = ['Receipt #', 'Date', 'Cashier', 'Customer', 'Status', 'Tender', 'Cost (COGS)', 'Gross Total', 'Profit'];
      const rows = filteredSales.map((s) => [
        s.receipt_number,
        `${s.date} ${s.time}`,
        s.cashier_name,
        s.customer_name || 'Walk-in',
        s.status,
        s.payment_method,
        s.cost_total?.toFixed(2) || '0.00',
        s.total.toFixed(2),
        s.gross_profit?.toFixed(2) || '0.00',
      ]);
      downloadCSV(`giga-chemist-sales-report-${dateRange}-${todayStr}.csv`, headers, rows);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      {/* Top Header */}
      <div className="p-4 bg-white border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 shrink-0">
        <div>
          <h1 className="text-base font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <span>Financial &amp; Management Reports</span>
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Real-time Gross Sales, Returns, Net Revenue, COGS, Gross Profit, Operating Expenses, and Net Profit.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Date range selector */}
          <div className="flex border border-slate-300 rounded overflow-hidden text-xs">
            <button
              onClick={() => setDateRange('today')}
              className={`px-3 py-1 font-semibold ${
                dateRange === 'today' ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-100'
              }`}
            >
              Today
            </button>
            <button
              onClick={() => setDateRange('week')}
              className={`px-3 py-1 font-semibold ${
                dateRange === 'week' ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-100'
              }`}
            >
              This Week
            </button>
            <button
              onClick={() => setDateRange('month')}
              className={`px-3 py-1 font-semibold ${
                dateRange === 'month' ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-100'
              }`}
            >
              This Month
            </button>
            <button
              onClick={() => setDateRange('custom')}
              className={`px-3 py-1 font-semibold ${
                dateRange === 'custom' ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-100'
              }`}
            >
              Custom
            </button>
          </div>

          {dateRange === 'custom' && (
            <div className="flex items-center gap-1 text-xs">
              <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="border border-slate-300 rounded px-1.5 py-1" />
              <span>to</span>
              <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} className="border border-slate-300 rounded px-1.5 py-1" />
            </div>
          )}

          <button
            onClick={handleExportCSV}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold cursor-pointer transition"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 text-[11px] text-slate-600 flex flex-wrap gap-x-4 gap-y-1 shrink-0">
        <span>Period: <b>{report ? `${report.start} → ${report.end}` : '—'}</b> (Africa/Nairobi business days, all history from PostgreSQL)</span>
        {loading && <span className="text-teal-700 font-semibold">Loading…</span>}
        {error && <span className="text-rose-700 font-semibold">{error}</span>}
        {report && (
          <>
            <span>Cash <b>{settings.currency} {report.cash.toFixed(2)}</b></span>
            <span>M-Pesa <b>{settings.currency} {report.mpesa.toFixed(2)}</b></span>
            <span>Discounts <b>{settings.currency} {report.discounts.toFixed(2)}</b></span>
            <span>Voids <b>{report.voids.count}</b> ({settings.currency} {report.voids.total.toFixed(2)})</span>
            <span>Purchases <b>{report.purchases.count}</b> ({settings.currency} {report.purchases.total.toFixed(2)})</span>
            <span>Units sold <b>{report.unitsSold}</b> / returned <b>{report.unitsReturned}</b></span>
            <span>Low stock <b>{report.stock.lowStock}</b> · Out of stock <b>{report.stock.outOfStock}</b></span>
          </>
        )}
      </div>

      {/* KPI Cards Row (Standardized Phase 2 Accounting) */}
      <div className="p-4 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 bg-white border-b border-slate-200 shrink-0">
        <div className="p-2.5 rounded bg-slate-50 border border-slate-200">
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Gross Sales</div>
          <div className="text-lg font-bold font-mono text-slate-900 mt-0.5">
            {settings.currency} {grossSales.toFixed(2)}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">{report?.transactionCount ?? 0} sales · {report?.unitsSold ?? 0} units</div>
        </div>

        <div className="p-2.5 rounded bg-rose-50 border border-rose-200">
          <div className="text-[10px] font-semibold text-rose-700 uppercase tracking-wider flex items-center gap-1">
            <RotateCcw className="w-3 h-3 text-rose-500" />
            <span>Returns / Refunds</span>
          </div>
          <div className="text-lg font-bold font-mono text-rose-800 mt-0.5">
            -{settings.currency} {totalRefunds.toFixed(2)}
          </div>
          <div className="text-[10px] text-rose-600 mt-0.5">{filteredReturns.length} returned items</div>
        </div>

        <div className="p-2.5 rounded bg-teal-50 border border-teal-200">
          <div className="text-[10px] font-semibold text-teal-800 uppercase tracking-wider">Net Sales</div>
          <div className="text-lg font-bold font-mono text-teal-900 mt-0.5">
            {settings.currency} {netSales.toFixed(2)}
          </div>
          <div className="text-[10px] text-teal-700 font-medium mt-0.5">Realized Revenue</div>
        </div>

        <div className="p-2.5 rounded bg-slate-50 border border-slate-200">
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Net COGS</div>
          <div className="text-lg font-bold font-mono text-slate-700 mt-0.5">
            {settings.currency} {netCogs.toFixed(2)}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">Historical Cost Basis</div>
        </div>

        <div className="p-2.5 rounded bg-emerald-50 border border-emerald-200">
          <div className="text-[10px] font-semibold text-emerald-800 uppercase tracking-wider">Gross Profit</div>
          <div className="text-lg font-bold font-mono text-emerald-900 mt-0.5">
            {settings.currency} {grossProfit.toFixed(2)}
          </div>
          <div className="text-[10px] text-emerald-700 font-semibold mt-0.5">
            {grossMarginPercent.toFixed(1)}% margin
          </div>
        </div>

        <div className="p-2.5 rounded bg-amber-50 border border-amber-200">
          <div className="text-[10px] font-semibold text-amber-800 uppercase tracking-wider">Expenses</div>
          <div className="text-lg font-bold font-mono text-amber-900 mt-0.5">
            -{settings.currency} {operatingExpenses.toFixed(2)}
          </div>
          <div className="text-[10px] text-amber-700 mt-0.5">{filteredExpenses.length} entries</div>
        </div>

        <div className="p-2.5 rounded bg-sky-50 border border-sky-200">
          <div className="text-[10px] font-semibold text-sky-800 uppercase tracking-wider">Net Profit</div>
          <div className={`text-lg font-bold font-mono mt-0.5 ${netProfit >= 0 ? 'text-sky-900' : 'text-rose-700'}`}>
            {settings.currency} {netProfit.toFixed(2)}
          </div>
          <div className="text-[10px] text-sky-700 font-semibold mt-0.5">
            {netMarginPercent.toFixed(1)}% net margin
          </div>
        </div>
      </div>

      {/* Report Sub-Tabs */}
      <div className="px-4 bg-white border-b border-slate-200 flex items-center gap-4 text-xs shrink-0 overflow-x-auto">
        {[
          { id: 'summary' as ReportTab, label: 'Executive Summary', icon: TrendingUp },
          { id: 'sales' as ReportTab, label: 'Sales Transactions', icon: Receipt },
          { id: 'returns' as ReportTab, label: 'Customer Returns', icon: RotateCcw },
          { id: 'expenses' as ReportTab, label: 'Operating Expenses', icon: DollarSign },
          { id: 'medicines' as ReportTab, label: 'Medicine Velocity', icon: Pill },
          { id: 'cashiers' as ReportTab, label: 'Cashier Accountability', icon: Users },
          { id: 'tenders' as ReportTab, label: 'Payment Tenders', icon: CreditCard },
        ].map((t) => {
          const Icon = t.icon;
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`flex items-center gap-1.5 py-3 border-b-2 font-semibold cursor-pointer transition whitespace-nowrap ${
                active ? 'border-teal-700 text-teal-800' : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab Contents */}
      <div className="flex-1 overflow-auto p-4">
        {/* TAB 0: EXECUTIVE SUMMARY */}
        {activeTab === 'summary' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Income Statement Card */}
            <div className="bg-white rounded border border-slate-200 p-4">
              <h2 className="text-xs font-bold text-slate-900 uppercase tracking-wider mb-3">
                Profit &amp; Loss Statement ({dateRange})
              </h2>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between py-1.5 border-b border-slate-100">
                  <span className="text-slate-600 font-medium">Gross Sales Revenue</span>
                  <span className="font-mono font-bold text-slate-900">{settings.currency} {grossSales.toFixed(2)}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-slate-100 text-rose-700">
                  <span>Less: Customer Returns &amp; Refunds</span>
                  <span className="font-mono font-bold">-{settings.currency} {totalRefunds.toFixed(2)}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-slate-200 bg-teal-50 px-2 rounded font-semibold text-teal-900">
                  <span>Net Sales Revenue</span>
                  <span className="font-mono font-bold">{settings.currency} {netSales.toFixed(2)}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-slate-100 text-slate-600">
                  <span>Less: Cost of Goods Sold (COGS)</span>
                  <span className="font-mono font-bold text-slate-800">-{settings.currency} {netCogs.toFixed(2)}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-slate-200 bg-emerald-50 px-2 rounded font-semibold text-emerald-900">
                  <span>Gross Profit</span>
                  <span className="font-mono font-bold">{settings.currency} {grossProfit.toFixed(2)} ({grossMarginPercent.toFixed(1)}%)</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-slate-100 text-amber-800">
                  <span>Less: Operating Expenses</span>
                  <span className="font-mono font-bold">-{settings.currency} {operatingExpenses.toFixed(2)}</span>
                </div>
                <div className="flex justify-between py-2 border-t-2 border-slate-900 bg-slate-900 text-white px-2 rounded font-bold">
                  <span>Net Operating Profit</span>
                  <span className="font-mono text-emerald-400">{settings.currency} {netProfit.toFixed(2)} ({netMarginPercent.toFixed(1)}%)</span>
                </div>
              </div>
            </div>

            {/* Operating Expense Breakdown */}
            <div className="bg-white rounded border border-slate-200 p-4">
              <h2 className="text-xs font-bold text-slate-900 uppercase tracking-wider mb-3">
                Operating Expenses by Category
              </h2>
              {Object.keys(expenseCategoryStats).length === 0 ? (
                <div className="text-xs text-slate-500 py-6 text-center">No operating expenses recorded in this period.</div>
              ) : (
                <div className="space-y-2 text-xs">
                  {Object.entries(expenseCategoryStats).map(([cat, amount]) => (
                    <div key={cat} className="flex justify-between py-1.5 border-b border-slate-100">
                      <span className="text-slate-700 font-medium">{cat}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-slate-400 text-[10px]">
                          {operatingExpenses > 0 ? ((amount / operatingExpenses) * 100).toFixed(1) : 0}%
                        </span>
                        <span className="font-mono font-bold text-slate-900">{settings.currency} {amount.toFixed(2)}</span>
                      </div>
                    </div>
                  ))}
                  <div className="flex justify-between py-2 border-t border-slate-300 font-bold text-slate-900">
                    <span>Total Operating Expenses</span>
                    <span className="font-mono text-amber-800">{settings.currency} {operatingExpenses.toFixed(2)}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 1: ALL SALES TRANSACTIONS */}
        {activeTab === 'sales' && (
          <div className="bg-white rounded border border-slate-200 overflow-hidden">
            <div className="px-3 py-2 text-[11px] text-slate-500 border-b border-slate-100">
              Showing the latest {filteredSales.length} of {salesTotal} non-voided sales in this period (totals above include all of them). Use Sales History to page through every sale.
            </div>
            <table className="w-full text-left text-xs text-slate-700">
              <thead className="bg-slate-50 uppercase text-[10px] font-semibold text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="py-2.5 px-3 font-mono">Receipt #</th>
                  <th className="py-2.5 px-3">Date / Time</th>
                  <th className="py-2.5 px-3">Cashier</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3">Tender</th>
                  <th className="py-2.5 px-3 text-right">Cost Price (COGS)</th>
                  <th className="py-2.5 px-3 text-right">Sale Total</th>
                  <th className="py-2.5 px-3 text-right">Gross Profit</th>
                  <th className="py-2.5 px-3 text-right">Margin %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredSales.map((s) => {
                  const profit = s.gross_profit || 0;
                  const margin = s.total > 0 ? (profit / s.total) * 100 : 0;
                  return (
                    <tr key={s.id} className="hover:bg-slate-50 transition">
                      <td className="py-2 px-3 font-mono font-bold text-slate-900">{s.receipt_number}</td>
                      <td className="py-2 px-3 font-mono text-slate-600">{s.date} {s.time}</td>
                      <td className="py-2 px-3 text-slate-800">{s.cashier_name}</td>
                      <td className="py-2 px-3">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                            s.status === 'completed'
                              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                              : s.status === 'returned'
                              ? 'bg-rose-50 text-rose-800 border border-rose-200'
                              : 'bg-amber-50 text-amber-800 border border-amber-200'
                          }`}
                        >
                          {s.status}
                        </span>
                      </td>
                      <td className="py-2 px-3 font-medium">{s.payment_method}</td>
                      <td className="py-2 px-3 text-right font-mono text-slate-600">
                        {settings.currency} {(s.cost_total || 0).toFixed(2)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono font-bold text-slate-900">
                        {settings.currency} {s.total.toFixed(2)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono font-bold text-teal-800">
                        {settings.currency} {profit.toFixed(2)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-slate-600">
                        {margin.toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* TAB 2: CUSTOMER RETURNS LOG */}
        {activeTab === 'returns' && (
          <div className="bg-white rounded border border-slate-200 overflow-hidden">
            <table className="w-full text-left text-xs text-slate-700">
              <thead className="bg-slate-50 uppercase text-[10px] font-semibold text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="py-2.5 px-3 font-mono">Receipt #</th>
                  <th className="py-2.5 px-3">Date</th>
                  <th className="py-2.5 px-3">Medicine Formulation</th>
                  <th className="py-2.5 px-3">Batch Number</th>
                  <th className="py-2.5 px-3 text-right">Qty Returned</th>
                  <th className="py-2.5 px-3 text-right">Refund Paid</th>
                  <th className="py-2.5 px-3">Reason</th>
                  <th className="py-2.5 px-3">Stock Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredReturns.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-6 text-center text-slate-500">
                      No customer returns recorded for this date range.
                    </td>
                  </tr>
                ) : (
                  filteredReturns.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50 transition">
                      <td className="py-2 px-3 font-mono font-bold text-slate-900">{r.receipt_number}</td>
                      <td className="py-2 px-3 font-mono text-slate-600">{r.date}</td>
                      <td className="py-2 px-3 font-semibold text-slate-900">{r.medicine_name}</td>
                      <td className="py-2 px-3 font-mono text-slate-600">{r.batch_number}</td>
                      <td className="py-2 px-3 text-right font-mono font-bold text-slate-900">{r.quantity}x</td>
                      <td className="py-2 px-3 text-right font-mono font-bold text-rose-700">
                        {settings.currency} {r.refund_amount.toFixed(2)}
                      </td>
                      <td className="py-2 px-3 text-slate-700">{r.reason}</td>
                      <td className="py-2 px-3">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                            r.action === 'return_to_stock'
                              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                              : 'bg-amber-50 text-amber-800 border border-amber-200'
                          }`}
                        >
                          {r.action === 'return_to_stock' ? 'Restocked' : r.action}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* TAB 3: OPERATING EXPENSES */}
        {activeTab === 'expenses' && (
          <div className="bg-white rounded border border-slate-200 overflow-hidden">
            <table className="w-full text-left text-xs text-slate-700">
              <thead className="bg-slate-50 uppercase text-[10px] font-semibold text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="py-2.5 px-3">Date</th>
                  <th className="py-2.5 px-3">Category</th>
                  <th className="py-2.5 px-3">Description</th>
                  <th className="py-2.5 px-3">Payment Method</th>
                  <th className="py-2.5 px-3">Authorized By</th>
                  <th className="py-2.5 px-3 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredExpenses.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-slate-500">
                      No operating expenses recorded for this date range.
                    </td>
                  </tr>
                ) : (
                  filteredExpenses.map((e) => (
                    <tr key={e.id} className="hover:bg-slate-50 transition">
                      <td className="py-2 px-3 font-mono text-slate-600">{e.date}</td>
                      <td className="py-2 px-3 font-semibold text-slate-900">{e.category}</td>
                      <td className="py-2 px-3 text-slate-700">{e.description}</td>
                      <td className="py-2 px-3 text-slate-600">{e.payment_method}</td>
                      <td className="py-2 px-3 text-slate-600">{e.user_name}</td>
                      <td className="py-2 px-3 text-right font-mono font-bold text-amber-800">
                        {settings.currency} {e.amount.toFixed(2)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* TAB 4: MEDICINE VELOCITY */}
        {activeTab === 'medicines' && (
          <div className="bg-white rounded border border-slate-200 overflow-hidden">
            <table className="w-full text-left text-xs text-slate-700">
              <thead className="bg-slate-50 uppercase text-[10px] font-semibold text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="py-2.5 px-3">Rank</th>
                  <th className="py-2.5 px-3">Medicine Formulation</th>
                  <th className="py-2.5 px-3 text-right">Net Units Dispensed</th>
                  <th className="py-2.5 px-3 text-right">Net Revenue</th>
                  <th className="py-2.5 px-3 text-right">Gross Profit</th>
                  <th className="py-2.5 px-3 text-right">Profit Contribution</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sortedMeds.map((m, idx) => (
                  <tr key={idx} className="hover:bg-slate-50 transition">
                    <td className="py-2 px-3 font-mono font-bold text-slate-500">#{idx + 1}</td>
                    <td className="py-2 px-3 font-semibold text-slate-900">{m.name}</td>
                    <td className="py-2 px-3 text-right font-mono font-bold text-slate-800">
                      {m.quantity} units
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-slate-900">
                      {settings.currency} {m.revenue.toFixed(2)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono font-bold text-teal-800">
                      {settings.currency} {m.profit.toFixed(2)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-slate-600">
                      {grossProfit > 0 ? ((m.profit / grossProfit) * 100).toFixed(1) : 0}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* TAB 5: CASHIERS */}
        {activeTab === 'cashiers' && (
          <div className="bg-white rounded border border-slate-200 overflow-hidden">
            <table className="w-full text-left text-xs text-slate-700">
              <thead className="bg-slate-50 uppercase text-[10px] font-semibold text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="py-2.5 px-3">Cashier Staff</th>
                  <th className="py-2.5 px-3 text-right">Transactions</th>
                  <th className="py-2.5 px-3 text-right">Gross Sales</th>
                  <th className="py-2.5 px-3 text-right">Refunds Paid</th>
                  <th className="py-2.5 px-3 text-right">Net Sales</th>
                  <th className="py-2.5 px-3 text-right">Gross Profit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {Object.entries(cashierStats).map(([name, stat]) => (
                  <tr key={name} className="hover:bg-slate-50 transition">
                    <td className="py-2 px-3 font-semibold text-slate-900">{name}</td>
                    <td className="py-2 px-3 text-right font-mono">{stat.count} sales</td>
                    <td className="py-2 px-3 text-right font-mono text-slate-600">
                      {settings.currency} {stat.gross.toFixed(2)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-rose-700">
                      -{settings.currency} {stat.refunds.toFixed(2)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono font-bold text-slate-900">
                      {settings.currency} {stat.net.toFixed(2)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono font-bold text-teal-800">
                      {settings.currency} {stat.profit.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* TAB 6: TENDERS */}
        {activeTab === 'tenders' && (
          <div className="bg-white rounded border border-slate-200 overflow-hidden max-w-xl">
            <table className="w-full text-left text-xs text-slate-700">
              <thead className="bg-slate-50 uppercase text-[10px] font-semibold text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="py-2.5 px-3">Tender Method</th>
                  <th className="py-2.5 px-3 text-right">Net Collected</th>
                  <th className="py-2.5 px-3 text-right">% of Net Sales</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {Object.entries(tenderStats).map(([method, amount]) => (
                  <tr key={method} className="hover:bg-slate-50 transition">
                    <td className="py-2.5 px-3 font-semibold text-slate-800">{method}</td>
                    <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900">
                      {settings.currency} {amount.toFixed(2)}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-slate-500">
                      {netSales > 0 ? ((amount / netSales) * 100).toFixed(1) : 0}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
