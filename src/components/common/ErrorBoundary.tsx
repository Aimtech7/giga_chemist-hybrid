import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Home, Trash2 } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[GIGA CHEMIST — Uncaught UI Error]', error, errorInfo);
    this.setState({ errorInfo });
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleGoHome = () => {
    window.location.href = '/';
  };

  private handleClearCacheAndReload = async () => {
    try {
      if ('caches' in window) {
        const cacheKeys = await caches.keys();
        await Promise.all(cacheKeys.map((key) => caches.delete(key)));
      }
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((reg) => reg.unregister()));
      }
      sessionStorage.clear();
    } catch (e) {
      console.warn('Failed to clear cache:', e);
    }
    window.location.href = '/';
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen w-screen flex flex-col items-center justify-center bg-slate-900 text-slate-100 p-6">
          <div className="max-w-md w-full bg-slate-800 border border-slate-700 rounded-2xl p-6 shadow-2xl text-center">
            <div className="w-16 h-16 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-400 flex items-center justify-center mx-auto mb-4">
              <AlertTriangle className="w-8 h-8" />
            </div>

            <h1 className="text-xl font-bold tracking-tight text-white mb-2">
              Application Recovery Screen
            </h1>
            <p className="text-sm text-slate-400 mb-6">
              GIGA CHEMIST encountered an unexpected interface error. Your pharmacy data in local storage and PostgreSQL is safe.
            </p>

            <div className="bg-slate-950/60 rounded-xl p-3 text-left mb-6 border border-slate-800">
              <div className="text-xs font-mono text-rose-300 break-words line-clamp-3">
                {this.state.error?.message || 'Unknown runtime error occurred.'}
              </div>
            </div>

            <div className="flex flex-col gap-2.5">
              <button
                type="button"
                onClick={this.handleReload}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-teal-600 hover:bg-teal-500 text-white font-semibold text-sm transition shadow-lg shadow-teal-900/30 active:scale-[0.98]"
              >
                <RefreshCw className="w-4 h-4" />
                Reload Application
              </button>

              <button
                type="button"
                onClick={this.handleGoHome}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-slate-200 font-medium text-sm transition active:scale-[0.98]"
              >
                <Home className="w-4 h-4" />
                Return to Login / Dashboard
              </button>

              <button
                type="button"
                onClick={this.handleClearCacheAndReload}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 text-slate-400 hover:text-slate-200 text-xs transition mt-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear Local Cache &amp; Re-sync
              </button>
            </div>
          </div>
          <div className="text-xs text-slate-500 mt-6">
            GIGA CHEMIST POS &bull; Version 1.0.0
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
