import React, { useState, useEffect } from 'react';
import { db, getSettings, DEFAULT_SETTINGS } from './db/dexie';
import { getCachedUser, setCachedUser, logoutUser, verifySession } from './services/auth';
import { SESSION_EXPIRED_EVENT } from './services/session';
import { getOrRegisterDevice } from './services/device';
import { refreshNetworkStatus } from './services/network';
import { syncFromLocalApiToDexie } from './services/syncEngine';
import { canAccessModule, isCashier } from './services/permissions';
import { AppShell, type AppModule } from './components/layout/AppShell';
import { LoginModal } from './components/common/LoginModal';
import { LandingPage } from './components/public/LandingPage';
import { LoginPage } from './components/auth/LoginPage';
import { Dashboard } from './components/dashboard/Dashboard';
import { PosScreen } from './components/pos/PosScreen';
import { MedicineList } from './components/inventory/MedicineList';
import { InventoryManager } from './components/inventory/InventoryManager';
import { PhysicalStockCount } from './components/stocktake/PhysicalStockCount';
import { StocktakeSessions } from './components/stocktake/StocktakeSessions';
import { InventoryInsights } from './components/inventory/InventoryInsights';
import { AlertsCenter } from './components/alerts/AlertsCenter';
import { SyncCenter } from './components/sync/SyncCenter';
import { BusinessDayView } from './components/reports/BusinessDayView';
import { IntegrityDashboard } from './components/settings/IntegrityDashboard';
import { BatchList } from './components/inventory/BatchList';
import { ExpiryManager } from './components/expiry/ExpiryManager';
import { PurchaseList } from './components/purchases/PurchaseList';
import { SupplierList } from './components/suppliers/SupplierList';
import { CustomerList } from './components/customers/CustomerList';
import { ExpenseList } from './components/expenses/ExpenseList';
import { SalesHistory } from './components/sales/SalesHistory';
import { ReturnsManager } from './components/returns/ReturnsManager';
import { ReportsDashboard } from './components/reports/ReportsDashboard';
import { UserManagement } from './components/users/UserManagement';
import { AuditLogViewer } from './components/audit/AuditLogViewer';
import { SettingsView } from './components/settings/SettingsView';
import { RemoteAdminPanel } from './components/remote/RemoteAdminPanel';
import { OnlineAdminModule } from './components/remote/OnlineAdminModule';
import { HistoryView, type HistoryFilters, type HistoryTab } from './components/history/HistoryView';
import { NAVIGATE_EVENT } from './services/navigation';
import { getServerMode } from './services/remoteAdmin';
import { startRealtimeSync, stopRealtimeSync } from './services/realtimeSync';
import type { PharmacySettings, User } from './types';

// '#app' (or any unknown hash) is not a module and must never become the current one (blank screen).
const KNOWN_MODULES: AppModule[] = [
  'dashboard', 'pos', 'medicines', 'inventory', 'stocktake', 'stocktakes', 'insights', 'alerts', 'sync', 'businessday', 'integrity', 'batches', 'expiry', 'purchases', 'suppliers',
  'customers', 'expenses', 'sales', 'returns', 'reports', 'users', 'audit', 'settings', 'remote', 'history',
];

