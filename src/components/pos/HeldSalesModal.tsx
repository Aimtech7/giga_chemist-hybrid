import React from 'react';
import { Clock, Play, Trash2, X, ShoppingBag } from 'lucide-react';
import type { HeldSale, PharmacySettings } from '../../types';

interface HeldSalesModalProps {
  isOpen: boolean;
  onClose: () => void;
  heldSales: HeldSale[];
  settings: PharmacySettings;
  onResumeSale: (heldSale: HeldSale) => void;
  onDeleteHeldSale: (heldId: string) => void;
}

export const HeldSalesModal: React.FC<HeldSalesModalProps> = ({
  isOpen,
  onClose,
  heldSales,
  settings,
  onResumeSale,
  onDeleteHeldSale,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
      <div className="w-full max-w-lg bg-white rounded border border-slate-300 shadow-lg overflow-hidden text-slate-800">
        <div className="bg-slate-900 px-4 py-3 text-white flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-400" />
            <span className="font-bold text-xs uppercase tracking-wider">
              Held Transactions ({heldSales.length})
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 max-h-[60vh] overflow-y-auto space-y-3">
          {heldSales.length === 0 ? (
            <div className="py-12 text-center text-slate-400">
              <ShoppingBag className="w-8 h-8 mx-auto mb-2 text-slate-300" />
              <p className="text-xs font-semibold text-slate-700">No held transactions currently stored.</p>
              <p className="text-[11px] text-slate-400">Press F8 during a sale to hold it for later resumption.</p>
            </div>
          ) : (
            heldSales.map((h) => {
              const timeStr = new Date(h.held_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              const dateStr = new Date(h.held_at).toLocaleDateString();

              return (
                <div
                  key={h.id}
                  className="p-3 bg-slate-50 border border-slate-200 rounded hover:border-slate-300 transition flex items-center justify-between"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-xs text-slate-900">
                        {h.customer_name || 'Walk-in Customer'}
                      </span>
                      <span className="text-[10px] text-slate-500 font-mono">
                        {dateStr} {timeStr}
                      </span>
                    </div>

                    <div className="text-[11px] text-slate-600">
                      {h.items.length} items: {h.items.map((i: any) => `${i.quantity}x ${i.medicine?.name || 'Item'}`).join(', ')}
                    </div>

                    {h.note && (
                      <div className="text-[10px] italic text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded inline-block">
                        Note: {h.note}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 pl-3 shrink-0">
                    <div className="text-right">
                      <div className="text-xs font-black font-mono text-slate-900">
                        {settings.currency} {h.subtotal.toFixed(2)}
                      </div>
                      <div className="text-[9px] text-slate-400">By {h.cashier_name}</div>
                    </div>

                    <button
                      onClick={() => onResumeSale(h)}
                      className="p-1.5 rounded bg-teal-600 hover:bg-teal-700 text-white font-semibold text-xs flex items-center gap-1 shadow-xs cursor-pointer"
                      title="Resume this sale into register"
                    >
                      <Play className="w-3.5 h-3.5" />
                      <span>Resume</span>
                    </button>

                    <button
                      onClick={() => onDeleteHeldSale(h.id)}
                      className="p-1.5 rounded border border-slate-200 hover:bg-rose-50 text-slate-400 hover:text-rose-600 transition cursor-pointer"
                      title="Discard held sale"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="p-3 bg-slate-50 border-t border-slate-200 text-right">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded border border-slate-300 hover:bg-slate-200 text-xs font-semibold text-slate-700 cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
