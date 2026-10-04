import React, { useState, useEffect } from 'react';
import {
  CreditCard,
  Banknote,
  Smartphone,
  Building,
  Split,
  CheckCircle,
  AlertTriangle,
  X,
  Printer,
} from 'lucide-react';
import type { CartItem, Customer, PaymentMethod, PharmacySettings, SplitPayment } from '../../types';

interface PaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  cart: CartItem[];
  subtotal: number;
  discountPercent?: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  selectedCustomer: Customer | null;
  settings: PharmacySettings;
  onCompleteSale: (paymentData: {
    payment_method: PaymentMethod;
    payment_reference?: string;
    amount_received: number;
    change_given: number;
    split_payments?: SplitPayment[];
  }) => Promise<void>;
}

export const PaymentModal: React.FC<PaymentModalProps> = ({
  isOpen,
  onClose,
  cart,
  subtotal,
  discountPercent = 0,
  discountTotal,
  taxTotal,
  total,
  selectedCustomer,
  settings,
  onCompleteSale,
}) => {
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('Cash');
  const [amountReceived, setAmountReceived] = useState<number>(total);
  const [mpesaRef, setMpesaRef] = useState<string>('');
  const [cardRef, setCardRef] = useState<string>('');
  const [bankRef, setBankRef] = useState<string>('');
  
  // Mixed Payment state
  const [splitCash, setSplitCash] = useState<number>(0);
  const [splitMpesa, setSplitMpesa] = useState<number>(0);
  const [splitMpesaRef, setSplitMpesaRef] = useState<string>('');
  const [splitCard, setSplitCard] = useState<number>(0);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setAmountReceived(total);
      setSplitCash(total);
      setSplitMpesa(0);
      setSplitCard(0);
      setMpesaRef('');
      setCardRef('');
      setError(null);
    }
  }, [isOpen, total]);

  if (!isOpen) return null;

  const quickCashOptions = [50, 100, 200, 500, 1000, 2000, 5000].filter((val) => val >= total);

  const changeGiven = paymentMethod === 'Cash' ? Math.max(0, amountReceived - total) : 0;
  const splitTotal = splitCash + splitMpesa + splitCard;
  const splitDifference = total - splitTotal;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (paymentMethod === 'Cash' && amountReceived < total) {
      setError(`Amount received is less than total ${settings.currency} ${total.toFixed(2)}.`);
      return;
    }

    if (paymentMethod === 'M-Pesa' && !mpesaRef.trim()) {
      setError('Please record the M-Pesa transaction reference code (e.g. QWE123RTY).');
      return;
    }

    if (paymentMethod === 'Mixed') {
      if (Math.abs(splitDifference) > 0.01) {
        setError(`Split payments total must equal the sale total ${settings.currency} ${total.toFixed(2)}.`);
        return;
      }
      if (splitMpesa > 0 && !splitMpesaRef.trim()) {
        setError('Please record the M-Pesa transaction reference for the split portion.');
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const splitPayments: SplitPayment[] = [];
      if (paymentMethod === 'Mixed') {
        if (splitCash > 0) splitPayments.push({ method: 'Cash', amount: splitCash });
        if (splitMpesa > 0) splitPayments.push({ method: 'M-Pesa', amount: splitMpesa, reference: splitMpesaRef });
        if (splitCard > 0) splitPayments.push({ method: 'Card', amount: splitCard });
      }

      let reference: string | undefined = undefined;
      if (paymentMethod === 'M-Pesa') reference = mpesaRef.trim().toUpperCase();
      if (paymentMethod === 'Card') reference = cardRef.trim().toUpperCase();
      if (paymentMethod === 'Bank') reference = bankRef.trim().toUpperCase();

      await onCompleteSale({
        payment_method: paymentMethod,
        payment_reference: reference,
        amount_received: paymentMethod === 'Cash' ? amountReceived : total,
        change_given: changeGiven,
        split_payments: splitPayments.length > 0 ? splitPayments : undefined,
      });

      onClose();
    } catch (err: any) {
      setError(err?.message || 'Transaction could not be completed.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
      <div className="w-full max-w-xl bg-white rounded border border-slate-300 shadow-lg overflow-hidden text-slate-800">
        {/* Header */}
        <div className="bg-slate-900 px-5 py-3 text-white flex justify-between items-center">
          <div className="flex items-center gap-2">
            <span className="font-bold text-sm tracking-tight">Tender Payment</span>
            <span className="text-xs text-slate-400 font-mono">
              ({cart.length} line items)
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Total banner */}
          <div className="bg-slate-50 border border-slate-200 rounded p-3.5 flex items-center justify-between">
            <div>
              <div className="text-[11px] text-slate-500 font-semibold uppercase tracking-wider">
                Total Payable Amount
              </div>
              <div className="text-2xl font-bold text-slate-900 font-mono mt-0.5">
                {settings.currency} {total.toFixed(2)}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                Customer: <strong className="text-slate-700">{selectedCustomer?.name || 'Walk-in Customer'}</strong>
              </div>
            </div>

            <div className="text-right text-xs text-slate-600 space-y-0.5">
              <div>Subtotal: <span className="font-mono">{settings.currency} {subtotal.toFixed(2)}</span></div>
              {discountTotal > 0 && (
                <div className="text-emerald-700 font-semibold">
                  Discount {discountPercent > 0 ? `(${discountPercent}%)` : ''}: <span className="font-mono">-{settings.currency} {discountTotal.toFixed(2)}</span>
                </div>
              )}
              {settings.tax_enabled && <div>Tax ({settings.tax_rate}%): <span className="font-mono">{settings.currency} {taxTotal.toFixed(2)}</span></div>}
            </div>
          </div>

          {error && (
            <div className="p-2.5 rounded bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600" />
              <span>{error}</span>
            </div>
          )}

          {/* Payment Method Selector */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Select Payment Method
            </label>
            <div className="grid grid-cols-5 gap-2">
              {[
                { id: 'Cash', label: 'Cash', icon: Banknote },
                { id: 'M-Pesa', label: 'M-Pesa', icon: Smartphone },
                { id: 'Card', label: 'Card', icon: CreditCard },
                { id: 'Bank', label: 'Bank', icon: Building },
                { id: 'Mixed', label: 'Split/Mixed', icon: Split },
              ].map((m) => {
                const Icon = m.icon;
                const active = paymentMethod === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      setPaymentMethod(m.id as PaymentMethod);
                      setError(null);
                    }}
                    className={`p-2 rounded border text-center transition flex flex-col items-center justify-center gap-1 cursor-pointer ${
                      active
                        ? 'border-teal-700 bg-teal-700 text-white font-semibold'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span className="text-[11px] font-medium">{m.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* CASH PAYMENT SECTION */}
          {paymentMethod === 'Cash' && (
            <div className="space-y-3 p-3.5 bg-slate-50 rounded border border-slate-200">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-slate-700">Cash Received ({settings.currency})</label>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setAmountReceived(total)}
                    className="text-[10px] font-semibold px-2 py-0.5 rounded bg-slate-200 hover:bg-slate-300 text-slate-800 cursor-pointer"
                  >
                    Exact ({total})
                  </button>
                  {quickCashOptions.slice(0, 3).map((val) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setAmountReceived(val)}
                      className="text-[10px] font-semibold px-2 py-0.5 rounded bg-slate-200 hover:bg-slate-300 text-slate-800 font-mono cursor-pointer"
                    >
                      {val}
                    </button>
                  ))}
                </div>
              </div>

              <input
                type="number"
                step="1"
                min="0"
                value={amountReceived || ''}
                onChange={(e) => setAmountReceived(parseFloat(e.target.value) || 0)}
                className="w-full text-lg font-bold font-mono py-1.5 px-3 border border-slate-300 rounded bg-white focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                autoFocus
              />

              <div className="flex items-center justify-between pt-2 border-t border-slate-200 text-xs">
                <span className="font-semibold text-slate-600">Change Due:</span>
                <span className={`text-base font-bold font-mono ${changeGiven >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                  {settings.currency} {changeGiven.toFixed(2)}
                </span>
              </div>
            </div>
          )}

          {/* M-PESA PAYMENT SECTION */}
          {paymentMethod === 'M-Pesa' && (
            <div className="space-y-3 p-3.5 bg-slate-50 rounded border border-slate-200">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-800">M-Pesa Transaction Verification</span>
                <span className="text-[11px] font-mono text-slate-600 font-semibold">
                  Amount: {settings.currency} {total.toFixed(2)}
                </span>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  M-Pesa Reference / Confirmation Code *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. QWE456RTY8"
                  value={mpesaRef}
                  onChange={(e) => setMpesaRef(e.target.value.toUpperCase())}
                  className="w-full text-sm font-mono font-bold tracking-wider py-1.5 px-3 border border-slate-300 rounded bg-white uppercase focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                  autoFocus
                />
                <span className="text-[10px] text-slate-500 mt-1 block">
                  Verify customer's Safaricom M-Pesa SMS confirmation code.
                </span>
              </div>
            </div>
          )}

          {/* CARD PAYMENT SECTION */}
          {paymentMethod === 'Card' && (
            <div className="space-y-3 p-3.5 bg-slate-50 rounded border border-slate-200">
              <div className="text-xs font-semibold text-slate-800">Card Terminal Authorization</div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  POS Terminal Auth / Approval Code (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. AUTH-789012"
                  value={cardRef}
                  onChange={(e) => setCardRef(e.target.value)}
                  className="w-full py-1.5 px-3 border border-slate-300 rounded bg-white text-xs font-mono focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                />
              </div>
            </div>
          )}

          {/* BANK TRANSFER SECTION */}
          {paymentMethod === 'Bank' && (
            <div className="space-y-3 p-3.5 bg-slate-50 rounded border border-slate-200">
              <div className="text-xs font-semibold text-slate-800">Bank Transfer / Cheque</div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Bank Reference / Cheque Number
                </label>
                <input
                  type="text"
                  placeholder="e.g. EFT-987654"
                  value={bankRef}
                  onChange={(e) => setBankRef(e.target.value)}
                  className="w-full py-1.5 px-3 border border-slate-300 rounded bg-white text-xs font-mono focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                />
              </div>
            </div>
          )}

          {/* MIXED PAYMENT SECTION */}
          {paymentMethod === 'Mixed' && (
            <div className="space-y-3 p-3.5 bg-slate-50 rounded border border-slate-200">
              <div className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                Split Tenders ({settings.currency})
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-[11px] font-semibold text-slate-600 block">Cash Portion</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={splitCash || ''}
                    onChange={(e) => setSplitCash(parseFloat(e.target.value) || 0)}
                    className="w-full p-1.5 border border-slate-300 rounded text-xs font-mono font-semibold"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-slate-600 block">M-Pesa Portion</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={splitMpesa || ''}
                    onChange={(e) => setSplitMpesa(parseFloat(e.target.value) || 0)}
                    className="w-full p-1.5 border border-slate-300 rounded text-xs font-mono font-semibold"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-slate-600 block">Card Portion</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={splitCard || ''}
                    onChange={(e) => setSplitCard(parseFloat(e.target.value) || 0)}
                    className="w-full p-1.5 border border-slate-300 rounded text-xs font-mono font-semibold"
                  />
                </div>
              </div>

              {splitMpesa > 0 && (
                <div>
                  <label className="text-[11px] font-semibold text-slate-600 block mb-1">
                    M-Pesa Reference for {settings.currency} {splitMpesa} *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="M-Pesa Reference Code"
                    value={splitMpesaRef}
                    onChange={(e) => setSplitMpesaRef(e.target.value.toUpperCase())}
                    className="w-full p-1.5 border border-slate-300 rounded text-xs font-mono font-bold uppercase"
                  />
                </div>
              )}

              <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-200">
                <span>Split Sum: {settings.currency} {splitTotal.toFixed(2)}</span>
                <span className={`font-semibold ${Math.abs(splitDifference) < 0.01 ? 'text-emerald-700' : 'text-rose-600'}`}>
                  {Math.abs(splitDifference) < 0.01 ? 'BALANCED' : `DIFFERENCE: ${settings.currency} ${splitDifference.toFixed(2)}`}
                </span>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 rounded border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-medium transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex items-center gap-1.5 px-5 py-2 rounded bg-teal-700 hover:bg-teal-800 text-white font-semibold text-xs transition disabled:opacity-50 cursor-pointer"
            >
              <CheckCircle className="w-4 h-4" />
              <span>{isSubmitting ? 'Finalizing Sale...' : 'Complete Sale & Print Receipt'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
