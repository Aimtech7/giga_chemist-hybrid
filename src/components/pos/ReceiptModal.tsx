import React, { useState } from 'react';
import { Printer, Check, X, Copy, CheckCheck } from 'lucide-react';
import type { Sale, PharmacySettings } from '../../types';
import { printThermalReceipt } from '../../services/receiptPrinter';

interface ReceiptModalProps {
  isOpen: boolean;
  onClose: () => void;
  sale: Sale | null;
  settings: PharmacySettings;
}

export const ReceiptModal: React.FC<ReceiptModalProps> = ({ isOpen, onClose, sale, settings }) => {
  const [copied, setCopied] = useState(false);

  if (!isOpen || !sale) return null;

  const handlePrint = () => {
    printThermalReceipt(sale, settings);
  };

  const handleCopyText = () => {
    const text = `GIGA CHEMIST
Receipt #: ${sale.receipt_number}
Date: ${sale.date} ${sale.time}
Cashier: ${sale.cashier_name}${sale.price_mode === 'WHOLESALE' ? '\n*** WHOLESALE SALE ***' : ''}
Total: ${settings.currency} ${sale.total.toFixed(2)}
Payment: ${sale.payment_method} ${sale.payment_reference ? `(${sale.payment_reference})` : ''}
Thank you. Get well soon!`;

    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
      <div className="w-full max-w-md bg-white rounded border border-slate-300 shadow-lg overflow-hidden text-slate-800">
        {/* Header */}
        <div className="bg-slate-900 px-4 py-3 text-white flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Printer className="w-4 h-4 text-teal-400" />
            <span className="font-bold text-xs uppercase tracking-wider">
              Thermal Receipt [{settings.printer_type}]
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Paper receipt simulation */}
        <div className="p-6 bg-slate-100 max-h-[70vh] overflow-y-auto">
          <div className="mx-auto bg-white p-6 shadow-sm border border-slate-300 font-mono text-xs leading-relaxed max-w-[340px] text-slate-900">
            {/* Pharmacy Branding */}
            <div className="text-center pb-3 border-b border-dashed border-slate-400">
              <h2 className="text-base font-black tracking-widest uppercase">
                {settings.pharmacy_name}
              </h2>
              <div className="text-[10px] text-slate-600">{settings.tagline}</div>
              <div className="text-[10px] text-slate-600">{settings.address}</div>
              <div className="text-[10px] text-slate-600">Tel: {settings.phone}</div>
            </div>

            {/* Receipt Meta */}
            <div className="py-2 border-b border-dashed border-slate-400 text-[11px] space-y-0.5">
              <div className="flex justify-between">
                <span>Receipt #:</span>
                <span className="font-bold">{sale.receipt_number}</span>
              </div>
              <div className="flex justify-between">
                <span>Date:</span>
                <span>{sale.date} {sale.time}</span>
              </div>
              <div className="flex justify-between">
                <span>Cashier:</span>
                <span>{sale.cashier_name}</span>
              </div>
              {sale.price_mode === 'WHOLESALE' && (
                <div className="mt-1 py-0.5 text-center font-black tracking-widest border border-slate-900">
                  *** WHOLESALE SALE ***
                </div>
              )}
              {sale.customer_name && sale.customer_name !== 'Walk-in Customer' && (
                <div className="flex justify-between">
                  <span>Customer:</span>
                  <span>{sale.customer_name}</span>
                </div>
              )}
            </div>

            {/* Itemized list */}
            <div className="py-2 border-b border-dashed border-slate-400 space-y-2">
              {sale.items.map((item, idx) => (
                <div key={idx} className="text-[11px]">
                  <div className="font-bold">
                    {item.medicine_name}
                    {item.price_mode === 'WHOLESALE' && <span className="font-normal"> [WS]</span>}
                  </div>
                  <div className="text-[10px] text-slate-600 flex justify-between">
                    <span>Batch: {item.batch_number}</span>
                    <span>Exp: {item.expiry_date}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{item.quantity} × {settings.currency} {item.unit_price.toFixed(2)}</span>
                    {/* Line amount at the price charged; the sale discount is shown once below. */}
                    <span className="font-bold">{settings.currency} {(item.quantity * item.unit_price).toFixed(2)}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Totals */}
            <div className="py-2 border-b border-double border-slate-400 text-[11px] space-y-0.5">
              <div className="flex justify-between">
                <span>Subtotal:</span>
                <span>{settings.currency} {sale.subtotal.toFixed(2)}</span>
              </div>
              {sale.discount_total > 0 && (
                <div className="flex justify-between text-emerald-700">
                  <span>Discount {sale.discount_percent ? `${sale.discount_percent}%` : ''}:</span>
                  <span>-{settings.currency} {sale.discount_total.toFixed(2)}</span>
                </div>
              )}
              {settings.tax_enabled && (
                <div className="flex justify-between">
                  <span>Tax ({settings.tax_rate}%):</span>
                  <span>{settings.currency} {sale.tax_total.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between font-black text-sm pt-1 border-t border-slate-400">
                <span>TOTAL:</span>
                <span>{settings.currency} {sale.total.toFixed(2)}</span>
              </div>
            </div>

            {/* Payment Details */}
            <div className="py-2 border-b border-dashed border-slate-400 text-[11px] space-y-0.5">
              <div className="flex justify-between">
                <span>Tender:</span>
                <span className="font-bold uppercase">{sale.payment_method}</span>
              </div>
              {sale.payment_reference && (
                <div className="flex justify-between">
                  <span>Ref:</span>
                  <span className="font-bold">{sale.payment_reference}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span>Paid:</span>
                <span>{settings.currency} {sale.amount_received.toFixed(2)}</span>
              </div>
              <div className="flex justify-between font-bold">
                <span>Change:</span>
                <span>{settings.currency} {sale.change_given.toFixed(2)}</span>
              </div>

              {sale.split_payments && sale.split_payments.length > 0 && (
                <div className="pt-1 mt-1 border-t border-dotted border-slate-300 text-[10px]">
                  {sale.split_payments.map((sp, i) => (
                    <div key={i} className="flex justify-between">
                      <span>• {sp.method}:</span>
                      <span>{settings.currency} {sp.amount.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="pt-3 text-center text-[10px] text-slate-600 whitespace-pre-line">
              {settings.receipt_footer}
            </div>

            <div className="pt-2 text-center text-[8px] text-slate-400">
              Dev: {sale.device_id} | Status: {sale.sync_status.toUpperCase()}
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-3 bg-white border-t border-slate-200 flex items-center justify-between">
          <button
            onClick={handleCopyText}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-semibold transition cursor-pointer"
          >
            {copied ? <CheckCheck className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? 'Copied!' : 'Copy Summary'}</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-semibold transition cursor-pointer"
            >
              Done
            </button>
            <button
              onClick={handlePrint}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold shadow-sm transition cursor-pointer"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>Print Thermal Receipt</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
