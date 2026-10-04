import React, { useState } from 'react';
import { Lock, User, KeyRound, AlertCircle, X, ShieldCheck } from 'lucide-react';
import { loginWithPinOrEmail } from '../../services/auth';
import type { User as UserType } from '../../types';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (user: UserType) => void;
}

export const LoginModal: React.FC<LoginModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [identifier, setIdentifier] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const user = await loginWithPinOrEmail(identifier, secret);
      onSuccess(user);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Login failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="w-full max-w-md bg-white rounded-lg shadow-2xl border border-slate-200 overflow-hidden text-slate-800 animate-in fade-in zoom-in-95 duration-150">
        <div className="bg-slate-900 px-5 py-4 text-white flex justify-between items-center">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-teal-600 flex items-center justify-center font-black text-sm text-white">
              GC
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">GIGA CHEMIST Terminal Sign In</h2>
              <p className="text-[11px] text-slate-400">Offline-capable authenticated session</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {error && (
            <div className="p-2.5 rounded bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-500" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Email Address or Username
              </label>
              <div className="relative">
                <User className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                <input
                  type="text"
                  required
                  placeholder="e.g. admin@gigachemist.co.ke"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded text-xs focus:ring-2 focus:ring-teal-500 focus:outline-hidden"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Password or 4-Digit PIN
              </label>
              <div className="relative">
                <KeyRound className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                <input
                  type="password"
                  required
                  placeholder="PIN or Password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded text-xs focus:ring-2 focus:ring-teal-500 focus:outline-hidden"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2 px-4 rounded bg-teal-600 hover:bg-teal-700 text-white font-semibold text-xs shadow-xs transition active:scale-98 disabled:opacity-50 cursor-pointer"
            >
              {loading ? 'Authenticating...' : 'Sign In to Register'}
            </button>
          </form>

        </div>
      </div>
    </div>
  );
};
