import React, { useState, useEffect } from 'react';
import { Plus, FileSpreadsheet, X } from 'lucide-react';
import { db } from '../../db/dexie';
import { downloadCSV } from '../../services/exportUtils';
import { apiFetch } from '../../services/http';
import type { Expense, PharmacySettings, User } from '../../types';

interface ExpenseListProps {
  currentUser: User | null;
  settings: PharmacySettings;
}

export const ExpenseList: React.FC<ExpenseListProps> = ({ currentUser, settings }) => {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const [category, setCategory] = useState<Expense['category']>('Miscellaneous');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState<number>(0);
  const [paymentMethod, setPaymentMethod] = useState('M-Pesa');
  const [reference, setReference] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const loadExpenses = async () => {
    setExpenses(await db.expenses.toArray());
  };

  useEffect(() => {
    loadExpenses();
  }, []);

  // PostgreSQL first: the expense exists only once the server has committed it.
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveError(null);
    if (!(amount > 0)) {
      setSaveError('Amount must be greater than zero.');
      return;
    }
    if (!description.trim()) {
      setSaveError('Description is required.');
      return;
    }

    setIsSaving(true);
    try {
      const { expense } = await apiFetch<{ expense: Expense }>('/api/expenses', {
        body: {
          category,
          description: description.trim(),
          amount,
          payment_method: paymentMethod,
          reference: reference.trim() || undefined,
        },
      });
      await db.expenses.put(expense);
      setIsModalOpen(false);
      setDescription('');
      setAmount(0);
      setReference('');
      await loadExpenses();
    } catch (err: any) {
      setSaveError(err?.message || 'Failed to record expense.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleExportCSV = () => {
    const headers = ['Category', 'Description', 'Amount (KES)', 'Payment Method', 'Reference', 'Date', 'Recorded By'];
    const rows = expenses.map((e) => [
      e.category,
      e.description,
      e.amount.toFixed(2),
      e.payment_method,
      e.reference || '',
      e.date,
      e.user_name,
    ]);
    downloadCSV(`giga-chemist-expenses-${new Date().toISOString().split('T')[0]}.csv`, headers, rows);
  };

  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      <div className="p-4 bg-white border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 shrink-0">
        <div>
          <h1 className="text-base font-bold text-slate-900 tracking-tight">
            Expenses
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Operational overhead, utilities, cold-chain refrigeration electricity, rent, and supplies.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleExportCSV}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-medium transition cursor-pointer"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-slate-600" />
            <span>Export CSV</span>
          </button>

          <button
            onClick={() => setIsModalOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Record Expense</span>
          </button>
        </div>
      </div>

      {/* Summary strip */}
      <div className="px-4 py-3 bg-white border-b border-slate-200 flex items-center justify-between text-xs shrink-0">
        <div className="flex items-center gap-4">
          <div>
            <span className="text-[10px] uppercase font-semibold text-slate-500 block">Total Outflow</span>
            <span className="text-base font-bold font-mono text-slate-900">
              {settings.currency} {totalExpenses.toFixed(2)}
            </span>
          </div>
        </div>
        <div className="text-slate-500 font-medium">
          {expenses.length} expense entries
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        <div className="bg-white rounded border border-slate-200 overflow-hidden">
          <table className="w-full text-left text-xs text-slate-700">
            <thead className="bg-slate-50 text-slate-600 uppercase font-semibold text-[10px] tracking-wider border-b border-slate-200">
              <tr>
                <th className="py-2.5 px-3">Date</th>
                <th className="py-2.5 px-3">Category</th>
                <th className="py-2.5 px-3">Description</th>
                <th className="py-2.5 px-3 text-right">Amount</th>
                <th className="py-2.5 px-3">Tender</th>
                <th className="py-2.5 px-3 font-mono">Reference</th>
                <th className="py-2.5 px-3">Recorded By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {expenses.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">
                    No operating expenses recorded yet.
                  </td>
                </tr>
              ) : (
                expenses.map((exp) => (
                  <tr key={exp.id} className="hover:bg-slate-50 transition">
                    <td className="py-2 px-3 font-mono text-slate-600">{exp.date}</td>
                    <td className="py-2 px-3 text-slate-800 font-medium">
                      {exp.category}
                    </td>
                    <td className="py-2 px-3 text-slate-700">{exp.description}</td>
                    <td className="py-2 px-3 text-right font-mono font-bold text-slate-900">
                      {settings.currency} {exp.amount.toFixed(2)}
                    </td>
                    <td className="py-2 px-3 text-slate-700">{exp.payment_method}</td>
                    <td className="py-2 px-3 font-mono text-slate-500">{exp.reference || '—'}</td>
                    <td className="py-2 px-3 text-slate-500">{exp.user_name}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="w-full max-w-md bg-white rounded border border-slate-300 shadow-lg overflow-hidden text-slate-800">
            <div className="bg-slate-900 px-4 py-3 text-white flex justify-between items-center">
              <span className="font-bold text-xs">Record Expense</span>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-white p-1 rounded cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-4 space-y-3 text-xs">

              {saveError && (
                <div className="p-2 rounded bg-rose-50 border border-rose-200 text-rose-800 text-[11px]">{saveError}</div>
              )}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Expense Category *</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as any)}
                  className="w-full p-2 border border-slate-300 rounded bg-white focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                >
                  <option value="Electricity">Electricity / Power (KPLC)</option>
                  <option value="Rent">Store Rent</option>
                  <option value="Internet">Internet / Wi-Fi</option>
                  <option value="Salaries">Staff Salaries</option>
                  <option value="Transport">Transport / Delivery</option>
                  <option value="Maintenance">Maintenance &amp; Repairs</option>
                  <option value="Supplies">Pharmacy Supplies (Bags, Labels)</option>
                  <option value="Miscellaneous">Miscellaneous</option>
                </select>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Description / Narration *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Monthly electricity token bill"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Amount ({settings.currency}) *</label>
                <input
                  type="number"
                  step="0.01"
                  min="1"
                  required
                  value={amount || ''}
                  onChange={(e) => setAmount(parseFloat(e.target.value) || 0)}
                  className="w-full p-2 border border-slate-300 rounded font-mono font-bold focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Payment Method</label>
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded bg-white focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                  >
                    <option value="M-Pesa">M-Pesa</option>
                    <option value="Cash">Petty Cash</option>
                    <option value="Bank">Bank Transfer</option>
                    <option value="Card">Card</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Reference / Voucher</label>
                  <input
                    type="text"
                    placeholder="e.g. QWE123RTY"
                    value={reference}
                    onChange={(e) => setReference(e.target.value.toUpperCase())}
                    className="w-full p-2 border border-slate-300 rounded font-mono uppercase focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="px-4 py-1.5 rounded bg-teal-700 hover:bg-teal-800 text-white font-semibold transition cursor-pointer disabled:opacity-50"
                >
                  {isSaving ? 'Saving...' : 'Save Expense'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

