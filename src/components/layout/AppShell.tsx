import React, { useState, useEffect } from 'react';
import {
  LayoutDashboard,
  ShoppingCart,
  Pill,
  PackageSearch,
  Boxes,
  AlertTriangle,
  ClipboardCheck,
  Truck,
  Building2,
  Users,
  Receipt,
  RotateCcw,
  BarChart3,
  ShieldCheck,
  FileText,
  Settings as SettingsIcon,
  Wifi,
  WifiOff,
  RefreshCw,
  LogOut,
  ChevronDown,
  KeyRound,
} from 'lucide-react';
import { PWAInstallButton } from '../common/PWAInstallButton';
import { ChangePasswordModal } from '../users/ChangePasswordModal';
import { subscribeNetworkStatus, type NetworkState, refreshNetworkStatus } from '../../services/network';
import { runSync, subscribeToSyncStatus } from '../../services/syncEngine';
import { getOrRegisterDevice } from '../../services/device';
import { canAccessModule, isCashier } from '../../services/permissions';
import type { User, PharmacySettings, DeviceInfo } from '../../types';

export type AppModule =
  | 'dashboard'
  | 'pos'
  | 'medicines'
  | 'inventory'
  | 'stocktake'
  | 'batches'
  | 'expiry'
  | 'purchases'
  | 'suppliers'
  | 'customers'
  | 'expenses'
  | 'sales'
  | 'returns'
  | 'reports'
  | 'users'
  | 'audit'
  | 'settings';

interface AppShellProps {
  currentModule: AppModule;
  onSelectModule: (module: AppModule) => void;
  currentUser: User | null;
  settings: PharmacySettings;
  onOpenLogin: () => void;
  onLogout: () => void;
  onViewLandingPage?: () => void;
  children: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({
  currentModule,
  onSelectModule,
  currentUser,
  settings,
  onOpenLogin,
  onLogout,
  onViewLandingPage,
  children,
}) => {
  const [networkState, setNetworkState] = useState<NetworkState>('ONLINE_SYNCED');
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [showUserMenu, setShowUserMenu] = useState<boolean>(false);
  const [isChangePasswordOpen, setIsChangePasswordOpen] = useState<boolean>(false);

  useEffect(() => {
    getOrRegisterDevice().then(setDevice);
    
    // Subscribe to both network connectivity and sync queue status
    const unsubNetwork = subscribeNetworkStatus((state) => {
      setNetworkState(state);
    });

    const unsubSync = subscribeToSyncStatus((summary) => {
      setPendingCount(summary.pendingCount);
      if (summary.state === 'syncing') {
        setIsSyncing(true);
      } else {
        setIsSyncing(false);
      }
    });

    return () => {
      unsubNetwork();
      unsubSync();
    };
  }, []);

  const handleManualSync = async () => {
    setIsSyncing(true);
    await runSync(true);
    await refreshNetworkStatus();
    setTimeout(() => setIsSyncing(false), 500);
  };

  // Full catalog of navigation items across all system modules
  const allNavItems = [
    { id: 'dashboard' as AppModule, label: 'Dashboard', icon: LayoutDashboard },
    { id: 'pos' as AppModule, label: 'POS Register', icon: ShoppingCart },
    { id: 'medicines' as AppModule, label: isCashier(currentUser) ? 'Medicine Lookup' : 'Medicines', icon: Pill },
    { id: 'inventory' as AppModule, label: 'Inventory', icon: PackageSearch },
    { id: 'stocktake' as AppModule, label: 'Physical Stock Count', icon: ClipboardCheck },
    { id: 'batches' as AppModule, label: 'Batches', icon: Boxes },
    { id: 'expiry' as AppModule, label: 'Expiry Tracking', icon: AlertTriangle },
    { id: 'purchases' as AppModule, label: 'Purchases', icon: Truck },
    { id: 'suppliers' as AppModule, label: 'Suppliers', icon: Building2 },
    { id: 'customers' as AppModule, label: 'Customers', icon: Users },
    { id: 'expenses' as AppModule, label: 'Expenses', icon: Receipt },
    { id: 'sales' as AppModule, label: 'Sales History', icon: RotateCcw },
    { id: 'returns' as AppModule, label: 'Returns', icon: RotateCcw },
    { id: 'reports' as AppModule, label: 'Reports', icon: BarChart3 },
    { id: 'users' as AppModule, label: 'Users', icon: ShieldCheck },
    { id: 'audit' as AppModule, label: 'Audit Logs', icon: FileText },
    { id: 'settings' as AppModule, label: 'Settings', icon: SettingsIcon },
  ];

  // STRICT RBAC: Filter navigation items based on user role.
  // Cashiers ONLY see permitted modules: Dashboard, POS Register, Medicine Lookup, Customers, Sales History, Returns.
  // Restricted modules are completely hidden from the DOM.
  const visibleNavItems = allNavItems.filter((item) => canAccessModule(currentUser, item.id));

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-slate-100 font-sans select-none">
      {/* Top Application Bar */}
      <header className="h-12 bg-slate-900 text-white flex items-center justify-between px-3 sm:px-4 z-30 shrink-0 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-7 h-7 rounded bg-teal-700 text-white font-bold text-xs tracking-tight">
            GC
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-bold text-sm tracking-tight text-white">
              {settings.pharmacy_name || 'GIGA CHEMIST'}
            </span>
            {isCashier(currentUser) && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-950 text-teal-300 font-semibold border border-teal-800/60 hidden sm:inline">
                Cashier Register Counter
              </span>
            )}
          </div>
        </div>

