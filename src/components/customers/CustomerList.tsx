import React, { useState, useEffect } from 'react';
import { Plus, Search, Edit2, FileSpreadsheet, X } from 'lucide-react';
import { db } from '../../db/dexie';
import { downloadCSV } from '../../services/exportUtils';
import type { Customer, PharmacySettings } from '../../types';

interface CustomerListProps {
  settings: PharmacySettings;
}

export const CustomerList: React.FC<CustomerListProps> = ({ settings }) => {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCust, setEditingCust] = useState<Customer | null>(null);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');

  const loadCustomers = async () => {
    setCustomers(await db.customers.toArray());
  };

  useEffect(() => {
    loadCustomers();
  }, []);

  const openForm = (c?: Customer) => {
    if (c) {
      setEditingCust(c);
      setName(c.name);
      setPhone(c.phone);
      setEmail(c.email || '');
      setAddress(c.address || '');
      setNotes(c.notes || '');
    } else {
      setEditingCust(null);
      setName('');
      setPhone('+254 ');
      setEmail('');
      setAddress('');
      setNotes('');
    }
    setIsModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const todayStr = new Date().toISOString().split('T')[0];
    const customerData: Customer = {
      id: editingCust ? editingCust.id : `cus-${Date.now()}`,
      name: name.trim(),
      phone: phone.trim(),
      email: email.trim() || undefined,
      address: address.trim() || undefined,
      notes: notes.trim() || undefined,
      credit_balance: editingCust ? editingCust.credit_balance : 0,
      total_spent: editingCust ? editingCust.total_spent : 0,
      created_at: editingCust ? editingCust.created_at : todayStr,
    };

    await db.customers.put(customerData);
    setIsModalOpen(false);
    await loadCustomers();
  };

  const handleExportCSV = () => {
    const headers = ['Customer Name', 'Phone', 'Email', 'Address', 'Clinical Notes', 'Total Spent (KES)'];
    const rows = customers.map((c) => [
      c.name,
      c.phone,
      c.email || '',
      c.address || '',
      c.notes || '',
      c.total_spent.toFixed(2),
    ]);
    downloadCSV(`giga-chemist-customers-${new Date().toISOString().split('T')[0]}.csv`, headers, rows);
  };

  const filtered = customers.filter((c) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      c.phone.toLowerCase().includes(q) ||
      (c.notes && c.notes.toLowerCase().includes(q))
    );
  });

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      <div className="p-4 bg-white border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 shrink-0">
        <div>
          <h1 className="text-base font-bold text-slate-900 tracking-tight">
            Customers &amp; Patients
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Registered patients, chronic medication notes, contact details, and dispensing histories.
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
            onClick={() => openForm()}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Register Patient</span>
          </button>
        </div>
      </div>

      {/* Filter and search bar */}
      <div className="p-3 bg-white border-b border-slate-200 flex items-center justify-between gap-2 text-xs shrink-0">
        <div className="relative w-full max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search patient name, phone, notes..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
          />
        </div>
        <span className="text-slate-500 font-medium">{filtered.length} patients</span>
      </div>

      {/* Professional Data Table */}
      <div className="flex-1 overflow-auto p-4">
        <div className="bg-white rounded border border-slate-200 overflow-hidden">
          <table className="w-full text-left text-xs text-slate-700">
            <thead className="bg-slate-50 text-slate-600 uppercase font-semibold text-[10px] tracking-wider border-b border-slate-200">
              <tr>
                <th className="py-2.5 px-3">Patient / Customer Name</th>
                <th className="py-2.5 px-3 font-mono">Phone Number</th>
                <th className="py-2.5 px-3">Email Address</th>
                <th className="py-2.5 px-3">Address / Estate</th>
                <th className="py-2.5 px-3">Rx / Clinical Notes</th>
                <th className="py-2.5 px-3 text-right">Total Spent</th>
                <th className="py-2.5 px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">
                    No patient records found matching search criteria.
                  </td>
                </tr>
              ) : (
                filtered.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50 transition">
                    <td className="py-2 px-3 font-semibold text-slate-900">
                      {c.name}
                    </td>
                    <td className="py-2 px-3 font-mono text-slate-600">
                      {c.phone}
                    </td>
                    <td className="py-2 px-3 text-slate-600">
                      {c.email || '—'}
                    </td>
                    <td className="py-2 px-3 text-slate-600 max-w-xs truncate">
                      {c.address || '—'}
                    </td>
                    <td className="py-2 px-3 text-slate-600 max-w-sm truncate">
                      {c.notes ? (
                        <span className="text-amber-800 font-medium">{c.notes}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-2 px-3 text-right font-mono font-bold text-slate-900">
                      {settings.currency} {c.total_spent.toFixed(2)}
                    </td>
                    <td className="py-2 px-3 text-right">
                      {c.id !== 'cus-001' ? (
                        <button
                          onClick={() => openForm(c)}
                          className="p-1 rounded border border-slate-200 hover:bg-slate-100 text-slate-700 transition cursor-pointer"
                          title="Edit Patient Details"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                      ) : (
                        <span className="text-[10px] text-slate-400 italic">Default</span>
                      )}
                    </td>
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
              <span className="font-bold text-xs">
                {editingCust ? 'Edit Patient' : 'Register New Patient'}
              </span>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-white p-1 rounded cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-4 space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Patient Full Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Grace Wanjiku"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Phone Number *</label>
                  <input
                    type="text"
                    required
                    placeholder="+254 700 000 000"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded font-mono focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Email</label>
                  <input
                    type="email"
                    placeholder="patient@gmail.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Address / Estate</label>
                <input
                  type="text"
                  placeholder="e.g. Milimani Estate, Kitale"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Chronic Medication / Clinical Notes
                </label>
                <textarea
                  rows={2}
                  placeholder="e.g. Diabetic regular patient, uses Metformin monthly. Penicillin allergy."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                />
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
                  className="px-4 py-1.5 rounded bg-teal-700 hover:bg-teal-800 text-white font-semibold transition cursor-pointer"
                >
                  Save Patient Record
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