export default function App() {
  const [viewMode, setViewMode] = useState<'landing' | 'login' | 'app'>('landing');
  const [currentModule, setCurrentModule] = useState<AppModule>('pos');
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [settings, setSettings] = useState<PharmacySettings | null>(null);
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [serverMode, setServerMode] = useState<string | null>(null);

  useEffect(() => {
    // Check initial route from hash or path with strict protection
    const checkRoute = () => {
      const hash = window.location.hash.toLowerCase();
      const path = window.location.pathname.toLowerCase();
      const cached = getCachedUser();

      const isProtected =
        path === '/app' ||
        path === '/dashboard' ||
        path === '/pos' ||
        path === '/inventory' ||
        path === '/stocktake' ||
        path === '/batches' ||
        path === '/expiry' ||
        path === '/purchases' ||
        path === '/suppliers' ||
        path === '/expenses' ||
        path === '/reports' ||
        path === '/settings' ||
        path === '/users' ||
        path === '/audit-logs' ||
        hash.startsWith('#app') ||
        hash.startsWith('#dashboard') ||
        hash.startsWith('#pos') ||
        hash.startsWith('#inventory') ||
        hash.startsWith('#stocktake') ||
        hash.startsWith('#reports') ||
        hash.startsWith('#settings');

      const isLogin = path === '/login' || hash === '#login';

      if (isProtected) {
        if (cached) {
          if (isCashier(cached)) {
            // Cashier must land directly on POS
            setCurrentModule('pos');
          } else {
            const rawModule = hash.replace('#', '').replace('/app/', '') as AppModule;
            // Only real module names ("#app" is the shell, not a module: it used to blank the screen for Admins).
            if (rawModule && KNOWN_MODULES.includes(rawModule) && canAccessModule(cached, rawModule)) {
              setCurrentModule(rawModule);
            }
          }
          setViewMode('app');
        } else {
          // Redirect unauthenticated user to login
          window.location.hash = '#login';
          setViewMode('login');
        }
      } else if (isLogin) {
        if (cached) {
          // Logged-in user visiting /login -> redirect to protected app
          window.location.hash = '#app';
          if (isCashier(cached)) {
            setCurrentModule('pos');
          }
          setViewMode('app');
        } else {
          setViewMode('login');
        }
      } else {
        // Landing page (path === '/' or anchor tags like #features, #offline, #how-it-works)
        setViewMode('landing');
      }
    };

    checkRoute();
    window.addEventListener('popstate', checkRoute);
    window.addEventListener('hashchange', checkRoute);

    return () => {
      window.removeEventListener('popstate', checkRoute);
      window.removeEventListener('hashchange', checkRoute);
    };
  }, []);

  const navigateToLanding = () => {
    setViewMode('landing');
    if (window.location.hash === '#login' || window.location.hash === '#app') {
      window.history.pushState(null, '', window.location.pathname);
    }
  };

  const navigateToLogin = () => {
    const cached = getCachedUser();
    if (cached) {
      setViewMode('app');
      window.location.hash = '#app';
      return;
    }
    setViewMode('login');
    window.location.hash = '#login';
  };

  const handleSelectModule = (module: AppModule) => {
    if (!canAccessModule(currentUser, module)) {
      // Forbidden: redirect to POS
      setCurrentModule('pos');
      return;
    }
    setCurrentModule(module);
  };

  const navigateToApp = (module: AppModule = 'pos') => {
    const cached = getCachedUser();
    if (!cached && !currentUser) {
      navigateToLogin();
      return;
    }
    const userToEvaluate = currentUser || cached;
    const targetModule = isCashier(userToEvaluate) ? 'pos' : (canAccessModule(userToEvaluate, module) ? module : 'pos');
    setCurrentModule(targetModule);
    setViewMode('app');
    window.location.hash = '#app';
  };

  useEffect(() => {
    let isMounted = true;
    async function init() {
      try {
        // Register device ID
        await getOrRegisterDevice().catch((e) => console.warn('[App] Device reg error:', e));

        // Load settings with fallback
        let loadedSettings: PharmacySettings | null = null;
        try {
          loadedSettings = await getSettings();
        } catch (e) {
          console.warn('[App] Failed to load settings:', e);
        }
        if (isMounted) {
          setSettings(loadedSettings || DEFAULT_SETTINGS);
        }

        // Restore the session only if the server still accepts its token (role/active from the DB).
        try {
          const verified = await verifySession();
          if (verified && isMounted) {
            setCurrentUser(verified);
            if (isCashier(verified)) {
              setCurrentModule('pos');
            }
            syncFromLocalApiToDexie().catch((e) => console.warn('[App] Local sync failed:', e));
            startRealtimeSync().catch((e) => console.warn('[App] Realtime sync error:', e));
          } else if (isMounted) {
            setCurrentUser(null);
          }
        } catch (e) {
          console.warn('[App] Session verification error:', e);
        }

        // Initialize network and sync monitoring
        try {
          await refreshNetworkStatus();
        } catch (e) {
          console.warn('[App] Network refresh error:', e);
        }

        if (isMounted) {
          setIsInitialized(true);
        }
      } catch (err) {
        console.error('Initialization error:', err);
        if (isMounted) {
          setSettings((prev) => prev || DEFAULT_SETTINGS);
          setIsInitialized(true);
        }
      }
    }

    // Safety timeout: Never hang on bootstrap screen for more than 3 seconds
    const timeout = setTimeout(() => {
      if (isMounted) {
        setSettings((prev) => prev || DEFAULT_SETTINGS);
        setIsInitialized(true);
      }
    }, 3000);

    init();

    return () => {
      isMounted = false;
      clearTimeout(timeout);
    };
  }, []);

  const handleLogout = async () => {
    stopRealtimeSync();
    await logoutUser(currentUser || undefined);
    setCachedUser(null);
    setCurrentUser(null);
    navigateToLanding();
  };

  // Any 401 from the API (or an expired token) ends the session and returns to the login screen.
  useEffect(() => {
    const onExpired = () => {
      setCurrentUser(null);
      setViewMode('login');
      window.location.hash = '#login';
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  // Online app (Vercel): there is no till online, so the Administrator lands on the Global Control Center.
  useEffect(() => {
    if (currentUser?.role !== 'ADMIN') return;
    void getServerMode().then((mode) => {
      setServerMode(mode);
      if (mode === 'online') setCurrentModule((m) => (m === 'pos' || m === 'stocktake' || m === 'stocktakes' ? 'dashboard' : m));
    });
  }, [currentUser]);
  const onlineAdmin = serverMode === 'online' && currentUser?.role === 'ADMIN';
  // Dashboard shortcuts ("View All Sales", "View Supply History"): same shop context, chosen tab.
  const [historyTab, setHistoryTab] = useState<HistoryTab>('sales');
  const [historyFilters, setHistoryFilters] = useState<HistoryFilters | null>(null);
  useEffect(() => {
    const go = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      if (d.tab) setHistoryTab(d.tab);
      setHistoryFilters(d.filters || null);
      if (d.module) setCurrentModule(d.module);
    };
    window.addEventListener(NAVIGATE_EVENT, go);
    return () => window.removeEventListener(NAVIGATE_EVENT, go);
  }, []);

  if (!isInitialized || !settings) {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-slate-900 text-white">
        <div className="w-12 h-12 rounded-lg bg-teal-600 flex items-center justify-center font-black text-xl mb-3 animate-pulse">
          GC
        </div>
        <h1 className="text-base font-bold tracking-tight">GIGA CHEMIST</h1>
        <p className="text-xs text-slate-400 mt-1">Bootstrapping Pharmacy Engine &amp; Local Storage...</p>
      </div>
    );
  }

  // 1. PUBLIC LANDING PAGE (Route: /)
  if (viewMode === 'landing') {
    return (
      <LandingPage
        onEnterApp={() => {
          if (currentUser) {
            navigateToApp('pos');
          } else {
            navigateToLogin();
          }
        }}
        onOpenLogin={navigateToLogin}
        currentUser={currentUser}
      />
    );
  }

  // 2. DEDICATED SIGN-IN PAGE (Route: /login)
  if (viewMode === 'login') {
    return (
      <LoginPage
        onSuccess={(user) => {
          setCurrentUser(user);
          syncFromLocalApiToDexie().catch((e) => console.warn('[App] Post-login sync notice:', e));
          startRealtimeSync().catch((e) => console.warn('[App] Post-login realtime notice:', e));
          navigateToApp(user.role === 'CASHIER' ? 'pos' : 'dashboard');
        }}
        onBackToHome={navigateToLanding}
      />
    );
  }

  // 3. PRIVATE AUTHENTICATED PHARMACY WORKSTATION (Route: /app or /dashboard)
  // Strict route protection: If user is not authenticated, display login
  if (!currentUser) {
    return (
      <LoginPage
        onSuccess={(user) => {
          setCurrentUser(user);
          syncFromLocalApiToDexie().catch((e) => console.warn('[App] Post-login sync notice:', e));
          startRealtimeSync().catch((e) => console.warn('[App] Post-login realtime notice:', e));
          navigateToApp(user.role === 'CASHIER' ? 'pos' : 'dashboard');
        }}
        onBackToHome={navigateToLanding}
      />
    );
  }

  // 3. PRIVATE AUTHENTICATED PHARMACY WORKSTATION
  return (
    <AppShell
      currentModule={currentModule}
      onSelectModule={handleSelectModule}
      currentUser={currentUser}
      settings={settings}
      onOpenLogin={() => setIsLoginOpen(true)}
      onLogout={handleLogout}
      onViewLandingPage={navigateToLanding}
    >
      {/* ONLINE ADMINISTRATOR: Global Control Center modules (commands to the selected shop only) */}
      {onlineAdmin && canAccessModule(currentUser, currentModule) && (
        <OnlineAdminModule module={currentModule} currentUser={currentUser} settings={settings} historyTab={historyTab} historyFilters={historyFilters} />
      )}
      {!onlineAdmin && (<>
      {/* EXECUTIVE & OPERATIONAL DASHBOARD */}
      {currentModule === 'dashboard' && (
        <Dashboard currentUser={currentUser} settings={settings} onNavigate={handleSelectModule} />
      )}

      {/* POS REGISTER */}
      {currentModule === 'pos' && (
        <PosScreen currentUser={currentUser} settings={settings} />
      )}

      {/* MEDICINES / MEDICINE LOOKUP (online Administrator: the remote-management view of the same catalog) */}
      {currentModule === 'medicines' && serverMode === 'online' && currentUser?.role === 'ADMIN' && (
        <RemoteAdminPanel currentUser={currentUser} settings={settings} />
      )}
      {currentModule === 'medicines' && !(serverMode === 'online' && currentUser?.role === 'ADMIN') && (
        <MedicineList currentUser={currentUser} settings={settings} />
      )}

      {/* INVENTORY - Restricted to Admin/Manager */}
      {currentModule === 'inventory' && canAccessModule(currentUser, 'inventory') && (
        <InventoryManager currentUser={currentUser} settings={settings} />
      )}

      {/* PHYSICAL STOCK COUNT (FAST STOCKTAKE) - Restricted to Admin */}
      {currentModule === 'stocktake' && canAccessModule(currentUser, 'stocktake') && (
        <PhysicalStockCount currentUser={currentUser} settings={settings} />
      )}

      {/* STOCKTAKE SESSIONS - count first, Administrator approval applies (cashiers: blind counting when allowed) */}
      {currentModule === 'stocktakes' && canAccessModule(currentUser, 'stocktakes') && (
        <StocktakeSessions currentUser={currentUser} settings={settings} />
      )}

      {/* STOCK INSIGHTS - reorder, fast / slow / dead stock, expiry risk, reconciliation (read only) */}
      {currentModule === 'insights' && canAccessModule(currentUser, 'insights') && (
        <InventoryInsights currentUser={currentUser} online={serverMode === 'online'} />
      )}

      {/* ALERTS CENTER - local (offline-capable) or the selected shop online */}
      {currentModule === 'alerts' && canAccessModule(currentUser, 'alerts') && (
        <AlertsCenter currentUser={currentUser} online={serverMode === 'online'} />
      )}

      {/* SYNC & CONFLICT CENTER - Administrator */}
      {currentModule === 'sync' && canAccessModule(currentUser, 'sync') && (
        <SyncCenter online={serverMode === 'online'} />
      )}

      {/* BUSINESS DAY SUMMARY (read only) + DATA INTEGRITY (shop computer, Administrator) */}
      {currentModule === 'businessday' && canAccessModule(currentUser, 'businessday') && <BusinessDayView settings={settings} />}
      {currentModule === 'integrity' && canAccessModule(currentUser, 'integrity') && <IntegrityDashboard />}

      {/* BATCHES - Restricted to Admin/Manager */}
      {currentModule === 'batches' && canAccessModule(currentUser, 'batches') && (
        <BatchList currentUser={currentUser} settings={settings} />
      )}

      {/* EXPIRY - Restricted to Admin/Manager */}
      {currentModule === 'expiry' && canAccessModule(currentUser, 'expiry') && (
        <ExpiryManager currentUser={currentUser} settings={settings} />
      )}

      {/* PURCHASES - Restricted to Admin/Manager */}
      {currentModule === 'purchases' && canAccessModule(currentUser, 'purchases') && (
        <PurchaseList currentUser={currentUser} settings={settings} />
      )}

      {/* SUPPLIERS - Restricted to Admin/Manager */}
      {currentModule === 'suppliers' && canAccessModule(currentUser, 'suppliers') && (
        <SupplierList currentUser={currentUser} settings={settings} />
      )}

      {/* CUSTOMERS */}
      {currentModule === 'customers' && canAccessModule(currentUser, 'customers') && (
        <CustomerList settings={settings} />
      )}

      {/* EXPENSES - Restricted to Admin/Manager */}
      {currentModule === 'expenses' && canAccessModule(currentUser, 'expenses') && (
        <ExpenseList currentUser={currentUser} settings={settings} />
      )}

      {/* SALES */}
      {currentModule === 'sales' && canAccessModule(currentUser, 'sales') && (
        <SalesHistory currentUser={currentUser} settings={settings} />
      )}

      {/* HISTORY (Admin / Manager): every past sale and supply, read only */}
      {currentModule === 'history' && canAccessModule(currentUser, 'history') && (
        <HistoryView settings={settings} currentUser={currentUser} initialTab={historyTab} initialFilters={historyFilters} />
      )}

      {/* RETURNS */}
      {currentModule === 'returns' && canAccessModule(currentUser, 'returns') && (
        <ReturnsManager currentUser={currentUser} settings={settings} />
      )}

      {/* REPORTS - Restricted to Admin/Manager */}
      {currentModule === 'reports' && canAccessModule(currentUser, 'reports') && (
        <ReportsDashboard currentUser={currentUser} settings={settings} />
      )}

      {/* USERS - Restricted to Admin */}
      {currentModule === 'users' && canAccessModule(currentUser, 'users') && (
        <UserManagement currentUser={currentUser} />
      )}

      {/* AUDIT LOGS - Restricted to Admin */}
      {currentModule === 'audit' && canAccessModule(currentUser, 'audit') && (
        <AuditLogViewer currentUser={currentUser} />
      )}

      {/* SETTINGS - Restricted to Admin */}
      {currentModule === 'settings' && canAccessModule(currentUser, 'settings') && (
        <SettingsView
          currentUser={currentUser}
          settings={settings}
          onSettingsUpdated={(updated) => setSettings(updated)}
        />
      )}

      {/* REMOTE ADMIN - online app, Administrator only (changes are queued for the shop computer) */}
      {currentModule === 'remote' && canAccessModule(currentUser, 'remote') && (
        <RemoteAdminPanel currentUser={currentUser} settings={settings} />
      )}

      </>)}

      {/* Login Modal */}
      <LoginModal
        isOpen={isLoginOpen}
        onClose={() => setIsLoginOpen(false)}
        onSuccess={(user) => {
          setCurrentUser(user);
          if (isCashier(user)) {
            setCurrentModule('pos');
          }
        }}
      />
    </AppShell>
  );
}
