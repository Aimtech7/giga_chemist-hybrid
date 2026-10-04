import React, { useState, useEffect } from 'react';
import {
  User,
  KeyRound,
  AlertCircle,
  ArrowLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { loginWithPinOrEmail } from '../../services/auth';
import type { User as UserType } from '../../types';

interface LoginPageProps {
  onSuccess: (user: UserType) => void;
  onBackToHome: () => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onSuccess, onBackToHome }) => {
  const [identifier, setIdentifier] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier.trim() || !secret.trim()) {
      setError('Please enter your email or username and your password or PIN.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const user = await loginWithPinOrEmail(identifier.trim(), secret.trim());
      onSuccess(user);
    } catch (err: any) {
      setError(err?.message || 'Authentication failed. Please verify your credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col justify-between font-sans selection:bg-teal-700 selection:text-white">
      {/* Top Header */}
      <header className="max-w-4xl mx-auto w-full px-4 sm:px-6 py-4 flex items-center justify-between text-xs">
        <button
          onClick={onBackToHome}
          className="inline-flex items-center gap-1.5 font-medium text-slate-600 hover:text-slate-900 transition cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Home</span>
        </button>

        <div className="flex items-center gap-2 text-slate-500 font-medium">
          {isOnline ? (
            <>
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              <Wifi className="w-3.5 h-3.5 text-slate-600" />
              <span>Online</span>
            </>
          ) : (
            <>
              <span className="w-2 h-2 rounded-full bg-amber-500" />
              <WifiOff className="w-3.5 h-3.5 text-amber-600" />
              <span>Offline Mode</span>
            </>
          )}
        </div>
      </header>

      {/* Main Centered Sign-In Panel */}
      <main className="max-w-md mx-auto w-full px-4 py-8 my-auto">
        <div className="bg-white rounded border border-slate-300 shadow-sm p-6 sm:p-8">
          {/* Brand & Heading */}
          <div className="text-center pb-6 border-b border-slate-200">
            <div className="w-9 h-9 rounded bg-teal-700 text-white font-bold text-sm flex items-center justify-center mx-auto mb-2.5">
              GC
            </div>
            <h1 className="text-lg font-bold text-slate-900 tracking-tight">
              GIGA CHEMIST
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Sign in to your pharmacy station
            </p>
          </div>

          {error && (
            <div className="mt-4 p-3 rounded bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <div className="leading-relaxed">{error}</div>
            </div>
          )}

          <form onSubmit={handleLogin} className="mt-5 space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Email or Username
              </label>
              <div className="relative">
                <User className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                <input
                  type="text"
                  required
                  autoFocus
                  placeholder="e.g. admin@gigachemist.co.ke"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 bg-white border border-slate-300 rounded text-xs text-slate-900 focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-semibold text-slate-700">
                  Password or Station PIN
                </label>
              </div>
              <div className="relative">
                <KeyRound className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  placeholder="Enter password or 4-digit PIN"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  className="w-full pl-9 pr-9 py-2 bg-white border border-slate-300 rounded text-xs text-slate-900 focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600 cursor-pointer"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 rounded bg-teal-700 hover:bg-teal-800 text-white font-semibold text-xs transition cursor-pointer flex items-center justify-center gap-1.5 mt-2 disabled:opacity-50"
            >
              {loading ? (
                <span>Signing in...</span>
              ) : (
                <>
                  <span>Sign In</span>
                  <ChevronRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <div className="mt-6 pt-4 border-t border-slate-200 text-center text-[11px] text-slate-500">
            For credential reset or role changes, contact your pharmacy administrator.
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="py-4 text-center text-[11px] text-slate-500">
        © {new Date().getFullYear()} GIGA CHEMIST. All rights reserved.
      </footer>
    </div>
  );
};
