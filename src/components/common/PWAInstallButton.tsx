import React, { useState } from 'react';
import { usePWAInstall } from '../../hooks/usePWAInstall';
import { Download, Smartphone, X } from 'lucide-react';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  // If running as an installed PWA, hide the button
  if (isInstalled) {
    return null;
  }

  // Chromium / Android / Desktop flow
  if (isInstallable) {
    return (
      <button
        onClick={install}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold tracking-wide shadow-sm transition active:scale-95"
        title="Install GIGA CHEMIST on your computer or mobile device"
      >
        <Download className="w-3.5 h-3.5" />
        <span>Install App</span>
      </button>
    );
  }

  // iOS Safari flow
  if (isIOS) {
    return (
      <>
        <button
          onClick={() => setShowIOSGuide(true)}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 text-xs font-medium hover:bg-slate-100 transition"
        >
          <Smartphone className="w-3.5 h-3.5 text-emerald-600" />
          <span>Install on iOS</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
            <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-2xl border border-slate-200">
              <div className="flex justify-between items-center mb-3">
                <h3 className="text-base font-bold text-slate-900">Install GIGA CHEMIST on iOS</h3>
                <button
                  onClick={() => setShowIOSGuide(false)}
                  className="text-slate-400 hover:text-slate-600 p-1"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <p className="text-xs text-slate-600 leading-relaxed mb-4">
                1. Tap the <strong className="text-slate-900">Share</strong> icon (square with arrow up) in the Safari toolbar.<br />
                2. Scroll down and tap <strong className="text-slate-900">Add to Home Screen</strong>.<br />
                3. Tap <strong className="text-slate-900">Add</strong> in the top-right corner to install GIGA CHEMIST.
              </p>
              <button
                onClick={() => setShowIOSGuide(false)}
                className="w-full py-2 rounded bg-slate-100 text-slate-800 text-xs font-semibold hover:bg-slate-200 transition"
              >
                Close Instructions
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
