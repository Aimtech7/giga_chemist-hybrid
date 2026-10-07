import React, { useEffect, useState } from 'react';
import { Mail, Send, RefreshCw, Save, AlertTriangle } from 'lucide-react';
import { apiFetch } from '../../services/http';

/** Admin-only e-mail report settings. SMTP credentials live only in the server .env and are never shown. */
interface EmailSettings {
  daily_stock_enabled: boolean;
  business_summary_enabled: boolean;
  expiry_report_enabled: boolean;
  low_stock_digest_enabled: boolean;
  stock_report_time: string;
  business_report_time: string;
  expiry_report_time: string;
  expiry_report_weekday: number;
  low_stock_digest_time: string;
  recipients: string | null;
  include_low_stock: boolean;
  include_expiry: boolean;
  effective_recipients: string[];
}
interface EmailStatus {
  state: string;
  config: { enabled: boolean; configured: boolean; config_error: string | null; smtp_host: string | null; smtp_port: number; from: string | null; default_recipients: string[]; timezone: string };
  counts: { pending: number; retrying: number; failed: number; sent: number };
  last_sent_at: string | null;
  last_error: { job_type: string; error: string; at: string } | null;
}
interface EmailJob {
  id: string;
  job_type: string;
  report_date: string | null;
  subject: string;
  status: string;
  attempt_count: number;
  sent_at: string | null;
  last_error: string | null;
  created_at: string;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const fmt = (t?: string | null) => (t ? new Date(t).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export const EmailReportsPanel: React.FC = () => {
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [jobs, setJobs] = useState<EmailJob[]>([]);
  const [recipients, setRecipients] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await apiFetch<{ settings: EmailSettings; status: EmailStatus }>('/api/email/settings');
      setSettings(r.settings);
      setStatus(r.status);
      setRecipients(r.settings.recipients || '');
      setJobs(await apiFetch<EmailJob[]>('/api/email/jobs?limit=15'));
    } catch (err: any) {
      setMessage({ ok: false, text: err?.message || 'Could not load e-mail settings.' });
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ ok: true, text: await fn() });
      await load();
    } catch (err: any) {
      setMessage({ ok: false, text: err?.message || 'Request failed.' });
    } finally {
      setBusy(false);
    }
  };

  if (!settings || !status) {
    return <div className="p-6 text-xs text-slate-500">{message?.text || 'Loading e-mail settings…'}</div>;
  }

  const set = <K extends keyof EmailSettings>(k: K, v: EmailSettings[K]) => setSettings({ ...settings, [k]: v });
  const save = () =>
    act(async () => {
      const { effective_recipients, ...body } = settings;
      void effective_recipients;
      await apiFetch('/api/email/settings', { method: 'PUT', body: { ...body, recipients: recipients.trim() || null } });
      return 'E-mail report settings saved.';
    });

  const Toggle = ({ k, label }: { k: keyof EmailSettings; label: string }) => (
    <label className="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" checked={Boolean(settings[k])} onChange={(e) => set(k, e.target.checked as any)} />
      <span>{label}</span>
    </label>
  );
  const Time = ({ k }: { k: keyof EmailSettings }) => (
    <input type="time" value={String(settings[k])} onChange={(e) => set(k, e.target.value as any)}
      className="border border-slate-300 rounded px-2 py-1 font-mono" />
  );
  const stateColor = status.state === 'READY' ? 'text-emerald-700' : status.state === 'OFFLINE' ? 'text-amber-700' : status.state === 'DISABLED' ? 'text-slate-500' : 'text-rose-700';

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6 space-y-4 text-xs max-w-4xl">
      {message && (
        <div className={`p-3 rounded border ${message.ok ? 'bg-emerald-50 border-emerald-300 text-emerald-800' : 'bg-rose-50 border-rose-300 text-rose-800'}`}>{message.text}</div>
      )}

      <div className="bg-white p-5 rounded border border-slate-200 space-y-2">
        <div className="font-semibold text-slate-900 border-b border-slate-100 pb-2 flex items-center gap-2">
          <Mail className="w-4 h-4 text-teal-700" /> Email delivery status
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div>State: <span className={`font-bold ${stateColor}`}>{status.state}</span></div>
          <div>Pending: <b>{status.counts.pending}</b></div>
          <div>Retrying: <b>{status.counts.retrying}</b></div>
          <div>Failed: <b className={status.counts.failed ? 'text-rose-700' : ''}>{status.counts.failed}</b></div>
          <div className="col-span-2">Last successful e-mail: <b>{fmt(status.last_sent_at)}</b></div>
          <div className="col-span-2">SMTP: <b>{status.config.smtp_host ? `${status.config.smtp_host}:${status.config.smtp_port}` : 'not configured'}</b> · From: <b>{status.config.from || '—'}</b></div>
        </div>
        {!status.config.enabled && <p className="text-amber-700 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> EMAIL_ENABLED is not true in the server .env: reports are not scheduled or sent.</p>}
        {status.config.config_error && <p className="text-rose-700">Configuration: {status.config.config_error}</p>}
        {status.last_error && <p className="text-rose-700 break-words">Last error ({status.last_error.job_type}, {fmt(status.last_error.at)}): {status.last_error.error}</p>}
        <p className="text-slate-500">The SMTP password is kept in the server .env only and is never shown here. Internet/SMTP outages never affect selling: reports wait and are sent automatically later.</p>
      </div>

      <div className="bg-white p-5 rounded border border-slate-200 space-y-3">
        <div className="font-semibold text-slate-900 border-b border-slate-100 pb-2">Reports &amp; schedule ({status.config.timezone})</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-center">
          <Toggle k="daily_stock_enabled" label="Daily Stock Report" /><div>at <Time k="stock_report_time" /></div>
          <Toggle k="business_summary_enabled" label="Daily Business Summary" /><div>at <Time k="business_report_time" /></div>
          <Toggle k="expiry_report_enabled" label="Weekly Expiry Report" />
          <div>
            every{' '}
            <select value={settings.expiry_report_weekday} onChange={(e) => set('expiry_report_weekday', Number(e.target.value))} className="border border-slate-300 rounded px-2 py-1">
              {WEEKDAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
            </select>{' '}
            at <Time k="expiry_report_time" />
          </div>
          <Toggle k="low_stock_digest_enabled" label="Low / Out-of-Stock Digest" /><div>at <Time k="low_stock_digest_time" /></div>
          <Toggle k="include_low_stock" label="Include low / out-of-stock lists in the stock report" /><div />
          <Toggle k="include_expiry" label="Include expiry section in the stock report" /><div />
        </div>
        <div>
          <div className="font-medium mb-1">Recipients (comma-separated)</div>
          <input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder={status.config.default_recipients.join(', ') || 'owner@example.com'}
            className="w-full border border-slate-300 rounded px-2 py-1.5" />
          <div className="text-slate-500 mt-1">Empty = server default ({status.config.default_recipients.join(', ') || 'none set'}). Currently sending to: {settings.effective_recipients.join(', ') || 'nobody'}</div>
        </div>
        <div className="flex flex-wrap gap-2 pt-2">
          <button disabled={busy} onClick={save} className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-teal-700 text-white font-semibold disabled:opacity-50 cursor-pointer"><Save className="w-3.5 h-3.5" /> Save</button>
          <button disabled={busy} onClick={() => act(async () => { await apiFetch('/api/email/test', { method: 'POST', body: {} }); return 'Test e-mail queued; it is sent in the background (see the list below).'; })}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 font-semibold disabled:opacity-50 cursor-pointer"><Send className="w-3.5 h-3.5" /> Send Test Email</button>
          <button disabled={busy} onClick={() => act(async () => { const r = await apiFetch<{ job: { created: boolean } }>('/api/email/reports/DAILY_STOCK/run', { method: 'POST', body: {} }); return r.job.created ? "Today's stock report queued." : "Today's stock report already exists (not duplicated)."; })}
            className="px-3 py-1.5 rounded border border-slate-300 font-semibold disabled:opacity-50 cursor-pointer">Send today's stock report now</button>
          {status.counts.failed > 0 && (
            <button disabled={busy} onClick={() => act(async () => `${(await apiFetch<{ requeued: number }>('/api/email/retry-failed', { method: 'POST', body: {} })).requeued} e-mail(s) re-queued.`)}
              className="px-3 py-1.5 rounded border border-slate-300 font-semibold disabled:opacity-50 cursor-pointer">Retry failed</button>
          )}
          <button disabled={busy} onClick={() => void load()} className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 font-semibold cursor-pointer"><RefreshCw className="w-3.5 h-3.5" /> Refresh</button>
        </div>
      </div>

      <div className="bg-white p-5 rounded border border-slate-200">
        <div className="font-semibold text-slate-900 border-b border-slate-100 pb-2 mb-2">Recent e-mails</div>
        <table className="w-full text-left">
          <thead className="text-[10px] uppercase text-slate-500"><tr><th className="py-1">Report</th><th>Date</th><th>Status</th><th>Attempts</th><th>Sent</th><th>Last error</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {jobs.length === 0 ? <tr><td colSpan={6} className="py-3 text-slate-400">No e-mails yet.</td></tr> : jobs.map((j) => (
              <tr key={j.id}>
                <td className="py-1 font-medium">{j.job_type}</td>
                <td>{j.report_date ? String(j.report_date).slice(0, 10) : '—'}</td>
                <td className={j.status === 'SENT' ? 'text-emerald-700 font-semibold' : j.status === 'FAILED' ? 'text-rose-700 font-semibold' : 'text-amber-700 font-semibold'}>{j.status}</td>
                <td>{j.attempt_count}</td>
                <td>{fmt(j.sent_at)}</td>
                <td className="max-w-[16rem] truncate" title={j.last_error || ''}>{j.last_error || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
