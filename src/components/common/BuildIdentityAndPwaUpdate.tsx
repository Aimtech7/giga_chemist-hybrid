import React, { useEffect, useState } from 'react';
import { RefreshCw, Sparkles, X, Info, Check, ShieldCheck } from 'lucide-react';
import { apiFetch } from '../../services/http';

declare const __FRONTEND_SHA__: string | undefined;
declare const __APP_VERSION__: string | undefined;
declare const __BUILD_TIME__: string | undefined;

interface BuildIdentityInfo {
  frontendSha: string;
  apiSha: string;
  shopSha: string;
  version: string;
  buildTime: string;
}

export const BuildIdentityAndPwaUpdate: React.FC = () => {
  const [hasUpdate, setHasUpdate] = useState(false);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const [reloading, setReloading] = useState(false);
  const [showModal, setShowModal] = useState(false);

  const [buildInfo, setBuildInfo] = useState<BuildIdentityInfo>({
    frontendSha: typeof __FRONTEND_SHA__ !== 'undefined' ? __FRONTEND_SHA__ : 'dev',
    apiSha: '—',
    shopSha: '—',
    version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0',
    buildTime: typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : new Date().toISOString(),
  });

  // 1. PWA Service Worker Update Detection
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      const lastReload = Number(sessionStorage.getItem('last_pwa_reload') || '0');
      if (Date.now() - lastReload > 10000) {
        sessionStorage.setItem('last_pwa_reload', String(Date.now()));
        window.location.reload();
      }
    });

    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) return;

      if (reg.waiting) {
        setWaitingWorker(reg.waiting);
        setHasUpdate(true);
      }

      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            setWaitingWorker(newWorker);
            setHasUpdate(true);
          }
        });
      });
    }).catch(() => {});
  }, []);

  // 2. Fetch API & Shop SHAs
  useEffect(() => {
    void apiFetch<any>('/api/health').then((h) => {
      if (h) {
        setBuildInfo((prev) => ({
          ...prev,
          apiSha: h.git_commit || h.status?.git_commit || prev.apiSha,
          shopSha: h.shop_commit || h.runtime?.git_commit || h.status?.git_commit || prev.shopSha,
        }));
      }
    }).catch(() => {});
  }, []);

  const handleReload = () => {
    setReloading(true);
    const lastReload = Number(sessionStorage.getItem('last_pwa_reload') || '0');
    sessionStorage.setItem('last_pwa_reload', String(Date.now()));

    if (waitingWorker) {
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    }

    // Fallback reload if controllerchange doesn't fire immediately
    setTimeout(() => {
      window.location.reload();
    }, 500);
  };

  const shortSha = (sha: string) => (sha && sha !== '—' && sha !== 'dev' ? sha.slice(0, 7) : sha);

  return (
    <>
      {/* PWA Update Banner */}
      {hasUpdate && (
        <div className="bg-teal-900 border-b border-teal-700 text-white px-3 py-2 flex items-center justify-between text-xs z-50 fixed top-0 inset-x-0 shadow-md">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-300 animate-pulse" />
            <span className="font-bold tracking-wide">NEW VERSION AVAILABLE</span>
            <span className="text-teal-200 hidden sm:inline">A newer frontend build has been deployed.</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleReload}
              disabled={reloading}
              className="px-2.5 py-1 bg-amber-400 hover:bg-amber-300 text-slate-900 font-bold rounded text-[11px] flex items-center gap-1 transition shadow-xs cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${reloading ? 'animate-spin' : ''}`} />
              <span>{reloading ? 'Reloading...' : 'Reload Now'}</span>
            </button>
            <button
              onClick={() => setHasUpdate(false)}
              className="text-teal-300 hover:text-white p-0.5 rounded cursor-pointer"
              aria-label="Dismiss banner"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Visible Build Identity (Compact in sidebar footer) */}
      <div
        onClick={() => setShowModal(true)}
        className="px-2 py-1.5 border-t border-slate-800 text-[10px] text-slate-400 hover:text-slate-200 cursor-pointer transition flex items-center justify-between select-none"
        title="Click to view full build identity & versions"
      >
        <span className="font-mono">v{buildInfo.version} · {shortSha(buildInfo.frontendSha)}</span>
        <ShieldCheck className="w-3 h-3 text-teal-400 shrink-0" />
      </div>

      {/* Build Identity Details Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl max-w-sm w-full p-4 shadow-xl border border-slate-200 text-xs">
            <div className="flex items-center justify-between mb-3 border-b border-slate-100 pb-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-teal-700" />
                <span className="font-bold text-slate-900 text-sm">System Build Identity</span>
              </div>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2 font-mono">
              <div className="flex justify-between py-1 border-b border-slate-50">
                <span className="text-slate-500 font-sans">VERSION</span>
                <span className="font-bold text-slate-800">{buildInfo.version}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-slate-50">
                <span className="text-slate-500 font-sans">FRONTEND SHA</span>
                <span className="font-bold text-teal-800">{shortSha(buildInfo.frontendSha)}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-slate-50">
                <span className="text-slate-500 font-sans">API SHA</span>
                <span className="font-bold text-slate-800">{shortSha(buildInfo.apiSha)}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-slate-50">
                <span className="text-slate-500 font-sans">SHOP SHA</span>
                <span className="font-bold text-slate-800">{shortSha(buildInfo.shopSha)}</span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-slate-500 font-sans">BUILD TIME</span>
                <span className="text-slate-700 text-[10px]">{new Date(buildInfo.buildTime).toLocaleString()}</span>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-100 flex justify-end">
              <button
                onClick={() => setShowModal(false)}
                className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
