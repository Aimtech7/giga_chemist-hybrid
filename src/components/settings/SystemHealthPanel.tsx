import React, { useEffect, useState } from 'react';
import { Activity, RefreshCw, HardDrive, Database } from 'lucide-react';
import { apiFetch } from '../../services/http';

/** Admin-only system health. No secrets are returned by /api/admin/health. */
interface Health {
  generated_at: string;
  app_version: string;
  node_version: string;
  uptime_seconds: number;
  local_api: string;
  local_database: string;
  local_database_error: string | null;
  internet: string;
  internet_detail: string;
  cloud: string;
  sync: { state: string; mode: string; enabled: boolean; pending: number; retrying: number; failed: number; last_sync: string | null; last_error: string | null };
  email: { state: string; pending: number; retrying: number; failed: number; last_sent_at: string | null; last_error: string | null };
  backup: { enabled: boolean; schedule_time: string; keep: number; location: string; last_success_at: string | null; last_success_file: string | null; last_success_size_bytes: number | null; age_hours: number | null; last_error: string | null; last_error_at: string | null };
  disk: { path: string; total_bytes?: number; free_bytes?: number; free_percent?: number | null; error?: string };
  shop_id: string | null;
  shop_code: string | null;
  device_id: string | null;
}

const fmt = (t?: string | null) => (t ? new Date(t).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const gb = (b?: number) => (b === undefined ? '—' : `${(b / 1024 ** 3).toFixed(1)} GB`);
const GOOD = ['ONLINE', 'CONNECTED', 'SYNCED', 'READY', 'LOCAL'];
const BAD = ['OFFLINE', 'ERROR', 'FAILED'];
const Badge = ({ v }: { v: string }) => (
  <span className={`px-1.5 py-0.5 rounded font-bold text-[10px] border ${GOOD.includes(v) ? 'bg-emerald-50 text-emerald-800 border-emerald-300' : BAD.includes(v) ? 'bg-rose-50 text-rose-800 border-rose-300' : 'bg-amber-50 text-amber-800 border-amber-300'}`}>{v}</span>
);

export const SystemHealthPanel: React.FC = () => {
  const [h, setH] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setH(await apiFetch<Health>('/api/admin/health'));
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Health check failed: the POS server or database may be down.');
    }
  };
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, []);

  const backupNow = async () => {
    setBusy(true);
    setBackupMsg('Backing up… this can take a minute.');
    try {
      const r = await apiFetch<{ file: string; size_bytes: number }>('/api/backups/run', { method: 'POST', body: {} });
      setBackupMsg(`Backup created: ${r.file} (${(r.size_bytes / 1048576).toFixed(1)} MB).`);
      await load();
    } catch (err: any) {
      setBackupMsg(`Backup failed: ${err?.message || 'error'}`);
    } finally {
      setBusy(false);
    }
  };

  if (!h) return <div className="p-6 text-xs text-slate-500">{error || 'Checking system health…'}</div>;
  const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
    <div className="flex justify-between gap-3 py-1 border-b border-slate-50"><span className="text-slate-500">{k}</span><span className="text-right break-all">{children}</span></div>
  );

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6 space-y-4 text-xs max-w-4xl">
      {error && <div className="p-3 rounded border bg-rose-50 border-rose-300 text-rose-800">{error}</div>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white p-4 rounded border border-slate-200">
          <div className="font-semibold text-slate-900 border-b border-slate-100 pb-2 mb-1 flex items-center gap-2"><Activity className="w-4 h-4 text-teal-700" /> Services</div>
          <Row k="Local API"><Badge v={h.local_api} /></Row>
          <Row k="Local PostgreSQL"><Badge v={h.local_database} />{h.local_database_error ? ` ${h.local_database_error}` : ''}</Row>
          <Row k="Internet (checked by the server)"><Badge v={h.internet} /> <span className="text-slate-400">{h.internet_detail}</span></Row>
          <Row k="Cloud / Supabase"><Badge v={h.cloud} /></Row>
          <Row k="Sync"><Badge v={h.sync.state} /></Row>
          <Row k="Pending sync events">{h.sync.pending} (retrying {h.sync.retrying}, failed {h.sync.failed})</Row>
          <Row k="Last successful sync">{fmt(h.sync.last_sync)}</Row>
          <Row k="Email"><Badge v={h.email.state} /></Row>
          <Row k="Pending email jobs">{h.email.pending} (retrying {h.email.retrying}, failed {h.email.failed})</Row>
          <Row k="Last successful email">{fmt(h.email.last_sent_at)}</Row>
        </div>
        <div className="bg-white p-4 rounded border border-slate-200">
          <div className="font-semibold text-slate-900 border-b border-slate-100 pb-2 mb-1 flex items-center gap-2"><Database className="w-4 h-4 text-teal-700" /> Backup</div>
          <Row k="Automatic daily backup">{h.backup.enabled ? `on, ${h.backup.schedule_time} (keep ${h.backup.keep})` : 'off (BACKUP_ENABLED)'}</Row>
          <Row k="Last successful backup">{fmt(h.backup.last_success_at)}</Row>
          <Row k="Backup age">{h.backup.age_hours === null ? '—' : `${h.backup.age_hours} h`}{h.backup.age_hours !== null && h.backup.age_hours > 36 ? ' ⚠ older than 36 h' : ''}</Row>
          <Row k="Last file">{h.backup.last_success_file || '—'}</Row>
          <Row k="Location">{h.backup.location}</Row>
          <Row k="Last backup error">{h.backup.last_error ? `${h.backup.last_error} (${fmt(h.backup.last_error_at)})` : '—'}</Row>
          <div className="pt-2 flex items-center gap-2">
            <button disabled={busy} onClick={backupNow} className="px-3 py-1.5 rounded bg-teal-700 text-white font-semibold disabled:opacity-50 cursor-pointer">Back up now</button>
            <span className="text-slate-500">Restores are never done from this screen.</span>
          </div>
          {backupMsg && <p className="mt-2 text-slate-700">{backupMsg}</p>}
          <div className="font-semibold text-slate-900 border-b border-slate-100 pb-2 mt-4 mb-1 flex items-center gap-2"><HardDrive className="w-4 h-4 text-teal-700" /> System</div>
          <Row k={`Disk free (${h.disk.path})`}>{h.disk.error ? h.disk.error : `${gb(h.disk.free_bytes)} of ${gb(h.disk.total_bytes)} (${h.disk.free_percent}%)`}</Row>
          <Row k="Application version">{h.app_version} (Node {h.node_version})</Row>
          <Row k="Uptime">{Math.floor(h.uptime_seconds / 3600)} h {Math.floor((h.uptime_seconds % 3600) / 60)} min</Row>
          <Row k="Shop ID">{h.shop_code ? `${h.shop_code} · ${h.shop_id}` : '—'}</Row>
          <Row k="Device ID">{h.device_id || '—'}</Row>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => void load()} className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 font-semibold cursor-pointer"><RefreshCw className="w-3.5 h-3.5" /> Refresh</button>
        <span className="text-slate-400">Checked {fmt(h.generated_at)}</span>
      </div>
    </div>
  );
};
