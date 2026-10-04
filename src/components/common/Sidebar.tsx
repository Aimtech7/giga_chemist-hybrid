import React, { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  ShoppingCart,
  Pill,
  PackageSearch,
  Boxes,
  AlertTriangle,
  Truck,
  Building2,
  Users,
  Receipt,
  RotateCcw,
  BarChart3,
  ShieldCheck,
  FileText,
  Settings as SettingsIcon,
  ChevronRight,
} from 'lucide-react';
import { db } from '../../db/dexie';
import type { UserRole } from '../../types';

export type NavTab =
  | 'dashboard'
  | 'pos'
  | 'medicines'
  | 'inventory'
  | 'batches'
  | 'expiry'
  | 'purchases'
  | 'suppliers'
  | 'customers'
  | 'expenses'
  | 'sales'
  | 'reports'
  | 'users'
  | 'audit'
  | 'settings';

interface SidebarProps {
  currentTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  userRole?: UserRole;
}

export const Sidebar: React.FC<SidebarProps> = ({ currentTab, onSelectTab, userRole = 'CASHIER' }) => {
  const [expiryAlertCount, setExpiryAlertCount] = useState<number>(0);
  const [lowStockCount, setLowStockCount] = useState<number>(0);

  useEffect(() => {
    async function loadAlerts() {
      try {
        const todayStr = new Date().toISOString().split('T')[0];
        const in30Days = new Date();
        in30Days.setDate(in30Days.getDate() + 30);
        const in30DaysStr = in30Days.toISOString().split('T')[0];

        const batches = await db.medicine_batches.toArray();
        const urgentBatches = batches.filter(
          (b) => b.quantity_available > 0 && b.expiry_date <= in30DaysStr
        );
        setExpiryAlertCount(urgentBatches.length);

        const medicines = await db.medicines.where('status').equals('active').toArray();
        const lowStock = medicines.filter((m) => m.current_stock <= m.reorder_level);
        setLowStockCount(lowStock.length);
      } catch (e) {}
    }

    loadAlerts();
    const interval = setInterval(loadAlerts, 15000);
    return () => clearInterval(interval);
  }, []);

  const navItems = [
    { id: 'dashboard' as NavTab, label: 'Dashboard', icon: LayoutDashboard, minRole: 'CASHIER' },
    {
      id: 'pos' as NavTab,
      label: 'POS Register',
      icon: ShoppingCart,
      minRole: 'CASHIER',
      isPrimary: true,
      badge: 'F2',
    },
    { id: 'medicines' as NavTab, label: 'Medicines Master', icon: Pill, minRole: 'CASHIER' },
    {
      id: 'inventory' as NavTab,
      label: 'Inventory Control',
      icon: PackageSearch,
      minRole: 'CASHIER',
      alert: lowStockCount > 0 ? lowStockCount : undefined,
    },
    { id: 'batches' as NavTab, label: 'Medicine Batches', icon: Boxes, minRole: 'CASHIER' },
    {
      id: 'expiry' as NavTab,
      label: 'Expiry Management',
      icon: AlertTriangle,
      minRole: 'CASHIER',
      alert: expiryAlertCount > 0 ? expiryAlertCount : undefined,
      alertColor: 'bg-rose-500',
    },
    { id: 'purchases' as NavTab, label: 'Purchases & Receiving', icon: Truck, minRole: 'MANAGER' },
    { id: 'suppliers' as NavTab, label: 'Suppliers', icon: Building2, minRole: 'MANAGER' },
    { id: 'customers' as NavTab, label: 'Customers', icon: Users, minRole: 'CASHIER' },
    { id: 'expenses' as NavTab, label: 'Expenses', icon: Receipt, minRole: 'MANAGER' },
    { id: 'sales' as NavTab, label: 'Sales & Returns', icon: RotateCcw, minRole: 'CASHIER' },
    { id: 'reports' as NavTab, label: 'Reports & Analytics', icon: BarChart3, minRole: 'MANAGER' },
    { id: 'users' as NavTab, label: 'User Management', icon: ShieldCheck, minRole: 'ADMIN' },
    { id: 'audit' as NavTab, label: 'Audit Trail', icon: FileText, minRole: 'ADMIN' },
    { id: 'settings' as NavTab, label: 'Settings', icon: SettingsIcon, minRole: 'ADMIN' },
  ];

  const isAllowed = (minRole: string) => {
    if (minRole === 'CASHIER') return true;
    if (minRole === 'MANAGER') return userRole === 'ADMIN' || userRole === 'MANAGER';
    if (minRole === 'ADMIN') return userRole === 'ADMIN';
    return false;
  };

  return (
    <aside className="w-56 bg-slate-900 border-r border-slate-800 flex flex-col shrink-0 text-slate-300 select-none overflow-y-auto">
      <div className="p-3 text-[11px] font-bold uppercase tracking-wider text-slate-400">
        Navigation
      </div>
      <nav className="flex-1 px-2 space-y-1 pb-6">
        {navItems.map((item) => {
          const visible = isAllowed(item.minRole);
          if (!visible) return null;

          const active = currentTab === item.id;
          const Icon = item.icon;

          if (item.isPrimary) {
            return (
              <button
                key={item.id}
                onClick={() => onSelectTab(item.id)}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-md font-bold text-xs transition cursor-pointer mb-2 ${
                  active
                    ? 'bg-teal-600 text-white shadow-md'
                    : 'bg-teal-950/70 text-teal-300 hover:bg-teal-900/80 border border-teal-800/60'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Icon className="w-4 h-4 text-teal-300" />
                  <span>{item.label}</span>
                </div>
                {item.badge && (
                  <span className="text-[10px] bg-teal-800/80 text-teal-200 px-1.5 py-0.5 rounded font-mono font-bold">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          }

          return (
            <button
              key={item.id}
              onClick={() => onSelectTab(item.id)}
              className={`w-full flex items-center justify-between px-2.5 py-2 rounded text-xs font-medium transition cursor-pointer ${
                active
                  ? 'bg-slate-800 text-white font-semibold border-l-3 border-teal-500'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              <div className="flex items-center gap-2.5 truncate">
                <Icon
                  className={`w-4 h-4 shrink-0 ${active ? 'text-teal-400' : 'text-slate-400'}`}
                />
                <span className="truncate">{item.label}</span>
              </div>

              {item.alert !== undefined && item.alert > 0 && (
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold text-white shrink-0 ${
                    item.alertColor || 'bg-amber-600'
                  }`}
                >
                  {item.alert}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Role Indicator Footer */}
      <div className="p-3 bg-slate-950/80 border-t border-slate-800/80 text-[10px] text-slate-400 flex items-center justify-between">
        <span>ACCESS:</span>
        <span className="font-bold text-slate-200">{userRole}</span>
      </div>
    </aside>
  );
};
