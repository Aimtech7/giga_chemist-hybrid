import React, { useState, useEffect } from 'react';
import { Search, Download, Lock } from 'lucide-react';
import { db } from '../../db/dexie';
import { downloadCSV } from '../../services/exportUtils';
import type { AuditLog, User } from '../../types';

interface AuditLogViewerProps {
  currentUser: User | null;
}

export const AuditLogViewer: React.FC<AuditLogViewerProps> = ({ currentUser }) => {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('ALL');

  const isAdmin = currentUser?.role === 'ADMIN';

  const loadLogs = async () => {
    const list = await db.audit_logs.reverse().sortBy('timestamp');
    setLogs(list);
  };

  useEffect(() => {
    loadLogs();
  }, []);

  if (!isAdmin) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-center">
        <div className="max-w-md p-6 bg-white rounded border border-slate-200">
          <Lock className="w-8 h-8 text-rose-600 mx-auto mb-2" />
          <h2 className="text-sm font-bold text-slate-900">Protected Audit Log</h2>
          <p className="text-xs text-slate-600 mt-1">
            Access to security audit logs and compliance trails is restricted to Administrators only.
          </p>
        </div>
      </div>
    );
  }

  const handleExportCSV = () => {
    const headers = [
      'Timestamp',
      'Date',
      'User Name',
      'Role',
      'Action Code',
      'Entity',
      'Entity ID',
      'Previous Value',
      'New Value',
      'Device ID',
    ];

    const rows = logs.map((l) => [
      new Date(l.timestamp).toISOString(),
      l.date,
      l.user_name,
      l.role,
      l.action,
      l.entity,
      l.entity_id,
      l.previous_value || '',
      l.new_value || '',
      l.device_id,
    ]);

    downloadCSV(
      `giga-chemist-audit-log-${new Date().toISOString().split('T')[0]}.csv`,
      headers,
      rows
    );
  };

  const filtered = logs.filter((l) => {
    if (actionFilter !== 'ALL' && !l.action.includes(actionFilter)) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      l.user_name.toLowerCase().includes(q) ||
      l.action.toLowerCase().includes(q) ||
      l.entity.toLowerCase().includes(q) ||
      l.entity_id.toLowerCase().includes(q) ||
      (l.new_value && l.new_value.toLowerCase().includes(q))
    );
  });

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      {/* Page Header */}
      <div className="p-4 bg-white border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0">
        <div>
          <h1 className="text-base font-bold text-slate-900 tracking-tight">
            Audit Logs
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            System audit trail for price changes, inventory adjustments, and sensitive transactions.
          </p>
        </div>

        <button
          onClick={handleExportCSV}
          className="px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold transition cursor-pointer inline-flex items-center gap-1.5 self-start sm:self-auto"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Export CSV</span>
        </button>
      </div>

      {/* Filter and search toolbar */}
      <div className="p-3 bg-white border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
        <div className="relative w-full max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search action, user, entity ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
          />
        </div>

        <div className="flex items-center gap-2">
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="py-1.5 px-2 border border-slate-300 rounded bg-white text-xs text-slate-700"
          >
            <option value="ALL">All Event Types</option>
            <option value="PRICE">Price Modifications</option>
            <option value="STOCK">Stock Adjustments</option>
            <option value="VOID">Transaction Voids</option>
            <option value="LOGIN">Auth &amp; Sessions</option>
            <option value="MEDICINE">Medicine Formulary Changes</option>
          </select>
          <span className="text-slate-500 font-medium">{filtered.length} entries</span>
        </div>
      </div>

      {/* Data Table */}
      <div className="flex-1 overflow-auto p-4">
        <div className="bg-white rounded border border-slate-200 overflow-hidden">
          <table className="w-full text-left text-xs text-slate-700">
            <thead className="bg-slate-100 border-b border-slate-200 text-slate-600">
              <tr>
                <th className="py-2.5 px-3 font-semibold font-mono">Timestamp</th>
                <th className="py-2.5 px-3 font-semibold">Actor</th>
                <th className="py-2.5 px-3 font-semibold">Action</th>
                <th className="py-2.5 px-3 font-semibold">Entity</th>
                <th className="py-2.5 px-3 font-semibold">Previous State</th>
                <th className="py-2.5 px-3 font-semibold">New Value</th>
                <th className="py-2.5 px-3 font-semibold font-mono">Device</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-400">
                    No audit records matching filter criteria.
                  </td>
                </tr>
              ) : (
                filtered.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50">
                    <td className="py-2 px-3 text-slate-600 font-mono">
                      <div>{log.date}</div>
                      <div className="text-[11px] text-slate-400">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </div>
                    </td>

                    <td className="py-2 px-3">
                      <div className="font-semibold text-slate-900">{log.user_name}</div>
                      <div className="text-[11px] text-slate-500">{log.role}</div>
                    </td>

                    <td className="py-2 px-3 font-mono font-medium text-slate-800">
                      {log.action}
                    </td>

                    <td className="py-2 px-3">
                      <div className="text-slate-800 font-medium">{log.entity}</div>
                      <div className="text-[11px] text-slate-400 font-mono truncate max-w-[120px]">
                        {log.entity_id}
                      </div>
                    </td>

                    <td className="py-2 px-3 text-slate-500 truncate max-w-[160px]">
                      {log.previous_value || '—'}
                    </td>

                    <td className="py-2 px-3 text-slate-900 font-semibold truncate max-w-[200px]">
                      {log.new_value || '—'}
                    </td>

                    <td className="py-2 px-3 text-slate-500 font-mono text-[11px]">
                      {log.device_id}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
