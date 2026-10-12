import React from 'react';
import { GlobalControlCenter, SelectShopPrompt } from './GlobalControlCenter';
import { RemoteAdminPanel } from './RemoteAdminPanel';
import { RemoteRecords } from './RemoteRecords';
import { UsersTab } from './UserManagement';
import { ReportsDashboard } from '../reports/ReportsDashboard';
import { HistoryView, type HistoryTab } from '../history/HistoryView';
import { isAllShopsScope, isGlobalAdminAccount, selectedShopId } from '../../services/shopContext';
import type { PharmacySettings, User } from '../../types';

/**
 * Online app, Administrator: every module of the GLOBAL CONTROL CENTER. All reads come from the
 * selected shop's cloud copy and every write is a shop-scoped command (the local screens' direct
 * writes are refused online). "All Shops" is read-only: shop modules ask for a shop first.
 */
const LABELS: Record<string, string> = {
  medicines: 'Medicines', inventory: 'Inventory', batches: 'Batches', expiry: 'Expiry', purchases: 'Purchases', suppliers: 'Suppliers',
  customers: 'Customers', sales: 'Sales', returns: 'Returns', expenses: 'Expenses', reports: 'Reports', users: 'Users', settings: 'Settings',
  audit: 'Audit', remote: 'Remote Operations', stocktake: 'Physical count', pos: 'POS', history: 'History',
};

export const OnlineAdminModule: React.FC<{ module: string; currentUser: User; settings: PharmacySettings; historyTab?: HistoryTab }> = ({ module, currentUser, settings, historyTab }) => {
  if (isAllShopsScope()) {
    if (module === 'dashboard') return <GlobalControlCenter settings={settings} />;
    // History is read only: All Shops combines every shop (with a Shop column).
    if (module === 'history') return <HistoryView settings={settings} currentUser={currentUser} initialTab={historyTab} />;
    return <SelectShopPrompt settings={settings} module={LABELS[module] || module} />;
  }
  const panel = (tab?: React.ComponentProps<typeof RemoteAdminPanel>['initialTab'], filter?: React.ComponentProps<typeof RemoteAdminPanel>['initialStockFilter']) => (
    <RemoteAdminPanel key={`${module}-${tab}-${filter}`} currentUser={currentUser} settings={settings} initialTab={tab} initialStockFilter={filter} />
  );
  switch (module) {
    case 'dashboard':
      return <GlobalControlCenter settings={settings} focusShopId={selectedShopId()} />;
    case 'medicines':
    case 'inventory':
    case 'batches':
      return panel('medicines');
    case 'expiry':
      return panel('medicines', 'expiring');
    case 'suppliers':
    case 'customers':
    case 'expenses':
    case 'purchases':
    case 'returns':
    case 'sales':
      return <RemoteRecords key={module} kind={module} settings={settings} />;
    case 'reports':
      return <ReportsDashboard currentUser={currentUser} settings={settings} />;
    case 'history':
      return <HistoryView settings={settings} currentUser={currentUser} initialTab={historyTab} />;
    case 'users':
      return isGlobalAdminAccount() ? (
        <div className="flex-1 overflow-y-auto bg-slate-50"><div className="max-w-2xl mx-auto p-3"><UsersTab currentUser={currentUser} /></div></div>
      ) : panel('staff');
    case 'settings':
      return panel('shop');
    case 'audit':
      return panel('changes');
    case 'remote':
      return panel('health');
    default:
      return (
        <div className="p-6 text-sm text-slate-600">
          {LABELS[module] || module} runs on the shop computer only (there is no till online). Use the shop POS.
        </div>
      );
  }
};
