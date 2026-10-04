import React, { useState, useEffect } from 'react';
import {
  Wifi,
  WifiOff,
  RefreshCw,
  User as UserIcon,
  ShieldAlert,
  LogOut,
  ChevronDown,
  Layers,
  Sparkles,
} from 'lucide-react';
import { PWAInstallButton } from './PWAInstallButton';
import { subscribeToSyncStatus, runSync, type SyncStatusSummary } from '../../services/syncEngine';
import type { User } from '../../types';

interface NavbarProps {
  currentUser: User | null;
  onOpenLogin: () => void;
  onLogout: () => void;
  onSelectRoleDemo?: (role: 'ADMIN' | 'MANAGER' | 'CASHIER') => void;
  onViewLandingPage?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentUser,
  onOpenLogin,
  onLogout,
  onSelectRoleDemo,
  onViewLandingPage,
}) => {
  const [syncStatus, setSyncStatus] = useState<SyncStatusSummary>({
    state: 'idle',
    pendingCount: 0,
    lastSyncedAt: null,
  });
  const [isManualSyncing, setIsManualSyncing] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);

  useEffect(() => {
    const unsub = subscribeToSyncStatus((status) => {
      setSyncStatus(status);
    });
    return unsub;
  }, []);

  const handleSyncNow = async () => {
    setIsManualSyncing(true);
    await runSync(true);
    setTimeout(() => setIsManualSyncing(false), 800);
  };

  const getRoleBadge = (role?: string) => {
    switch (role) {
      case 'ADMIN':
        return 'bg-purple-100 text-purple-800 border-purple-300';
      case 'MANAGER':
        return 'bg-blue-100 text-blue-800 border-blue-300';
      case 'CASHIER':
      default:
        return 'bg-amber-100 text-amber-800 border-amber-300';
    }
  };

  return (
    <header className="h-14 bg-slate-900 text-white flex items-center justify-between px-4 z-30 select-none border-b border-slate-800 shrink-0">
      {/* Brand & System Title */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-teal-600 text-white font-black text-sm tracking-tighter shadow-xs">
          GC
        </div>
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <span className="font-extrabold text-sm tracking-tight text-white">GIGA CHEMIST</span>
            <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-teal-950 text-teal-300 border border-teal-700/50">
              POS SYSTEM
            </span>
          </div>
          <span className="text-[10px] text-slate-400 font-medium">Offline-First Dispensing & Inventory</span>
        </div>
      </div>

      {/* Center: Real-time Network & Sync Status Bar */}
      <div className="flex items-center gap-2">
        <div
          className={`flex items-center gap-2 px-3 py-1 rounded text-xs font-semibold border transition ${
            syncStatus.state === 'synced'
              ? 'bg-emerald-950/80 border-emerald-700/60 text-emerald-300'
              : syncStatus.state === 'offline' || syncStatus.pendingCount > 0
              ? 'bg-amber-950/80 border-amber-700/60 text-amber-300'
              : syncStatus.state === 'error'
              ? 'bg-rose-950/80 border-rose-700/60 text-rose-300'
              : 'bg-slate-800 border-slate-700 text-slate-300'
          }`}
        >
          {syncStatus.state === 'offline' ? (
            <WifiOff className="w-3.5 h-3.5 text-amber-400" />
          ) : (
            <Wifi className="w-3.5 h-3.5 text-emerald-400" />
          )}

          <span>
            {syncStatus.state === 'offline'
              ? syncStatus.pendingCount > 0
                ? `OFFLINE — ${syncStatus.pendingCount} TRANSACTIONS PENDING`
                : 'OFFLINE MODE'
              : syncStatus.state === 'syncing' || isManualSyncing
              ? 'SYNCHRONIZING...'
              : syncStatus.state === 'error'
              ? 'SYNC ERROR — RETRY'
              : syncStatus.pendingCount > 0
              ? `${syncStatus.pendingCount} QUEUED TO SYNC`
              : 'ONLINE & SYNCED'}
          </span>

          <button
            onClick={handleSyncNow}
            disabled={isManualSyncing}
            className="ml-1 p-1 hover:bg-white/10 rounded transition cursor-pointer"
            title="Force synchronization with server"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 text-slate-300 hover:text-white ${
                isManualSyncing ? 'animate-spin text-teal-400' : ''
              }`}
            />
          </button>
        </div>
      </div>

      {/* Right Controls: PWA Install + User Profile & Fast Role Switcher */}
      <div className="flex items-center gap-3">
        {onViewLandingPage && (
          <button
            onClick={onViewLandingPage}
            className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 text-xs font-semibold transition cursor-pointer"
            title="View Public Landing Page"
          >
            <span>Public Site</span>
          </button>
        )}

        <PWAInstallButton />

        {currentUser ? (
          <div className="relative">
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="flex items-center gap-2 pl-2 pr-1.5 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 transition cursor-pointer text-xs"
            >
              <div className="w-6 h-6 rounded bg-slate-700 flex items-center justify-center text-teal-400 font-bold">
                {currentUser.name.charAt(0)}
              </div>
              <div className="text-left hidden sm:block">
                <div className="font-semibold text-slate-200 leading-tight">{currentUser.name}</div>
                <div className="flex items-center gap-1">
                  <span
                    className={`text-[9px] font-bold px-1 rounded uppercase tracking-wider border ${getRoleBadge(
                      currentUser.role
                    )}`}
                  >
                    {currentUser.role}
                  </span>
                </div>
              </div>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 ml-1" />
            </button>

            {showUserMenu && (
              <div
                className="absolute right-0 mt-1.5 w-64 rounded-md bg-white text-slate-800 shadow-xl border border-slate-200 py-1.5 z-50 text-xs"
                onMouseLeave={() => setShowUserMenu(false)}
              >
                <div className="px-3 py-2 border-b border-slate-100">
                  <div className="font-bold text-slate-900">{currentUser.name}</div>
                  <div className="text-[11px] text-slate-500 truncate">{currentUser.email}</div>
                  <div className="mt-1 flex items-center gap-1">
                    <span
                      className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${getRoleBadge(
                        currentUser.role
                      )}`}
                    >
                      ROLE: {currentUser.role}
                    </span>
                  </div>
                </div>

                {/* Quick Role Switcher for instant permission testing */}
                <div className="px-3 py-1.5 border-b border-slate-100 bg-slate-50">
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                    Fast Role Switch (Audit Logged)
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => {
                        onSelectRoleDemo?.('ADMIN');
                        setShowUserMenu(false);
                      }}
                      className={`flex-1 py-1 rounded text-[10px] font-bold transition ${
                        currentUser.role === 'ADMIN'
                          ? 'bg-purple-600 text-white'
                          : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                      }`}
                    >
                      Admin
                    </button>
                    <button
                      onClick={() => {
                        onSelectRoleDemo?.('MANAGER');
                        setShowUserMenu(false);
                      }}
                      className={`flex-1 py-1 rounded text-[10px] font-bold transition ${
                        currentUser.role === 'MANAGER'
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                      }`}
                    >
                      Manager
                    </button>
                    <button
                      onClick={() => {
                        onSelectRoleDemo?.('CASHIER');
                        setShowUserMenu(false);
                      }}
                      className={`flex-1 py-1 rounded text-[10px] font-bold transition ${
                        currentUser.role === 'CASHIER'
                          ? 'bg-amber-600 text-white'
                          : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                      }`}
                    >
                      Cashier
                    </button>
                  </div>
                </div>

                {onViewLandingPage && (
                  <button
                    onClick={() => {
                      setShowUserMenu(false);
                      onViewLandingPage();
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 text-slate-700 flex items-center gap-2 font-medium border-b border-slate-100"
                  >
                    <span>View Public Website</span>
                  </button>
                )}

                <button
                  onClick={() => {
                    setShowUserMenu(false);
                    onLogout();
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-rose-50 text-rose-600 flex items-center gap-2 font-medium"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Log Out Session</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          <button
            onClick={onOpenLogin}
            className="px-3 py-1.5 rounded bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold shadow-xs"
          >
            Sign In
          </button>
        )}
      </div>
    </header>
  );
};
