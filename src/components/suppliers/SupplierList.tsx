import React, { useState, useEffect } from 'react';
import { Plus, Search, Edit2, FileSpreadsheet, X } from 'lucide-react';
import { db } from '../../db/dexie';
import { downloadCSV } from '../../services/exportUtils';
import type { Supplier, PharmacySettings, User } from '../../types';
import { apiFetch } from '../../services/http';

interface SupplierListProps {
  currentUser: User | null;
  settings: PharmacySettings;
}

export const SupplierList: React.FC<SupplierListProps> = ({ currentUser, settings }) => {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSup, setEditingSup] = useState<Supplier | null>(null);

  const [name, setName] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [taxPin, setTaxPin] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);

  const isAdminOrManager = currentUser?.role === 'ADMIN' || currentUser?.role === 'MANAGER';

  const loadSuppliers = async () => {
    setSuppliers(await db.suppliers.toArray());
  };

  useEffect(() => {
    loadSuppliers();
  }, []);

  const openForm = (sup?: Supplier) => {
    if (sup) {
      setEditingSup(sup);
      setName(sup.name);
      setContactPerson(sup.contact_person);
      setPhone(sup.phone);
      setEmail(sup.email);
      setAddress(sup.address);
      setTaxPin(sup.tax_pin || '');
    } else {
      setEditingSup(null);
      setName('');
      setContactPerson('');
      setPhone('+254 ');
      setEmail('');
      setAddress('');
      setTaxPin('');
    }
    setIsModalOpen(true);
  };

  // PostgreSQL first: new suppliers get a server UUID; edits target the existing UUID.
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveError(null);
    if (!name.trim()) {
      setSaveError('Supplier name is required.');
      return;
    }
    try {
      const { supplier } = await apiFetch<{ supplier: Supplier }>('/api/suppliers', {
        body: {
          id: editingSup?.id,
          name: name.trim(),
          contact_person: contactPerson.trim(),
          phone: phone.trim(),
          email: email.trim(),
          address: address.trim(),
          tax_pin: taxPin.trim() || undefined,
          status: editingSup?.status || 'active',
        },
      });
      await db.suppliers.put(supplier);
      setIsModalOpen(false);
      await loadSuppliers();
    } catch (err: any) {
      setSaveError(err?.message || 'Failed to save supplier.');
    }
  };

  const handleExportCSV = () => {
    const headers = ['Supplier Name', 'Contact Person', 'Phone', 'Email', 'Address', 'Tax/PIN', 'Status'];
    const rows = suppliers.map((s) => [
      s.name,
      s.contact_person,
      s.phone,
      s.email,
      s.address,
      s.tax_pin || '',
      s.status,
    ]);
    downloadCSV(`giga-chemist-suppliers-${new Date().toISOString().split('T')[0]}.csv`, headers, rows);
  };

  const filtered = suppliers.filter((s) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      s.contact_person.toLowerCase().includes(q) ||
      s.phone.includes(q) ||
      s.email.toLowerCase().includes(q) ||
      (s.tax_pin && s.tax_pin.toLowerCase().includes(q))
    );
  });

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      <div className="p-4 bg-white border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 shrink-0">
        <div>
          <h1 className="text-base font-bold text-slate-900 tracking-tight">
            Suppliers
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Authorized pharmaceutical distributors, contact representatives, and procurement records.
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

          {isAdminOrManager && (
            <button
              onClick={() => openForm()}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold transition cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Register Supplier</span>
            </button>
          )}
        </div>
      </div>

      {/* Filter and search bar */}
      <div className="p-3 bg-white border-b border-slate-200 flex items-center justify-between gap-2 text-xs shrink-0">
        <div className="relative w-full max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search supplier, contact person, phone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
          />
        </div>
        <span className="text-slate-500 font-medium">{filtered.length} suppliers</span>
      </div>

      {/* Professional Data Table */}
      <div className="flex-1 overflow-auto p-4">
        <div className="bg-white rounded border border-slate-200 overflow-hidden">
          <table className="w-full text-left text-xs text-slate-700">
            <thead className="bg-slate-50 text-slate-600 uppercase font-semibold text-[10px] tracking-wider border-b border-slate-200">
              <tr>
                <th className="py-2.5 px-3">Company / Supplier</th>
                <th className="py-2.5 px-3">Contact Person</th>
                <th className="py-2.5 px-3 font-mono">Phone Number</th>
                <th className="py-2.5 px-3">Email</th>
                <th className="py-2.5 px-3">Location / Address</th>
                <th className="py-2.5 px-3 font-mono">Tax / PIN</th>
                <th className="py-2.5 px-3 text-center">Status</th>
                {isAdminOrManager && <th className="py-2.5 px-3 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={isAdminOrManager ? 8 : 7} className="py-12 text-center text-slate-400">
                    No suppliers found matching search criteria.
                  </td>
                </tr>
              ) : (
                filtered.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50 transition">
                    <td className="py-2 px-3 font-semibold text-slate-900">
                      {s.name}
                    </td>
                    <td className="py-2 px-3 text-slate-700 font-medium">
                      {s.contact_person || '—'}
                    </td>
                    <td className="py-2 px-3 font-mono text-slate-600">
                      {s.phone}
                    </td>
                    <td className="py-2 px-3 text-slate-600">
                      {s.email || '—'}
                    </td>
                    <td className="py-2 px-3 text-slate-600 max-w-xs truncate">
                      {s.address || '—'}
                    </td>
                    <td className="py-2 px-3 font-mono text-[11px] text-slate-500">
                      {s.tax_pin || '—'}
                    </td>
                    <td className="py-2 px-3 text-center">
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <span className={`w-1.5 h-1.5 rounded-full ${s.status === 'active' ? 'bg-emerald-600' : 'bg-slate-400'}`} />
                        <span className="capitalize text-slate-700">{s.status}</span>
                      </span>
                    </td>
                    {isAdminOrManager && (
                      <td className="py-2 px-3 text-right">
                        <button
                          onClick={() => openForm(s)}
                          className="p-1 rounded border border-slate-200 hover:bg-slate-100 text-slate-700 transition cursor-pointer"
                          title="Edit Supplier Details"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    )}
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
                {editingSup ? 'Edit Supplier' : 'Register New Supplier'}
              </span>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-white p-1 rounded cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-4 space-y-3 text-xs">

              {saveError && (
                <div className="p-2 rounded bg-rose-50 border border-rose-200 text-rose-800 text-[11px]">{saveError}</div>
              )}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Company / Supplier Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Harleys Pharmaceuticals Ltd"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Contact Person Name</label>
                <input
                  type="text"
                  placeholder="e.g. David Kamau"
                  value={contactPerson}
                  onChange={(e) => setContactPerson(e.target.value)}
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
                    placeholder="orders@supplier.co.ke"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Physical Address / City</label>
                <input
                  type="text"
                  placeholder="e.g. Industrial Area, Nairobi"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Tax / KRA PIN</label>
                <input
                  type="text"
                  placeholder="e.g. P051234567A"
                  value={taxPin}
                  onChange={(e) => setTaxPin(e.target.value.toUpperCase())}
                  className="w-full p-2 border border-slate-300 rounded font-mono uppercase focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
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
                  Save Supplier
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

