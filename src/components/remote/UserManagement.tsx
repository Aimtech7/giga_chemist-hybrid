import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, LogOut, Plus, Power, RefreshCw, Save, ShieldCheck, Trash2, UploadCloud, UserCog } from 'lucide-react';
import { ApiError } from '../../services/http';
import {
  createGlobalAdmin, createShopUser, deleteGlobalAdmin, getAccounts, getPublishPreview, publishExistingShopUsers,
  resetGlobalAdminPassword, resetShopUserPassword, revokeGlobalAdminSessions, revokeShopUserSessions, setGlobalAdminActive,
  setShopUserActive, setShopUserRole, updateGlobalAdminProfile, updateShopUserProfile,
} from '../../services/remoteAdmin';
import { currentShopLabel } from '../../services/shopContext';
import { Pill, Sheet, btnPrimary, btnSecondary, card, inputCls, labelCls, when } from './remoteUi';
import type { User } from '../../types';

/**
 * USER MANAGEMENT (online, Global Administrators only).
 *  - GLOBAL ADMINS: cloud accounts with authority over every shop.
 *  - SHOP USERS: each shop's staff; the SAME password works at the shop and online (the PIN stays
 *    shop-only). Changes apply to the cloud login at once and are queued for the shop computer.
 * Every change names the target shop before confirmation. Passwords are sent once, never shown or kept.
 */
const errText = (err: any) => (err instanceof ApiError ? err.message : 'Could not reach the online server.');
const ROLES = ['CASHIER', 'MANAGER', 'ADMIN'];

