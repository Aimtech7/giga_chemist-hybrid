import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, LogOut, Plus, Power, RefreshCw, ShieldCheck, Trash2, UserCog } from 'lucide-react';
import { ApiError } from '../../services/http';
import {
  createGlobalAdmin, createShopUser, deleteGlobalAdmin, getAccounts, resetGlobalAdminPassword, resetShopUserPassword,
  revokeGlobalAdminSessions, revokeShopUserSessions, setGlobalAdminActive, setShopUserActive, setShopUserRole,
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
const ROLES = ['CASHIER', 'ADMIN'];

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
  const [role, setRole] = useState(u.role === 'ADMIN' ? 'CASHIER' : 'ADMIN');
  const active = u.shop_active ?? u.online_active;
  const target = `Target: ${u.shop_name || u.shop_code} (${u.shop_code})\nStaff: ${u.name} <${u.email}>`;
  return (
    <Sheet title={`${u.shop_code} — ${u.name}`} onClose={onClose}>
      {!manageable ? (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">This account belongs to {u.shop_code}. Select {u.shop_code} in the shop selector to manage it (currently: {shop}).</p>
      ) : (
        <div className="space-y-3">
          <div className="text-[11px] text-slate-500">Role {u.role} · {active ? 'active' : 'deactivated'} · online login {u.online_account_id ? (u.online_active ? 'enabled' : 'blocked') : 'not published yet'} · last online login {when(u.last_login_at)}</div>
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

const AdminSheet: React.FC<{ u: any; busy: boolean; self: boolean; onClose: () => void; act: Act }> = ({ u, busy, self, onClose, act }) => (
  <Sheet title={`Global Administrator — ${u.name}`} onClose={onClose}>
    <div className="space-y-3">
      <div className="text-[11px] text-slate-500">{u.email} · {u.active ? 'active' : 'deactivated'} · created {when(u.created_at)}</div>
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
