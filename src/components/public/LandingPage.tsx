import React, { useState } from 'react';
import {
  ShoppingCart,
  ShieldCheck,
  Zap,
  WifiOff,
  Boxes,
  Clock,
  ArrowRight,
  Lock,
  ChevronRight,
  Menu,
  X,
  Search,
} from 'lucide-react';
import type { User } from '../../types';

interface LandingPageProps {
  onEnterApp: () => void;
  onOpenLogin: () => void;
  currentUser: User | null;
}

export const LandingPage: React.FC<LandingPageProps> = ({
  onEnterApp,
  onOpenLogin,
  currentUser,
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleSignIn = () => {
    if (currentUser) {
      onEnterApp();
    } else {
      onOpenLogin();
    }
  };

  return (
    <div className="min-h-screen bg-white text-slate-900 flex flex-col font-sans selection:bg-teal-700 selection:text-white">
      {/* 1. CLEAN STICKY NAVBAR */}
      <header className="sticky top-0 z-40 bg-white border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          {/* Logo / Brand */}
          <a href="#home" className="flex items-center gap-2.5">
            <span className="w-7 h-7 rounded bg-teal-700 text-white flex items-center justify-center font-bold text-xs">
              GC
            </span>
            <div className="leading-tight">
              <span className="text-sm font-bold tracking-tight text-slate-900 block">
                GIGA CHEMIST
              </span>
              <span className="text-[10px] text-slate-500 font-medium block">
                Pharmacy POS &amp; Inventory
              </span>
            </div>
          </a>

          {/* Desktop Links */}
          <nav className="hidden md:flex items-center gap-6 text-xs font-semibold text-slate-600">
            <a href="#home" className="hover:text-slate-900 transition">Home</a>
            <a href="#features" className="hover:text-slate-900 transition">Features</a>
            <a href="#offline" className="hover:text-slate-900 transition">Offline</a>
            <a href="#how-it-works" className="hover:text-slate-900 transition">How It Works</a>
          </nav>

          {/* Single Action: Sign In */}
          <div className="hidden sm:flex items-center">
            <button
              onClick={handleSignIn}
              className="px-4 py-1.5 rounded bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold shadow-xs transition cursor-pointer flex items-center gap-1.5"
            >
              <span>{currentUser ? 'Open Dashboard' : 'Sign In'}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Mobile Menu Hamburger */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="md:hidden p-1.5 rounded text-slate-700 hover:bg-slate-100 transition cursor-pointer"
            aria-label="Toggle navigation menu"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>

        {/* Mobile Dropdown */}
        {mobileMenuOpen && (
          <div className="md:hidden border-b border-slate-200 bg-white px-4 py-3 space-y-2">
            <nav className="flex flex-col gap-1 text-xs font-medium text-slate-700">
              <a
                href="#home"
                onClick={() => setMobileMenuOpen(false)}
                className="py-1.5 hover:text-slate-900"
              >
                Home
              </a>
              <a
                href="#features"
                onClick={() => setMobileMenuOpen(false)}
                className="py-1.5 hover:text-slate-900"
              >
                Features
              </a>
              <a
                href="#offline"
                onClick={() => setMobileMenuOpen(false)}
                className="py-1.5 hover:text-slate-900"
              >
                Offline
              </a>
              <a
                href="#how-it-works"
                onClick={() => setMobileMenuOpen(false)}
                className="py-1.5 hover:text-slate-900"
              >
                How It Works
              </a>
            </nav>
            <div className="pt-2 border-t border-slate-100">
              <button
                onClick={() => {
                  setMobileMenuOpen(false);
                  handleSignIn();
                }}
                className="w-full py-2 text-center text-xs font-semibold text-white bg-teal-700 rounded hover:bg-teal-800 transition cursor-pointer"
              >
                {currentUser ? 'Open Dashboard' : 'Sign In'}
              </button>
            </div>
          </div>
        )}
      </header>

      {/* 2. HERO SECTION */}
      <section id="home" className="py-12 md:py-16 bg-slate-50 border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-center">
            {/* Left Column */}
            <div className="lg:col-span-6 space-y-4">
              <h1 className="text-3xl sm:text-4xl font-black text-slate-900 tracking-tight leading-tight">
                GIGA CHEMIST
              </h1>
              <p className="text-xl sm:text-2xl font-bold text-teal-800 tracking-tight">
                Smart Pharmacy Management. Online or Offline.
              </p>
              <p className="text-xs sm:text-sm text-slate-600 leading-relaxed font-normal">
                GIGA CHEMIST is an offline-ready pharmacy POS and inventory management system designed for fast sales, secure stock control, medicine batches and expiry management.
              </p>

              {/* Single Action Button */}
              <div className="pt-2 flex items-center gap-3">
                <button
                  onClick={handleSignIn}
                  className="px-5 py-2.5 rounded bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold shadow-xs transition cursor-pointer flex items-center gap-2"
                >
                  <Lock className="w-3.5 h-3.5" />
                  <span>{currentUser ? 'Open Dashboard' : 'Sign In'}</span>
                </button>
              </div>

              {/* Unboxed Metadata Trust Line */}
              <div className="pt-3 border-t border-slate-200 text-xs text-slate-500 flex flex-wrap items-center gap-2">
                <span>Works offline</span>
                <span aria-hidden="true">·</span>
                <span>Secure stock control</span>
                <span aria-hidden="true">·</span>
                <span>Automatic synchronization</span>
              </div>
            </div>

            {/* Right Column: Clean Operational POS Preview */}
            <div className="lg:col-span-6">
              <div className="bg-white rounded border border-slate-300 shadow-sm overflow-hidden">
                {/* Header bar */}
                <div className="bg-slate-900 text-slate-300 px-3 py-2 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-400" />
                    <span className="font-semibold text-white">POS Register</span>
                    <span className="text-slate-500">|</span>
                    <span className="text-[11px] font-mono text-slate-400">Terminal 01</span>
                  </div>
                  <span className="text-[10px] text-slate-400 font-mono">ONLINE</span>
                </div>

                {/* Body */}
                <div className="p-3 sm:p-4 bg-slate-50 space-y-3">
                  <div className="flex items-center gap-2 bg-white px-2.5 py-1.5 rounded border border-slate-300 text-xs">
                    <Search className="w-3.5 h-3.5 text-slate-400" />
                    <span className="text-slate-700 font-medium">Panadol Extra 500mg</span>
                    <span className="ml-auto text-[10px] text-slate-500 font-mono">Lot #PAN-9921</span>
                  </div>

                  <div className="bg-white rounded border border-slate-200 divide-y divide-slate-100 text-xs">
                    <div className="p-2 flex items-center justify-between">
                      <div>
                        <div className="font-semibold text-slate-800">Amoxicillin 500mg Caps</div>
                        <div className="text-[11px] text-slate-500">Batch AMX-2026-A · Exp Dec 2026</div>
                      </div>
                      <div className="text-right">
                        <span className="text-slate-500 font-mono">2 × KES 45.00</span>
                        <div className="font-semibold text-slate-900 font-mono">KES 90.00</div>
                      </div>
                    </div>

                    <div className="p-2 flex items-center justify-between">
                      <div>
                        <div className="font-semibold text-slate-800">Panadol Extra 500mg Tabs</div>
                        <div className="text-[11px] text-slate-500">Batch PAN-9921 · Exp Oct 2026</div>
                      </div>
                      <div className="text-right">
                        <span className="text-slate-500 font-mono">1 × KES 30.00</span>
                        <div className="font-semibold text-slate-900 font-mono">KES 30.00</div>
                      </div>
                    </div>

                    <div className="p-2 flex items-center justify-between">
                      <div>
                        <div className="font-semibold text-slate-800">Cetirizine 10mg Tabs</div>
                        <div className="text-[11px] text-slate-500">Batch CTZ-5501 · Exp Aug 2027</div>
                      </div>
                      <div className="text-right">
                        <span className="text-slate-500 font-mono">1 × KES 150.00</span>
                        <div className="font-semibold text-slate-900 font-mono">KES 150.00</div>
                      </div>
                    </div>
                  </div>

                  <div className="p-2.5 bg-white rounded border border-slate-200 flex items-center justify-between">
                    <div>
                      <div className="text-[10px] uppercase font-bold text-slate-500">Total Payable</div>
                      <div className="text-base font-bold font-mono text-slate-900">KES 270.00</div>
                    </div>
                    <div className="flex gap-1 text-[11px] font-semibold text-slate-700">
                      <span className="px-2 py-0.5 rounded bg-slate-100 border border-slate-300">Cash</span>
                      <span className="px-2 py-0.5 rounded bg-slate-100 border border-slate-200">M-Pesa</span>
                      <span className="px-2 py-0.5 rounded bg-slate-100 border border-slate-200">Card</span>
                    </div>
                  </div>
                </div>

                <div className="bg-slate-100 px-3 py-1.5 border-t border-slate-200 flex items-center justify-between text-[11px] text-slate-500">
                  <span>ESC/POS thermal printer and USB scanner support</span>
                  <button
                    onClick={handleSignIn}
                    className="text-teal-700 font-semibold hover:text-teal-900 flex items-center gap-1 cursor-pointer"
                  >
                    <span>Sign In</span>
                    <ChevronRight className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 3. FEATURES SECTION */}
      <section id="features" className="py-12 md:py-16 bg-white border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="mb-8">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
              Essential Capabilities
            </h2>
            <p className="text-xs sm:text-sm text-slate-600 mt-1">
              Core tools built specifically for clinical dispensing and retail pharmacy operations.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="p-4 rounded border border-slate-200 bg-slate-50/50">
              <div className="w-7 h-7 rounded bg-teal-50 border border-teal-200 text-teal-800 flex items-center justify-center font-bold mb-2.5">
                <ShoppingCart className="w-3.5 h-3.5" />
              </div>
              <h3 className="text-sm font-bold text-slate-900">Fast Pharmacy POS</h3>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                Search medicines, scan barcodes, build the cart and complete sales quickly.
              </p>
            </div>

            <div className="p-4 rounded border border-slate-200 bg-slate-50/50">
              <div className="w-7 h-7 rounded bg-teal-50 border border-teal-200 text-teal-800 flex items-center justify-center font-bold mb-2.5">
                <WifiOff className="w-3.5 h-3.5" />
              </div>
              <h3 className="text-sm font-bold text-slate-900">Offline Operation</h3>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                Continue selling smoothly even when the internet connection is unavailable.
              </p>
            </div>

            <div className="p-4 rounded border border-slate-200 bg-slate-50/50">
              <div className="w-7 h-7 rounded bg-teal-50 border border-teal-200 text-teal-800 flex items-center justify-center font-bold mb-2.5">
                <Lock className="w-3.5 h-3.5" />
              </div>
              <h3 className="text-sm font-bold text-slate-900">Secure Stock &amp; Price Control</h3>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                Only authorized administrators can manually change selling prices and adjust stock counts.
              </p>
            </div>

            <div className="p-4 rounded border border-slate-200 bg-slate-50/50">
              <div className="w-7 h-7 rounded bg-teal-50 border border-teal-200 text-teal-800 flex items-center justify-center font-bold mb-2.5">
                <Boxes className="w-3.5 h-3.5" />
              </div>
              <h3 className="text-sm font-bold text-slate-900">Medicine Batch Tracking</h3>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                Track manufacturer lot numbers, supplier receipts, and enforce FEFO dispensing.
              </p>
            </div>

            <div className="p-4 rounded border border-slate-200 bg-slate-50/50">
              <div className="w-7 h-7 rounded bg-teal-50 border border-teal-200 text-teal-800 flex items-center justify-center font-bold mb-2.5">
                <Clock className="w-3.5 h-3.5" />
              </div>
              <h3 className="text-sm font-bold text-slate-900">Expiry Management</h3>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                Automatic expiry alerts, countdown tracking, and hard system barriers preventing expired sales.
              </p>
            </div>

            <div className="p-4 rounded border border-slate-200 bg-slate-50/50">
              <div className="w-7 h-7 rounded bg-teal-50 border border-teal-200 text-teal-800 flex items-center justify-center font-bold mb-2.5">
                <Zap className="w-3.5 h-3.5" />
              </div>
              <h3 className="text-sm font-bold text-slate-900">Automatic Synchronization</h3>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                Offline transactions safely synchronize in the background when connectivity returns.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 4. OFFLINE SECTION */}
      <section id="offline" className="py-12 md:py-16 bg-slate-50 border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
            <div className="lg:col-span-7 space-y-3">
              <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
                Keep Selling Even When the Internet Goes Down
              </h2>
              <p className="text-xs sm:text-sm text-slate-600 leading-relaxed font-normal">
                GIGA CHEMIST is built as an offline-first Progressive Web App. When internet or power cuts occur, your dispensary counter continues serving patients without interruption.
              </p>

              <div className="space-y-1.5 text-xs text-slate-700 pt-2">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-teal-700" />
                  <span><strong>Medicine search still works:</strong> Local catalog and batches remain searchable.</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-teal-700" />
                  <span><strong>Sales still work:</strong> Add items to cart and complete checkout without delay.</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-teal-700" />
                  <span><strong>Receipts can still be generated:</strong> Thermal receipts print directly to your printer.</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-teal-700" />
                  <span><strong>Transactions are stored locally:</strong> Saved in IndexedDB with unique idempotency keys.</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-teal-700" />
                  <span><strong>Automatic synchronization:</strong> Pushes safely to server when connectivity returns.</span>
                </div>
              </div>
            </div>

            {/* Pipeline Strip */}
            <div className="lg:col-span-5 bg-white p-4 rounded border border-slate-300 shadow-xs">
              <div className="text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-3">
                Offline-to-Online Pipeline
              </div>
              <div className="space-y-2 text-xs font-mono">
                <div className="p-2 rounded bg-slate-100 border border-slate-200 flex justify-between">
                  <span className="font-semibold text-slate-800">1. ONLINE</span>
                  <span className="text-slate-500">Connected</span>
                </div>
                <div className="p-2 rounded bg-amber-50 border border-amber-200 text-amber-900 flex justify-between">
                  <span className="font-semibold">2. OFFLINE</span>
                  <span>Network Drops</span>
                </div>
                <div className="p-2 rounded bg-teal-50 border border-teal-200 text-teal-900 flex justify-between">
                  <span className="font-semibold">3. CONTINUE SELLING</span>
                  <span>IndexedDB</span>
                </div>
                <div className="p-2 rounded bg-slate-100 border border-slate-200 flex justify-between">
                  <span className="font-semibold text-slate-800">4. NETWORK RESTORED</span>
                  <span className="text-slate-500">Auto-Detect</span>
                </div>
                <div className="p-2 rounded bg-emerald-50 border border-emerald-200 text-emerald-900 flex justify-between">
                  <span className="font-semibold">5. AUTO SYNC</span>
                  <span>Queue Reconciled</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 5. HOW IT WORKS */}
      <section id="how-it-works" className="py-12 md:py-16 bg-white border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="mb-8">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
              How It Works
            </h2>
            <p className="text-xs sm:text-sm text-slate-600 mt-1">
              Operational flow designed for rapid onboarding and daily counter reliability.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-4 rounded border border-slate-200 bg-slate-50/50">
              <div className="text-xs font-bold text-teal-700 font-mono mb-1">01</div>
              <h3 className="text-sm font-bold text-slate-900">Set Up Medicines</h3>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                Add pharmacy products, batches, prices and expiry information.
              </p>
            </div>

            <div className="p-4 rounded border border-slate-200 bg-slate-50/50">
              <div className="text-xs font-bold text-teal-700 font-mono mb-1">02</div>
              <h3 className="text-sm font-bold text-slate-900">Sell From the POS</h3>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                Search or scan medicines and complete transactions from the register.
              </p>
            </div>

            <div className="p-4 rounded border border-slate-200 bg-slate-50/50">
              <div className="text-xs font-bold text-teal-700 font-mono mb-1">03</div>
              <h3 className="text-sm font-bold text-slate-900">Work Online or Offline</h3>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                Continue working through internet dropouts without interruption.
              </p>
            </div>

            <div className="p-4 rounded border border-slate-200 bg-slate-50/50">
              <div className="text-xs font-bold text-teal-700 font-mono mb-1">04</div>
              <h3 className="text-sm font-bold text-slate-900">Monitor Stock and Reports</h3>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                Review inventory, daily sales, margins and audit activity from the admin area.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 6. FINAL CALL TO ACTION */}
      <section className="py-12 bg-slate-900 text-white">
        <div className="max-w-3xl mx-auto px-4 text-center space-y-3">
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight">
            Ready to Run Your Pharmacy Smarter?
          </h2>
          <p className="text-xs sm:text-sm text-slate-400 font-normal max-w-md mx-auto">
            Manage sales, inventory, batch tracking and pharmacy operations from one reliable system.
          </p>

          <div className="pt-2">
            <button
              onClick={handleSignIn}
              className="px-6 py-2.5 rounded bg-teal-700 hover:bg-teal-600 text-white text-xs font-semibold shadow-xs transition cursor-pointer inline-flex items-center gap-2"
            >
              <Lock className="w-3.5 h-3.5" />
              <span>{currentUser ? 'Open Dashboard' : 'Sign In'}</span>
            </button>
          </div>
        </div>
      </section>

      {/* 7. MINIMAL FOOTER */}
      <footer className="bg-slate-950 text-slate-400 text-xs py-6 border-t border-slate-900">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-[11px]">
          <div>
            <span className="font-bold text-white">GIGA CHEMIST</span>
            <span className="mx-2 text-slate-600">·</span>
            <span>Smart Pharmacy Management. Online or Offline.</span>
          </div>

          <div className="flex items-center gap-4 text-slate-400">
            <a href="#home" className="hover:text-white transition">Home</a>
            <a href="#features" className="hover:text-white transition">Features</a>
            <a href="#offline" className="hover:text-white transition">Offline</a>
            <a href="#how-it-works" className="hover:text-white transition">How It Works</a>
            <button onClick={handleSignIn} className="hover:text-white transition cursor-pointer">
              Sign In
            </button>
          </div>

          <div className="text-slate-500">
            © {new Date().getFullYear()} GIGA CHEMIST. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};