        {/* Center: Unboxed Status Indicator */}
        <div className="flex items-center gap-2 text-xs">
          <div className="flex items-center gap-1.5 text-slate-300">
            {networkState === 'OFFLINE' ? (
              <>
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                <WifiOff className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-amber-300 font-medium">
                  {pendingCount > 0 ? `Offline (${pendingCount} pending)` : 'Offline'}
                </span>
              </>
            ) : pendingCount > 0 ? (
              <>
                <span className="w-2 h-2 rounded-full bg-amber-400" />
                <Wifi className="w-3.5 h-3.5 text-slate-300" />
                <span className="text-slate-300 font-medium">Online ({pendingCount} pending)</span>
              </>
            ) : isSyncing ? (
              <>
                <span className="w-2 h-2 rounded-full bg-teal-400 animate-pulse" />
                <RefreshCw className="w-3.5 h-3.5 text-teal-400 animate-spin" />
                <span className="text-teal-300 font-medium">Syncing...</span>
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                <Wifi className="w-3.5 h-3.5 text-slate-300" />
                <span className="text-slate-300 font-medium">Online</span>
              </>
            )}

            <button
              onClick={handleManualSync}
              disabled={isSyncing}
              className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition cursor-pointer"
              title="Synchronize local changes"
              aria-label="Synchronize data"
            >
              <RefreshCw className={`w-3 h-3 ${isSyncing ? 'animate-spin text-teal-400' : ''}`} />
            </button>
          </div>
        </div>

        {/* Right: Actions & User Menu */}
        <div className="flex items-center gap-2 sm:gap-3">
          {onViewLandingPage && (
            <button
              onClick={onViewLandingPage}
              className="text-xs text-slate-400 hover:text-white transition cursor-pointer hidden md:inline"
            >
              Public Site
            </button>
          )}

          <PWAInstallButton />

          {currentUser ? (
            <div className="relative">
              <button
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-800 text-xs text-slate-200 transition cursor-pointer"
              >
                <div className="w-6 h-6 rounded bg-slate-800 border border-slate-700 flex items-center justify-center text-teal-400 font-bold text-xs">
                  {currentUser.name.charAt(0)}
                </div>
                <div className="text-left hidden sm:block leading-tight">
                  <div className="font-semibold text-slate-200">{currentUser.name}</div>
                  <div className="text-[10px] text-slate-400">{currentUser.role}</div>
                </div>
                <ChevronDown className="w-3 h-3 text-slate-400" />
              </button>

              {showUserMenu && (
                <div
                  className="absolute right-0 mt-1 w-52 rounded bg-white text-slate-800 shadow-lg border border-slate-200 py-1 z-50 text-xs"
                  onMouseLeave={() => setShowUserMenu(false)}
                >
                  <div className="px-3 py-2 border-b border-slate-100">
                    <div className="font-semibold text-slate-900">{currentUser.name}</div>
                    <div className="text-[11px] text-slate-500 truncate">{currentUser.email}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5 font-medium">Role: <span className="text-teal-700 font-bold">{currentUser.role}</span></div>
                  </div>

                  <button
                    onClick={() => {
                      setShowUserMenu(false);
                      setIsChangePasswordOpen(true);
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700 flex items-center gap-1.5 font-medium transition cursor-pointer border-b border-slate-100"
                  >
                    <KeyRound className="w-3.5 h-3.5 text-teal-700" />
                    <span>Change My Password</span>
                  </button>

                  {onViewLandingPage && (
                    <button
                      onClick={() => {
                        setShowUserMenu(false);
                        onViewLandingPage();
                      }}
                      className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700 transition cursor-pointer"
                    >
                      View Public Site
                    </button>
                  )}

                  <button
                    onClick={() => {
                      setShowUserMenu(false);
                      onLogout();
                    }}
                    className="w-full text-left px-3 py-1.5 hover:bg-rose-50 text-rose-700 flex items-center gap-1.5 font-medium transition cursor-pointer"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>Sign Out</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={onOpenLogin}
              className="px-3 py-1 rounded bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold"
            >
              Sign In
            </button>
          )}
        </div>
      </header>

      {/* Change Password Modal */}
      <ChangePasswordModal
        isOpen={isChangePasswordOpen}
        onClose={() => setIsChangePasswordOpen(false)}
        currentUser={currentUser}
      />

      {/* Main Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Navigation Sidebar */}
        <aside className="w-48 bg-slate-900 border-r border-slate-800 flex flex-col shrink-0 text-slate-300 overflow-y-auto">
          <nav className="flex-1 px-1.5 py-2 space-y-0.5">
            {visibleNavItems.map((item) => {
              const active = currentModule === item.id;
              const Icon = item.icon;

              return (
                <button
                  key={item.id}
                  onClick={() => onSelectModule(item.id)}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded text-xs font-medium transition cursor-pointer ${
                    active
                      ? 'bg-teal-700 text-white font-semibold shadow-xs'
                      : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
                  }`}
                >
                  <Icon className={`w-3.5 h-3.5 shrink-0 ${active ? 'text-white' : 'text-slate-400'}`} />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Terminal Identifier Footer */}
          <div className="p-2 border-t border-slate-800 text-[10px] text-slate-500 truncate font-mono">
            {device?.id ? `Terminal: ${device.id}` : 'Station 01'}
          </div>
        </aside>

        {/* Content Outlet */}
        <main className="flex-1 flex flex-col overflow-hidden bg-slate-50">
          {children}
        </main>
      </div>
    </div>
  );
};
