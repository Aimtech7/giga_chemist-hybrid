import React, { useState, useEffect } from 'react';
import {
  TrendingUp,
  ShoppingCart,
  Boxes,
  AlertTriangle,
  Clock,
  WifiOff,
  CheckCircle2,
  Receipt,
  CreditCard,
  Banknote,
  Smartphone,
  ShieldCheck,
} from 'lucide-react';
import { db } from '../../db/dexie';
import { getInventoryValuation } from '../../services/inventoryEngine';
import { getPendingCount } from '../../services/syncEngine';
import { canViewCostData, isCashier } from '../../services/permissions';
import type { Sale, InventoryMovement, PharmacySettings, User } from '../../types';

interface DashboardProps {
  currentUser: User | null;
  settings: PharmacySettings;
  onNavigate: (tab: any) => void;
}

export const Dashboard: React.FC<DashboardProps> = ({ currentUser, settings, onNavigate }) => {
  const isCashierUser = isCashier(currentUser);
  const showCostAndProfits = canViewCostData(currentUser);

  const [metrics, setMetrics] = useState({
    todaySales: 0,
    todayProfit: 0,
    todayTransactions: 0,
    cashSales: 0,
    mpesaSales: 0,
    cardSales: 0,
    inventoryValue: 0,
    lowStockCount: 0,
    outOfStockCount: 0,
    expiringSoonCount: 0,
    expiredCount: 0,
    pendingSyncCount: 0,
  });

  const [recentSales, setRecentSales] = useState<Sale[]>([]);
  const [recentMovements, setRecentMovements] = useState<InventoryMovement[]>([]);

  useEffect(() => {
    async function loadDashboard() {
      const todayStr = new Date().toISOString().split('T')[0];
      const sales = await db.sales.toArray();
      
      // Filter today's completed sales
      const todaySalesList = sales.filter((s) => {
        if (s.date !== todayStr || s.status !== 'completed') return false;
        if (isCashierUser && currentUser?.id) {
          // Operational cashier sees their own shift transactions or all today's register transactions
          return s.cashier_id === currentUser.id || !s.cashier_id;
        }
        return true;
      });

      let todaySales = 0;
      let todayProfit = 0;
      let cashSales = 0;
      let mpesaSales = 0;
      let cardSales = 0;

      todaySalesList.forEach((s) => {
        todaySales += s.total;
        if (showCostAndProfits && s.gross_profit) todayProfit += s.gross_profit;
        if (s.payment_method === 'Cash') cashSales += s.total;
        else if (s.payment_method === 'M-Pesa') mpesaSales += s.total;
        else if (s.payment_method === 'Card') cardSales += s.total;
      });

      let inventoryValue = 0;
      let lowStock = 0;
      let outOfStock = 0;
      let expiringSoon = 0;
      let expired = 0;

      if (showCostAndProfits) {
        const valuation = await getInventoryValuation();
        inventoryValue = valuation.purchaseValuation;

        const medicines = await db.medicines.toArray();
        lowStock = medicines.filter((m) => m.current_stock > 0 && m.current_stock <= m.reorder_level).length;
        outOfStock = medicines.filter((m) => m.current_stock === 0).length;

        const batches = await db.medicine_batches.toArray();
        const now = new Date();
        const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        batches.forEach((b) => {
          if (b.quantity_available <= 0) return;
          const exp = new Date(b.expiry_date);
          if (exp < now) {
            expired++;
          } else if (exp <= in30Days) {
            expiringSoon++;
          }
        });
      }

      const pendingSync = await getPendingCount();

      setMetrics({
        todaySales,
        todayProfit,
        todayTransactions: todaySalesList.length,
        cashSales,
        mpesaSales,
        cardSales,
        inventoryValue,
        lowStockCount: lowStock,
        outOfStockCount: outOfStock,
        expiringSoonCount: expiringSoon,
        expiredCount: expired,
        pendingSyncCount: pendingSync,
      });

      const sortedSales = sales
        .filter((s) => {
          if (s.status !== 'completed') return false;
          if (isCashierUser && currentUser?.id) {
            return s.cashier_id === currentUser.id;
          }
          return true;
        })
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .slice(0, 10);
      setRecentSales(sortedSales);

      if (!isCashierUser) {
        const movements = await db.inventory_movements.toArray();
        const sortedMovements = movements
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
          .slice(0, 8);
        setRecentMovements(sortedMovements);
      }
    }

    loadDashboard();
  }, [currentUser, isCashierUser, showCostAndProfits]);

  // CASHIER OPERATIONAL DASHBOARD
  if (isCashierUser) {
    return (
      <div className="flex-1 overflow-y-auto p-4 md:p-6 bg-slate-50 space-y-4">
        {/* Cashier Header Toolbar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200">
          <div>
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded bg-teal-100 text-teal-800 text-[10px] font-bold uppercase tracking-wider">
                Cashier Station
              </span>
              <h1 className="text-base font-bold text-slate-900 tracking-tight">
                Operational Overview
              </h1>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Shift summary for <strong>{currentUser?.name || 'Cashier'}</strong> · {settings.pharmacy_name || 'GIGA CHEMIST'}
            </p>
          </div>

          <button
            onClick={() => onNavigate('pos')}
            className="px-4 py-2 rounded bg-teal-700 hover:bg-teal-800 text-white font-bold text-xs shadow-xs transition cursor-pointer inline-flex items-center gap-2 self-start sm:self-auto"
          >
            <ShoppingCart className="w-4 h-4" />
            <span>Open POS Register (F2)</span>
          </button>
        </div>

        {/* Operational Cashier KPI Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="bg-white p-3 rounded border border-slate-200">
            <div className="text-[11px] font-semibold text-slate-500 uppercase flex items-center justify-between">
              <span>Today's Sales</span>
              <Receipt className="w-3.5 h-3.5 text-teal-700" />
            </div>
            <div className="text-lg font-bold font-mono text-slate-900 mt-1">
              {settings.currency} {metrics.todaySales.toFixed(2)}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">Total collected</div>
          </div>

          <div className="bg-white p-3 rounded border border-slate-200">
            <div className="text-[11px] font-semibold text-slate-500 uppercase flex items-center justify-between">
              <span>Transactions</span>
              <CheckCircle2 className="w-3.5 h-3.5 text-slate-500" />
            </div>
            <div className="text-lg font-bold font-mono text-slate-900 mt-1">
              {metrics.todayTransactions}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">Completed tickets</div>
          </div>

          <div className="bg-white p-3 rounded border border-slate-200">
            <div className="text-[11px] font-semibold text-slate-500 uppercase flex items-center justify-between">
              <span>Cash Sales</span>
              <Banknote className="w-3.5 h-3.5 text-emerald-700" />
            </div>
            <div className="text-lg font-bold font-mono text-slate-900 mt-1">
              {settings.currency} {metrics.cashSales.toFixed(2)}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">Physical cash drawer</div>
          </div>

          <div className="bg-white p-3 rounded border border-slate-200">
            <div className="text-[11px] font-semibold text-slate-500 uppercase flex items-center justify-between">
              <span>M-Pesa Sales</span>
              <Smartphone className="w-3.5 h-3.5 text-emerald-700" />
            </div>
            <div className="text-lg font-bold font-mono text-slate-900 mt-1">
              {settings.currency} {metrics.mpesaSales.toFixed(2)}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">Mobile money</div>
          </div>

          <div className="bg-white p-3 rounded border border-slate-200">
            <div className="text-[11px] font-semibold text-slate-500 uppercase flex items-center justify-between">
              <span>Card Sales</span>
              <CreditCard className="w-3.5 h-3.5 text-blue-700" />
            </div>
            <div className="text-lg font-bold font-mono text-slate-900 mt-1">
              {settings.currency} {metrics.cardSales.toFixed(2)}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">Card terminals</div>
          </div>

          <div
            onClick={() => onNavigate('sales')}
            className="bg-white p-3 rounded border border-slate-200 cursor-pointer hover:border-slate-300 transition"
          >
            <div className="text-[11px] font-semibold text-slate-500 uppercase flex items-center justify-between">
              <span>Pending Sync</span>
              <Clock className="w-3.5 h-3.5 text-slate-500" />
            </div>
            <div className={`text-lg font-bold font-mono mt-1 ${metrics.pendingSyncCount > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
              {metrics.pendingSyncCount}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              {metrics.pendingSyncCount > 0 ? 'Local queue' : 'Fully synced'}
            </div>
          </div>
        </div>

        {/* Shift Operational Status Strip */}
        <div className="bg-white p-3.5 rounded border border-slate-200 flex flex-wrap items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-2 text-slate-700">
            <ShieldCheck className="w-4 h-4 text-teal-700" />
            <span className="font-semibold">Register Station Status:</span>
            <span className="px-2 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 font-medium">
              Operational · Offline-Ready
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => onNavigate('medicines')}
              className="text-xs font-semibold text-teal-700 hover:text-teal-900 cursor-pointer"
            >
              Lookup Medicines &rarr;
            </button>
            <span className="text-slate-300">|</span>
            <button
              onClick={() => onNavigate('sales')}
              className="text-xs font-semibold text-teal-700 hover:text-teal-900 cursor-pointer"
            >
              Sales History &rarr;
            </button>
          </div>
        </div>

        {/* Cashier Recent Sales Table */}
        <div className="bg-white rounded border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
            <span className="text-xs font-bold text-slate-800">My Recent Completed Sales</span>
            <button
              onClick={() => onNavigate('sales')}
              className="text-xs text-teal-700 hover:text-teal-900 font-semibold cursor-pointer"
            >
              View Full History &rarr;
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 bg-slate-50/50">
                  <th className="py-2.5 px-3 font-semibold">Receipt #</th>
                  <th className="py-2.5 px-3 font-semibold">Time</th>
                  <th className="py-2.5 px-3 font-semibold">Customer</th>
                  <th className="py-2.5 px-3 font-semibold">Items Dispensed</th>
                  <th className="py-2.5 px-3 font-semibold">Tender</th>
                  <th className="py-2.5 px-3 font-semibold text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recentSales.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-slate-400">
                      No sales recorded for this shift yet.
                    </td>
                  </tr>
                ) : (
                  recentSales.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-50">
                      <td className="py-2.5 px-3 font-mono font-bold text-slate-800">{s.receipt_number}</td>
                      <td className="py-2.5 px-3 font-mono text-slate-500">{s.time}</td>
                      <td className="py-2.5 px-3 text-slate-700">
                        {s.customer_name || 'Walk-in'}
                      </td>
                      <td className="py-2.5 px-3 text-slate-600 truncate max-w-[200px]">
                        {s.items.map((i) => `${i.quantity}x ${i.medicine_name}`).join(', ')}
                      </td>
                      <td className="py-2.5 px-3 text-slate-700 font-medium">{s.payment_method}</td>
                      <td className="py-2.5 px-3 font-mono font-bold text-slate-900 text-right">
                        {settings.currency} {s.total.toFixed(2)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // ADMIN & MANAGER EXECUTIVE DASHBOARD
  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6 bg-slate-50 space-y-4">
      {/* Header Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200">
        <div>
          <h1 className="text-base font-bold text-slate-900 tracking-tight">
            Executive &amp; Operational Dashboard
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Overview for {settings.pharmacy_name || 'GIGA CHEMIST'} · Logged in as {currentUser?.name} ({currentUser?.role})
          </p>
        </div>

        <button
          onClick={() => onNavigate('pos')}
          className="px-3.5 py-1.5 rounded bg-teal-700 hover:bg-teal-800 text-white font-semibold text-xs shadow-xs transition cursor-pointer inline-flex items-center gap-1.5 self-start sm:self-auto"
        >
          <ShoppingCart className="w-3.5 h-3.5" />
          <span>Open POS Register (F2)</span>
        </button>
      </div>

      {/* Primary Summary Row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="bg-white p-3 rounded border border-slate-200">
          <div className="text-[11px] font-semibold text-slate-500 uppercase">Today's Sales</div>
          <div className="text-lg font-bold font-mono text-slate-900 mt-1">
            {settings.currency} {metrics.todaySales.toFixed(2)}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">{metrics.todayTransactions} sales</div>
        </div>

        <div className="bg-white p-3 rounded border border-slate-200">
          <div className="text-[11px] font-semibold text-slate-500 uppercase">Gross Profit</div>
          <div className="text-lg font-bold font-mono text-teal-800 mt-1">
            {settings.currency} {metrics.todayProfit.toFixed(2)}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {metrics.todaySales > 0 ? `${((metrics.todayProfit / metrics.todaySales) * 100).toFixed(1)}% margin` : '—'}
          </div>
        </div>

        <div className="bg-white p-3 rounded border border-slate-200">
          <div className="text-[11px] font-semibold text-slate-500 uppercase">Stock Valuation</div>
          <div className="text-lg font-bold font-mono text-slate-900 mt-1">
            {settings.currency} {metrics.inventoryValue.toFixed(2)}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">Cost basis</div>
        </div>

        <div
          onClick={() => onNavigate('medicines')}
          className="bg-white p-3 rounded border border-slate-200 cursor-pointer hover:border-slate-300 transition"
        >
          <div className="text-[11px] font-semibold text-slate-500 uppercase">Low Stock</div>
          <div className={`text-lg font-bold font-mono mt-1 ${metrics.lowStockCount > 0 ? 'text-amber-700' : 'text-slate-900'}`}>
            {metrics.lowStockCount} items
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">{metrics.outOfStockCount} depleted</div>
        </div>

        <div
          onClick={() => onNavigate('expiry')}
          className="bg-white p-3 rounded border border-slate-200 cursor-pointer hover:border-slate-300 transition"
        >
          <div className="text-[11px] font-semibold text-slate-500 uppercase">Expiring (30d)</div>
          <div className={`text-lg font-bold font-mono mt-1 ${metrics.expiringSoonCount > 0 ? 'text-amber-700' : 'text-slate-900'}`}>
            {metrics.expiringSoonCount} batches
          </div>
          <div className="text-[11px] text-rose-700 mt-0.5">{metrics.expiredCount} expired</div>
        </div>

        <div
          onClick={() => onNavigate('sales')}
          className="bg-white p-3 rounded border border-slate-200 cursor-pointer hover:border-slate-300 transition"
        >
          <div className="text-[11px] font-semibold text-slate-500 uppercase">Pending Sync</div>
          <div className={`text-lg font-bold font-mono mt-1 ${metrics.pendingSyncCount > 0 ? 'text-amber-700' : 'text-slate-900'}`}>
            {metrics.pendingSyncCount}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {metrics.pendingSyncCount > 0 ? 'Local queue' : 'Fully synced'}
          </div>
        </div>
      </div>

      {/* Tender Breakdown Strip */}
      <div className="bg-white p-3 rounded border border-slate-200 flex flex-wrap items-center justify-between gap-4 text-xs">
        <span className="font-semibold text-slate-700">Today's Tender Split:</span>
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="text-slate-500">Cash:</span>
            <span className="font-mono font-semibold text-slate-900">
              {settings.currency} {metrics.cashSales.toFixed(2)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-500">M-Pesa:</span>
            <span className="font-mono font-semibold text-slate-900">
              {settings.currency} {metrics.mpesaSales.toFixed(2)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-500">Card:</span>
            <span className="font-mono font-semibold text-slate-900">
              {settings.currency} {metrics.cardSales.toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* Operational Data Tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent Register Sales */}
        <div className="bg-white rounded border border-slate-200 overflow-hidden">
          <div className="px-3 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-800">Recent Completed Sales</span>
            <button
              onClick={() => onNavigate('sales')}
              className="text-xs text-teal-700 hover:text-teal-900 font-semibold cursor-pointer"
            >
              View Sales History &rarr;
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 bg-slate-50/50">
                  <th className="py-2 px-3 font-semibold">Receipt #</th>
                  <th className="py-2 px-3 font-semibold">Time</th>
                  <th className="py-2 px-3 font-semibold">Customer / Cashier</th>
                  <th className="py-2 px-3 font-semibold">Tender</th>
                  <th className="py-2 px-3 font-semibold text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recentSales.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-slate-400">
                      No sales recorded today.
                    </td>
                  </tr>
                ) : (
                  recentSales.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-50">
                      <td className="py-2 px-3 font-mono font-medium text-slate-800">{s.receipt_number}</td>
                      <td className="py-2 px-3 text-slate-500">{s.time}</td>
                      <td className="py-2 px-3 text-slate-600 truncate max-w-[150px]">
                        {s.customer_name || 'Walk-in'} <span className="text-slate-400">({s.cashier_name})</span>
                      </td>
                      <td className="py-2 px-3 text-slate-600">{s.payment_method}</td>
                      <td className="py-2 px-3 font-mono font-bold text-slate-900 text-right">
                        {settings.currency} {s.total.toFixed(2)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Recent Stock Movements */}
        <div className="bg-white rounded border border-slate-200 overflow-hidden">
          <div className="px-3 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-800">Recent Inventory Audit Movements</span>
            <button
              onClick={() => onNavigate('audit')}
              className="text-xs text-teal-700 hover:text-teal-900 font-semibold cursor-pointer"
            >
              View Audit Log &rarr;
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 bg-slate-50/50">
                  <th className="py-2 px-3 font-semibold">Medicine</th>
                  <th className="py-2 px-3 font-semibold">Batch</th>
                  <th className="py-2 px-3 font-semibold">Reason</th>
                  <th className="py-2 px-3 font-semibold text-right">Qty</th>
                  <th className="py-2 px-3 font-semibold">User</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recentMovements.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-slate-400">
                      No stock movements recorded.
                    </td>
                  </tr>
                ) : (
                  recentMovements.map((mov) => (
                    <tr key={mov.id} className="hover:bg-slate-50">
                      <td className="py-2 px-3 font-medium text-slate-800 truncate max-w-[140px]">
                        {mov.medicine_name}
                      </td>
                      <td className="py-2 px-3 font-mono text-slate-500">{mov.batch_number}</td>
                      <td className="py-2 px-3 text-slate-600 truncate max-w-[120px]">{mov.reason}</td>
                      <td className={`py-2 px-3 font-mono font-semibold text-right ${mov.adjustment_quantity < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                        {mov.adjustment_quantity > 0 ? `+${mov.adjustment_quantity}` : mov.adjustment_quantity}
                      </td>
                      <td className="py-2 px-3 text-slate-500">{mov.user_name}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

