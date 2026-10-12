import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { apiFetch } from '../../services/http';

/**
 * DATA INTEGRITY DASHBOARD (Administrator, shop computer). READ ONLY: every check is a query; there is
 * no "fix everything". Findings in data imported from the old system are shown apart (INFO); anything
 * produced by the current application is a WARNING / CRITICAL and needs an explicit, audited correction.
 */
const TONE: Record<string, string> = { OK: 'bg-emerald-100 text-emerald-800', INFO: 'bg-sky-100 text-sky-800', WARNING: 'bg-amber-100 text-amber-800', CRITICAL: 'bg-rose-100 text-rose-800', UNKNOWN: 'bg-slate-200 text-slate-700' };

export const IntegrityDashboard: React.FC = () => {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiFetch('/api/integrity'));
    } catch (err: any) {
      setError(err?.message || 'Could not run the checks.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-bold text-slate-900 flex items-center gap-1.5"><ShieldCheck className="w-4 h-4 text-teal-700" /> Data Integrity</h1>
          <p className="text-[11px] text-slate-500">Read-only diagnostics of this shop's database. Nothing is changed here; any correction is a separate, audited action.</p>
        </div>
        <button className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold flex items-center gap-1" onClick={() => void load()}>{loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Run checks</button>
      </div>
      {error && <div className="text-xs rounded p-2 border bg-rose-50 border-rose-200 text-rose-800">{error}</div>}
      {data && <div className="text-xs">Overall: <span className={`px-1.5 py-0.5 rounded font-bold ${TONE[data.overall]}`}>{data.overall}</span> · {new Date(data.checked_at).toLocaleString()} · {data.duration_ms} ms</div>}
      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-600"><tr>{['Check', 'Status', 'Found', 'Old-system data', 'Examples', 'What it means'].map((c) => <th key={c} className="px-2 py-2 text-left font-semibold">{c}</th>)}</tr></thead>
          <tbody>
            {(data?.checks || []).map((c: any) => (
              <tr key={c.key} className="border-t border-slate-100 align-top">
                <td className="px-2 py-1.5 font-semibold text-slate-900">{c.label}</td>
                <td className="px-2 py-1.5"><span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${TONE[c.severity] || ''}`}>{c.severity}</span></td>
                <td className="px-2 py-1.5">{c.count ?? '—'}</td>
                <td className="px-2 py-1.5">{c.legacy_count ? c.legacy_count : '—'}</td>
                <td className="px-2 py-1.5 font-mono text-[10px] break-all">{(c.sample || []).join(', ') || (c.error ? `error: ${c.error}` : '—')}</td>
                <td className="px-2 py-1.5 text-slate-600">{c.explain}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