export const UsersTab: React.FC<{ currentUser: User | null }> = ({ currentUser }) => {
  const [scope, setScope] = useState<'selected' | 'all'>('selected');
  const [data, setData] = useState<{ global_admins: any[]; shop_users: any[]; shop_filter: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<null | { kind: 'new-staff' | 'new-admin' } | { kind: 'staff'; u: any } | { kind: 'admin'; u: any }>(null);
  const shop = currentShopLabel();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getAccounts(scope));
    } catch (err) {
      setNote({ ok: false, text: errText(err) });
    } finally {
      setLoading(false);
    }
  }, [scope]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (confirmText: string | null, fn: () => Promise<any>, done: string) => {
    if (confirmText && !window.confirm(confirmText)) return false;
    setBusy(true);
    try {
      const r = await fn();
      setNote({ ok: true, text: r?.command ? `${done} Queued for the shop computer (${r.command.shop_code || 'shop'}): ${r.command.status}.` : done });
      setSheet(null);
      await load();
      return true;
    } catch (err) {
      setNote({ ok: false, text: errText(err) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const selectedFilter = data?.shop_filter;
  const inSelectedShop = (u: any) => scope === 'selected' || (selectedFilter && u.shop_id === selectedFilter);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-bold text-slate-600 uppercase tracking-wide">User management</div>
        <button onClick={() => void load()} className="text-xs font-semibold text-teal-800 flex items-center gap-1">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh
        </button>
      </div>
      {note && <div className={`text-xs rounded p-2 border ${note.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>{note.text}</div>}

      {/* ---------------------------------------------------------------- global admins */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-bold text-slate-800 flex items-center gap-1.5"><ShieldCheck className="w-4 h-4 text-teal-700" /> Global administrators</div>
          <button className="text-xs font-semibold text-teal-800 flex items-center gap-1" onClick={() => setSheet({ kind: 'new-admin' })}><Plus className="w-3.5 h-3.5" /> Add</button>
        </div>
        <p className="text-[11px] text-slate-500">Cloud accounts with authority over every shop. The last active Global Administrator can never be deactivated or deleted.</p>
        {(data?.global_admins || []).map((u) => (
          <button key={u.id} className={`${card} w-full text-left`} onClick={() => setSheet({ kind: 'admin', u })}>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0"><div className="text-sm font-semibold text-slate-900 truncate">{u.name}{u.id === currentUser?.id ? ' (you)' : ''}</div><div className="text-[11px] text-slate-500 truncate">{u.email} · last login {when(u.last_login_at)}</div></div>
              <Pill tone={u.active ? 'ok' : 'bad'}>{u.active ? 'ACTIVE' : 'DEACTIVATED'}</Pill>
            </div>
          </button>
        ))}
      </section>

      {/* ---------------------------------------------------------------- shop users */}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-bold text-slate-800 flex items-center gap-1.5"><UserCog className="w-4 h-4 text-teal-700" /> Shop users</div>
          <div className="flex items-center gap-2">
            <select className="text-xs border border-slate-300 rounded px-1.5 py-1 bg-white" value={scope} onChange={(e) => setScope(e.target.value as any)} aria-label="Shop filter">
              <option value="selected">{shop}</option>
              <option value="all">All shops</option>
            </select>
            <button className="text-xs font-semibold text-teal-800 flex items-center gap-1" onClick={() => setSheet({ kind: 'new-staff' })}><Plus className="w-3.5 h-3.5" /> Add</button>
          </div>
        </div>
        <p className="text-[11px] text-slate-500">Same password at the shop and online (the PIN stays at the shop). “No online login” = the shop has not published this account's credentials yet.</p>
        {(data?.shop_users || []).map((u) => (
          <button key={`${u.shop_id}:${u.local_user_id}`} className={`${card} w-full text-left ${inSelectedShop(u) ? '' : 'opacity-70'}`} onClick={() => setSheet({ kind: 'staff', u })}>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-900 truncate">{u.name}</div>
                <div className="text-[11px] text-slate-500 truncate">{u.shop_code} · {u.email}{u.username ? ` · ${u.username}` : ''}</div>
              </div>
              <div className="flex flex-wrap gap-1 justify-end shrink-0">
                <Pill tone="muted">{u.role}</Pill>
                <Pill tone={(u.shop_active ?? u.online_active) ? 'ok' : 'bad'}>{(u.shop_active ?? u.online_active) ? 'ACTIVE' : 'DEACTIVATED'}</Pill>
                {!u.online_account_id && <Pill tone="warn">NO ONLINE LOGIN</Pill>}
                {u.open_commands > 0 && <Pill tone="warn">{u.open_commands} PENDING</Pill>}
              </div>
            </div>
          </button>
        ))}
        {data && data.shop_users.length === 0 && <div className="text-xs text-slate-500">No staff synced for this shop yet.</div>}
      </section>

      {scope === 'selected' && <PublishExisting shop={shop} onDone={load} />}

      {sheet?.kind === 'new-admin' && <NewAccountSheet title="New Global Administrator" busy={busy} global onClose={() => setSheet(null)}
        onSubmit={(v) => act(`Create Global Administrator ${v.email}? It will have authority over EVERY shop.`, () => createGlobalAdmin({ name: v.name, email: v.email, password: v.password }), 'Global Administrator created.')} />}
      {sheet?.kind === 'new-staff' && <NewAccountSheet title={`${shop} — New staff account`} busy={busy} onClose={() => setSheet(null)}
        onSubmit={(v) => act(`Target: ${shop}\nCreate ${v.role} account ${v.email}?`, () => createShopUser(v), 'Account created; online login works now.')} />}
      {sheet?.kind === 'staff' && (
        <StaffSheet u={sheet.u} busy={busy} manageable={inSelectedShop(sheet.u)} shop={shop} onClose={() => setSheet(null)} act={act} />
      )}
      {sheet?.kind === 'admin' && <AdminSheet u={sheet.u} busy={busy} self={sheet.u.id === currentUser?.id} onClose={() => setSheet(null)} act={act} />}
    </div>
  );
};

type Act = (confirmText: string | null, fn: () => Promise<any>, done: string) => Promise<boolean>;

const PasswordReset: React.FC<{ busy: boolean; onReset: (pw: string) => Promise<boolean> }> = ({ busy, onReset }) => {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const ok = pw.length >= 8 && pw === pw2;
  return (
    <div className="space-y-2 border-t border-slate-200 pt-3">
      <label className={labelCls}>New password (min 8 characters)</label>
      <input className={inputCls} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      <input className={inputCls} type="password" autoComplete="new-password" placeholder="Repeat password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
      <button className={btnSecondary} disabled={busy || !ok} onClick={async () => { if (await onReset(pw)) { setPw(''); setPw2(''); } }}>
        <KeyRound className="w-4 h-4" /> Reset password (signs out online sessions)
      </button>
    </div>
  );
};

const StaffSheet: React.FC<{ u: any; busy: boolean; manageable: boolean; shop: string; onClose: () => void; act: Act }> = ({ u, busy, manageable, shop, onClose, act }) => {
  const [role, setRole] = useState(u.role);
  const active = u.shop_active ?? u.online_active;
  const target = `Target: ${u.shop_name || u.shop_code} (${u.shop_code})\nStaff: ${u.name} <${u.email}>`;
  // What the Administrator SAW: sent as `expected`, so a newer change at the shop is never overwritten.
  const saw = { name: u.name || '', username: u.username || null, email: String(u.email || '').toLowerCase() };
  const [form, setForm] = useState({ name: saw.name, username: saw.username || '', email: saw.email });
  const next = { name: form.name.trim(), username: form.username.trim().toLowerCase() || null, email: form.email.trim().toLowerCase() };
  const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== saw[k]);
  const loginChange = changed.includes('email') || changed.includes('username');
  const info: [string, React.ReactNode][] = [
    ['Shop', `${u.shop_name || u.shop_code} (${u.shop_code})`],
    ['Local user id', <span className="font-mono">{u.local_user_id}</span>],
    ['Online account id', u.online_account_id ? <span className="font-mono">{u.online_account_id}</span> : 'none yet'],
    ['Online login', u.online_account_id ? (u.online_active ? 'enabled' : 'blocked') : 'not published yet'],
    ['Last online login', when(u.last_login_at)],
    ['Credential sync', !u.credential_sync_enabled ? 'off for this shop' : u.online_account_id ? `version ${u.credential_version ?? '?'} (${u.credential_source || '?'}) ${when(u.credential_updated_at)}` : 'waiting for the shop'],
    ['Open commands', u.open_commands > 0 ? `${u.open_commands} waiting for the shop` : 'none'],
    ['Sessions', u.online_account_id ? (u.online_active ? 'valid until revoked' : 'revoked (deactivated)') : '—'],
  ];
  return (
    <Sheet title={`${u.shop_code} — ${u.name}`} onClose={onClose}>
      {!manageable ? (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">This account belongs to {u.shop_code}. Select {u.shop_code} in the shop selector to manage it (currently: {shop}).</p>
      ) : (
        <div className="space-y-3">
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-[11px]">
            {info.map(([k, v]) => <React.Fragment key={k}><dt className="text-slate-500">{k}</dt><dd className="text-slate-800 break-all">{v}</dd></React.Fragment>)}
          </dl>
          <div className="space-y-2 border-t border-slate-200 pt-3">
            <div className="text-xs font-bold text-slate-700">Edit user</div>
            <div><label className={labelCls}>Full name</label><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label className={labelCls}>Username (optional)</label><input className={inputCls} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></div>
            <div><label className={labelCls}>Email (login)</label><input className={inputCls} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            <button className={btnPrimary} disabled={busy || !changed.length || !next.name || !/\S+@\S+\.\S+/.test(next.email)}
              onClick={() => act(`${target}\nSave ${changed.join(', ')}?${loginChange ? '\nThe new login works online now (old one stops, online sessions end) and at the shop once it syncs.' : ''}\nHistorical sales and receipts keep the name they were recorded with.`,
                () => updateShopUserProfile(u.local_user_id,
                  Object.fromEntries(changed.map((k) => [k, next[k]])),
                  Object.fromEntries(changed.map((k) => [k, saw[k]]))),
                'Profile change saved online.')}>
              <Save className="w-4 h-4" /> Save changes
            </button>
          </div>
          <button className={active ? 'w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-rose-700 text-white text-sm font-bold disabled:opacity-50' : btnPrimary} disabled={busy}
            onClick={() => act(`${target}\n${active ? 'DEACTIVATE (blocks online login now; the shop applies it when it syncs)' : 'Reactivate'} this account?`,
              () => setShopUserActive(u.local_user_id, !active), active ? 'Account deactivated online.' : 'Reactivation requested.')}>
            <Power className="w-4 h-4" /> {active ? 'Deactivate' : 'Reactivate'}
          </button>
          <div className="flex gap-2 items-end">
            <div className="flex-1"><label className={labelCls}>Role</label>
              <select className={inputCls} value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select></div>
            <button className={`${btnSecondary} w-auto`} disabled={busy || role === u.role}
              onClick={() => act(`${target}\nChange role ${u.role} → ${role}?`, () => setShopUserRole(u.local_user_id, role), 'Role change requested.')}>Change role</button>
          </div>
          {u.online_account_id && (
            <>
              <PasswordReset busy={busy} onReset={(pw) => act(`${target}\nReset this password? The new password works online now and at the shop once it syncs.`,
                () => resetShopUserPassword(u.local_user_id, pw), 'Password reset.')} />
              <button className={btnSecondary} disabled={busy}
                onClick={() => act(`${target}\nSign this account out of every online session?`, () => revokeShopUserSessions(u.local_user_id), 'Online sessions revoked.')}>
                <LogOut className="w-4 h-4" /> Revoke online sessions
              </button>
            </>
          )}
          <p className="text-[11px] text-slate-500">Staff accounts are never deleted (sales and audits reference them): deactivate instead.</p>
        </div>
      )}
    </Sheet>
  );
};

const AdminSheet: React.FC<{ u: any; busy: boolean; self: boolean; onClose: () => void; act: Act }> = ({ u, busy, self, onClose, act }) => {
  const saw = { name: u.name || '', email: String(u.email || '').toLowerCase() };
  const [form, setForm] = useState(saw);
  const next = { name: form.name.trim(), email: form.email.trim().toLowerCase() };
  const changed = next.name !== saw.name || next.email !== saw.email;
  return (
  <Sheet title={`Global Administrator — ${u.name}`} onClose={onClose}>
    <div className="space-y-3">
      <div className="text-[11px] text-slate-500">{u.email} · {u.active ? 'active' : 'deactivated'} · last login {when(u.last_login_at)} · created {when(u.created_at)}</div>
      <div className="space-y-2">
        <div><label className={labelCls}>Full name</label><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div><label className={labelCls}>Email (login)</label><input className={inputCls} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
        <button className={btnPrimary} disabled={busy || !changed || !next.name || !/\S+@\S+\.\S+/.test(next.email)}
          onClick={() => act(`Save Global Administrator ${saw.email}?${next.email !== saw.email ? `\nThe login email becomes ${next.email}; existing sessions end.${self ? ' You will sign in again.' : ''}` : ''}`,
            () => updateGlobalAdminProfile(u.id, { ...(next.name !== saw.name ? { name: next.name } : {}), ...(next.email !== saw.email ? { email: next.email } : {}) }, saw),
            'Global Administrator saved.')}>
          <Save className="w-4 h-4" /> Save changes
        </button>
      </div>
      <button className={btnSecondary} disabled={busy || self}
        onClick={() => act(`${u.active ? 'Deactivate' : 'Reactivate'} Global Administrator ${u.email}?`, () => setGlobalAdminActive(u.id, !u.active), u.active ? 'Deactivated.' : 'Reactivated.')}>
        <Power className="w-4 h-4" /> {u.active ? 'Deactivate' : 'Reactivate'}{self ? ' (not your own account)' : ''}
      </button>
      <PasswordReset busy={busy} onReset={(pw) => act(`Reset the password of ${u.email}?${self ? ' You will be signed out.' : ''}`, () => resetGlobalAdminPassword(u.id, pw), 'Password reset.')} />
      <button className={btnSecondary} disabled={busy} onClick={() => act(`Sign ${u.email} out of every online session?`, () => revokeGlobalAdminSessions(u.id), 'Sessions revoked.')}>
        <LogOut className="w-4 h-4" /> Revoke sessions
      </button>
      {!self && (
        <button className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-rose-700 text-xs font-semibold" disabled={busy}
          onClick={() => act(`PERMANENTLY delete ${u.email}? Only possible for an account that never acted; otherwise deactivate it.`, () => deleteGlobalAdmin(u.id), 'Deleted.')}>
          <Trash2 className="w-3.5 h-3.5" /> Delete permanently
        </button>
      )}
    </div>
  </Sheet>
  );
};

/**
 * PUBLISH EXISTING SHOP USERS: dry run first (from the shop's last heartbeat; no password data), then
 * a typed shop-code confirmation turns credential publishing on for the selected shop.
 */
const PublishExisting: React.FC<{ shop: string; onDone: () => void }> = ({ shop, onDone }) => {
  const [p, setP] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [code, setCode] = useState('');
  const preview = async () => {
    setBusy(true);
    setMsg(null);
    try { setP(await getPublishPreview()); } catch (err) { setMsg({ ok: false, text: errText(err) }); } finally { setBusy(false); }
  };
  const publish = async () => {
    setBusy(true);
    try {
      const r = await publishExistingShopUsers(code);
      setMsg({ ok: true, text: `${r.already_enabled ? 'Already enabled.' : 'Enabled.'} ${r.note}` });
      setP(null);
      onDone();
    } catch (err) {
      setMsg({ ok: false, text: errText(err) });
    } finally {
      setBusy(false);
    }
  };
  const s = p?.summary;
  const rows: [string, number][] = s ? [
    ['Local users', s.local_users], ['Cloud matches', s.cloud_matches], ['Cloud identities to create', s.cloud_identities_to_create],
    ['Username conflicts', s.username_conflicts], ['Usernames also used in another shop (log in by email)', s.usernames_also_used_by_another_shop],
    ['Email conflicts', s.email_conflicts], ['Inactive users', s.inactive_users], ['Accounts missing password hash', s.accounts_without_usable_password],
  ] : [];
  return (
    <section className="space-y-2 border-t border-slate-200 pt-3">
      <div className="text-sm font-bold text-slate-800 flex items-center gap-1.5"><UploadCloud className="w-4 h-4 text-teal-700" /> Publish existing shop users</div>
      <p className="text-[11px] text-slate-500">Gives {shop}'s existing staff the same password online (PIN stays at the shop). Run the dry run first; nothing changes until you confirm.</p>
      <button className={btnSecondary} disabled={busy} onClick={() => void preview()}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Dry run</button>
      {msg && <div className={`text-xs rounded p-2 border ${msg.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>{msg.text}</div>}
      {p && !p.ready && <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">{p.note}</div>}
      {p?.ready && (
        <div className="space-y-2">
          <div className="text-[11px] text-slate-500">Shop {p.shop.shop_code} · staff reported {when(p.heartbeat_at)} · publishing is {p.credential_sync_enabled ? 'ON' : 'OFF'}</div>
          <table className="w-full text-xs"><tbody>{rows.map(([k, v]) => <tr key={k} className="border-b border-slate-100"><td className="py-0.5 text-slate-600">{k}</td><td className="py-0.5 text-right font-semibold">{v}</td></tr>)}</tbody></table>
          <div className="space-y-1">
            {p.accounts.map((a: any) => (
              <div key={a.local_user_id} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="truncate">{a.name} · {a.email}{a.username ? ` · ${a.username}` : ''} · {a.role}{a.active ? '' : ' (inactive)'}</span>
                <Pill tone={a.status === 'MATCHED' || a.status === 'TO_CREATE' ? 'ok' : 'warn'}>{a.status.replace(/_/g, ' ')}</Pill>
              </div>
            ))}
          </div>
          {!p.credential_sync_enabled && (
            <div className="flex gap-2 items-end">
              <div className="flex-1"><label className={labelCls}>Type the shop code ({p.shop.shop_code}) to publish</label><input className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} /></div>
              <button className={`${btnPrimary} w-auto`} disabled={busy || code.trim().toUpperCase() !== String(p.shop.shop_code).toUpperCase()} onClick={() => void publish()}>Publish</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
};

const NewAccountSheet: React.FC<{ title: string; busy: boolean; global?: boolean; onClose: () => void;
  onSubmit: (v: { name: string; email: string; username?: string; role: string; password: string }) => Promise<boolean> }> = ({ title, busy, global, onClose, onSubmit }) => {
  const [v, setV] = useState({ name: '', email: '', username: '', role: 'CASHIER', password: '', password2: '' });
  const ok = v.name.trim() && /\S+@\S+\.\S+/.test(v.email) && v.password.length >= 8 && v.password === v.password2;
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="space-y-2">
        <div><label className={labelCls}>Name</label><input className={inputCls} value={v.name} onChange={set('name')} /></div>
        <div><label className={labelCls}>Email (login)</label><input className={inputCls} type="email" value={v.email} onChange={set('email')} /></div>
        {!global && <div><label className={labelCls}>Username (optional)</label><input className={inputCls} value={v.username} onChange={set('username')} /></div>}
        {!global && <div><label className={labelCls}>Role</label><select className={inputCls} value={v.role} onChange={set('role')}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select></div>}
        <div><label className={labelCls}>Password (min 8 characters)</label><input className={inputCls} type="password" autoComplete="new-password" value={v.password} onChange={set('password')} /></div>
        <div><label className={labelCls}>Repeat password</label><input className={inputCls} type="password" autoComplete="new-password" value={v.password2} onChange={set('password2')} /></div>
        <button className={btnPrimary} disabled={busy || !ok}
          onClick={async () => { if (await onSubmit({ name: v.name.trim(), email: v.email.trim(), username: v.username.trim() || undefined, role: v.role, password: v.password })) setV({ ...v, password: '', password2: '' }); }}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create
        </button>
      </div>
    </Sheet>
  );
};
