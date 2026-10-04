import React, { useState, useEffect } from 'react';
import {
  Plus,
  Lock,
  X,
  RefreshCw,
  Check,
  AlertCircle,
  KeyRound,
  ShieldCheck,
  UserCheck,
  UserX,
  Edit2,
} from 'lucide-react';
import { db } from '../../db/dexie';
import { apiFetch } from '../../services/http';

const PIN_RE = /^\d{4,6}$/;
import type { UserRole, User as UserType } from '../../types';

interface UserManagementProps {
  currentUser: UserType | null;
}

export const UserManagement: React.FC<UserManagementProps> = ({ currentUser }) => {
  const [users, setUsers] = useState<UserType[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Add / Edit Modal
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserType | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<UserRole>('CASHIER');
  const [pin, setPin] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [active, setActive] = useState(true);

  // Admin Reset Password Modal
  const [resetTargetUser, setResetTargetUser] = useState<UserType | null>(null);
  const [resetNewPassword, setResetNewPassword] = useState('');
  const [resetConfirmPassword, setResetConfirmPassword] = useState('');
  const [adminAuthPassword, setAdminAuthPassword] = useState('');
  const [isResetting, setIsResetting] = useState(false);

  const isAdmin = currentUser?.role === 'ADMIN';

  const loadUsers = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const data = await apiFetch<UserType[]>('/api/users');
      setUsers(data);
      // Read-only cache so the directory can still be viewed if the server is briefly unreachable
      await db.meta.put({ key: 'system_users', value: data });
    } catch (err: any) {
      const cached = await db.meta.get('system_users');
      if (cached && Array.isArray(cached.value)) setUsers(cached.value);
      setErrorMessage(
        `${err.message || 'Failed to load user directory from server.'}${cached ? ' Showing the last cached list (read-only).' : ''}`
      );
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isAdmin) {
      loadUsers();
    }
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-center">
        <div className="max-w-md p-6 bg-white rounded-lg border border-slate-200 shadow-xs">
          <Lock className="w-10 h-10 text-rose-500 mx-auto mb-2" />
          <h2 className="text-base font-bold text-slate-900">Restricted Module — Admin Only</h2>
          <p className="text-xs text-slate-600 mt-1">
            User and role administration, password resets, and account activations are strictly restricted to system Administrators.
          </p>
        </div>
      </div>
    );
  }

  const openForm = (u?: UserType) => {
    setErrorMessage(null);
    setSuccessMessage(null);
    if (u) {
      setEditingUser(u);
      setName(u.name);
      setEmail(u.email);
      setUsername(u.username || '');
      setRole(u.role);
      setPin('');
      setPassword('');
      setConfirmPassword('');
      setPhone(u.phone || '');
      setActive(u.active);
    } else {
      setEditingUser(null);
      setName('');
      setEmail('');
      setUsername('');
      setRole('CASHIER');
      // No default credentials: the Administrator sets the initial password (and optional PIN).
      setPin('');
      setPassword('');
      setConfirmPassword('');
      setPhone('+254 ');
      setActive(true);
    }
    setIsModalOpen(true);
  };

  const handleSaveUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;

    if (password && password !== confirmPassword) {
      setErrorMessage('Password and Confirm Password do not match.');
      return;
    }
    if (!editingUser && password.length < 8) {
      setErrorMessage('Set an initial password of at least 8 characters.');
      return;
    }
    if (pin.trim() && !PIN_RE.test(pin.trim())) {
      setErrorMessage('PIN must be 4 to 6 digits.');
      return;
    }

    setErrorMessage(null);
    setIsLoading(true);

    try {
      const payload: any = {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        // Empty clears the username; the server validates format and uniqueness.
        username: username.trim().toLowerCase() || null,
        role,
        phone: phone.trim() || undefined,
        active,
      };

      if (editingUser) {
        await apiFetch(`/api/users/${editingUser.id}`, { method: 'PUT', body: payload });
        // Credentials change only through the audited reset endpoint.
        if (password || pin.trim()) {
          await apiFetch(`/api/users/${editingUser.id}/reset-password`, {
            body: { new_password: password || undefined, new_pin: pin.trim() || undefined },
          });
        }
      } else {
        if (pin.trim()) payload.pin = pin.trim();
        payload.password = password;
        await apiFetch('/api/users', { body: payload });
      }

      setSuccessMessage(editingUser ? `Staff member ${name} updated successfully.` : `New user account for ${name} created successfully.`);
      setIsModalOpen(false);
      await loadUsers();
    } catch (err: any) {
      setErrorMessage(err.message || 'Error saving user to server.');
    } finally {
      setIsLoading(false);
    }
  };

  const toggleUserActive = async (u: UserType) => {
    if (u.id === currentUser?.id) {
      alert('You cannot deactivate your own active admin account.');
      return;
    }

    try {
      await apiFetch(`/api/users/${u.id}/status`, { method: 'PATCH', body: { active: !u.active } });

      setSuccessMessage(`Account ${u.name} is now ${!u.active ? 'Active' : 'Disabled'}.`);
      await loadUsers();
    } catch (err: any) {
      alert(err.message || 'Failed to update user status on server.');
    }
  };

  const openResetPasswordModal = (u: UserType) => {
    setResetTargetUser(u);
    setResetNewPassword('');
    setResetConfirmPassword('');
    setAdminAuthPassword('');
    setErrorMessage(null);
  };

  const handleAdminResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetTargetUser) return;

    if (resetNewPassword.length < 8) {
      setErrorMessage('New password must be at least 8 characters.');
      return;
    }

    if (resetNewPassword !== resetConfirmPassword) {
      setErrorMessage('New password and confirm password do not match.');
      return;
    }

    setIsResetting(true);
    setErrorMessage(null);

    try {
      await apiFetch(`/api/users/${resetTargetUser.id}/reset-password`, {
        body: {
          new_password: resetNewPassword,
          admin_password: adminAuthPassword || undefined,
        },
      });

      setSuccessMessage(`Password for ${resetTargetUser.name} (${resetTargetUser.email}) was reset successfully.`);
      setResetTargetUser(null);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to reset password.');
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      {/* Page Header */}
      <div className="p-4 bg-white border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-teal-700" />
            <h1 className="text-base font-bold text-slate-900 tracking-tight">
              User &amp; Access Management
            </h1>
            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-800 border border-purple-200">
              ADMIN ONLY
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Administer pharmacy accounts, roles (ADMIN / CASHIER), secure PBKDF2 credentials, and password resets.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={loadUsers}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold transition cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            onClick={() => openForm()}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold transition cursor-pointer shadow-xs"
          >
            <Plus className="w-4 h-4" />
            <span>Create New User</span>
          </button>
        </div>
      </div>

      {/* Notifications */}
      {errorMessage && (
        <div className="m-4 mb-0 p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button onClick={() => setErrorMessage(null)} className="font-bold text-rose-700 hover:text-rose-900 cursor-pointer">✕</button>
        </div>
      )}

      {successMessage && (
        <div className="m-4 mb-0 p-3 bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs rounded flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2">
            <Check className="w-4 h-4 shrink-0" />
            <span>{successMessage}</span>
          </div>
          <button onClick={() => setSuccessMessage(null)} className="font-bold text-emerald-700 hover:text-emerald-900 cursor-pointer">✕</button>
        </div>
      )}

      {/* User Directory Table */}
      <div className="flex-1 overflow-auto p-4">
        <div className="bg-white rounded-lg border border-slate-200 shadow-xs overflow-hidden">
          <table className="w-full text-left text-xs text-slate-700">
            <thead className="bg-slate-50 uppercase text-[10px] font-semibold text-slate-600 border-b border-slate-200">
              <tr>
                <th className="py-2.5 px-3">Staff Name</th>
                <th className="py-2.5 px-3">Email Identifier</th>
                <th className="py-2.5 px-3">Security Role</th>
                <th className="py-2.5 px-3">Phone</th>
                <th className="py-2.5 px-3">Last Login</th>
                <th className="py-2.5 px-3 text-center">Status</th>
                <th className="py-2.5 px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50 transition">
                  <td className="py-2.5 px-3 font-bold text-slate-900">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center font-bold text-slate-700 text-xs">
                        {u.name.charAt(0)}
                      </div>
                      <div>
                        <div>{u.name}</div>
                        {u.id === currentUser?.id && (
                          <span className="text-[10px] font-bold text-teal-700">(You - Current Admin)</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="py-2.5 px-3 font-mono text-slate-600">
                    {u.email}
                    {u.username && <div className="text-[10px] text-slate-400">username: {u.username}</div>}
                  </td>
                  <td className="py-2.5 px-3 font-medium">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${
                        u.role === 'ADMIN'
                          ? 'bg-purple-50 text-purple-800 border-purple-200'
                          : u.role === 'MANAGER'
                          ? 'bg-blue-50 text-blue-800 border-blue-200'
                          : 'bg-emerald-50 text-emerald-800 border-emerald-200'
                      }`}
                    >
                      {u.role}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 font-mono text-slate-600">{u.phone || '—'}</td>
                  <td className="py-2.5 px-3 text-slate-500 text-[11px]">
                    {u.last_login ? new Date(u.last_login).toLocaleString() : 'Never'}
                  </td>
                  <td className="py-2.5 px-3 text-center">
                    <span
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                        u.active ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500 border border-slate-200'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${u.active ? 'bg-emerald-600' : 'bg-slate-400'}`} />
                      <span>{u.active ? 'Active' : 'Deactivated'}</span>
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => openResetPasswordModal(u)}
                        className="flex items-center gap-1 px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold cursor-pointer"
                        title="Reset this user's password"
                      >
                        <KeyRound className="w-3 h-3 text-slate-500" />
                        <span>Reset Password</span>
                      </button>

                      <button
                        onClick={() => openForm(u)}
                        className="px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-semibold cursor-pointer"
                      >
                        Edit
                      </button>

                      {u.id !== currentUser?.id && (
                        <button
                          onClick={() => toggleUserActive(u)}
                          className={`px-2 py-1 rounded text-xs font-semibold cursor-pointer ${
                            u.active
                              ? 'bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200'
                              : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200'
                          }`}
                        >
                          {u.active ? 'Deactivate' : 'Activate'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create / Edit User Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="w-full max-w-md bg-white rounded-lg border border-slate-300 shadow-xl overflow-hidden text-slate-800 animate-in fade-in-50 duration-150">
            <div className="bg-slate-900 px-4 py-3 text-white flex justify-between items-center">
              <span className="font-bold text-xs">
                {editingUser ? `Edit Account: ${editingUser.name}` : 'Create New Pharmacy User'}
              </span>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-white p-1 rounded cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveUser} className="p-4 space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Full Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Grace Wambui"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Email *</label>
                <input
                  type="email"
                  required
                  placeholder="e.g. grace@gigachemist.co.ke"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Username (optional, for sign-in)</label>
                <input
                  type="text"
                  placeholder="e.g. grace"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                  className="w-full p-2 border border-slate-300 rounded font-mono focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                />
                <span className="text-[10px] text-slate-400">3-50 letters, digits, dot, underscore or hyphen. Staff can sign in with this or their email.</span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Role *</label>
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value as UserRole)}
                    className="w-full p-2 border border-slate-300 rounded bg-white font-medium focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                  >
                    <option value="CASHIER">CASHIER (POS Sales only)</option>
                    <option value="MANAGER">MANAGER (Inventory &amp; Sales)</option>
                    <option value="ADMIN">ADMIN (Full Authority)</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Phone Number</label>
                  <input
                    type="text"
                    placeholder="+254 700 000 000"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full p-2 border border-slate-300 rounded font-mono focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                  />
                </div>
              </div>

              {!editingUser && (
                <>
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Password *</label>
                    <input
                      type="password"
                      required
                      minLength={6}
                      placeholder="At least 8 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full p-2 border border-slate-300 rounded font-mono focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                    />
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Confirm Password *</label>
                    <input
                      type="password"
                      required
                      placeholder="Confirm password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="w-full p-2 border border-slate-300 rounded font-mono focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                    />
                  </div>
                </>
              )}

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Quick 4-Digit Login PIN</label>
                <input
                  type="password"
                  maxLength={6}
                  placeholder={editingUser ? 'Leave blank to retain current PIN' : 'e.g. 1234'}
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded font-mono font-bold focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                />
              </div>

              <div className="pt-2 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="px-4 py-1.5 rounded bg-teal-700 hover:bg-teal-800 text-white font-semibold transition cursor-pointer disabled:opacity-50"
                >
                  {isLoading ? 'Saving...' : editingUser ? 'Save Changes' : 'Create Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Admin Reset User Password Modal */}
      {resetTargetUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="w-full max-w-md bg-white rounded-lg border border-slate-300 shadow-xl overflow-hidden text-slate-800 animate-in fade-in-50 duration-150">
            <div className="bg-slate-900 px-4 py-3 text-white flex justify-between items-center">
              <span className="font-bold text-xs flex items-center gap-1.5">
                <KeyRound className="w-4 h-4 text-teal-400" />
                Reset Password for {resetTargetUser.name}
              </span>
              <button
                onClick={() => setResetTargetUser(null)}
                className="text-slate-400 hover:text-white p-1 rounded cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleAdminResetPassword} className="p-4 space-y-3 text-xs">
              <div className="p-2.5 bg-slate-100 rounded border border-slate-200">
                <div className="font-semibold text-slate-800">{resetTargetUser.name}</div>
                <div className="text-slate-500 font-mono text-[11px]">{resetTargetUser.email} (Role: {resetTargetUser.role})</div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">New Password (Min 6 chars) *</label>
                <input
                  type="password"
                  required
                  minLength={6}
                  placeholder="Enter new password for this user"
                  value={resetNewPassword}
                  onChange={(e) => setResetNewPassword(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded font-mono focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Confirm New Password *</label>
                <input
                  type="password"
                  required
                  placeholder="Re-type new password"
                  value={resetConfirmPassword}
                  onChange={(e) => setResetConfirmPassword(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded font-mono focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Admin Confirmation Password (Optional)</label>
                <input
                  type="password"
                  placeholder="Enter your own admin password if prompted"
                  value={adminAuthPassword}
                  onChange={(e) => setAdminAuthPassword(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded font-mono focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                />
              </div>

              <div className="pt-2 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setResetTargetUser(null)}
                  className="px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isResetting}
                  className="px-4 py-1.5 rounded bg-teal-700 hover:bg-teal-800 text-white font-semibold transition cursor-pointer disabled:opacity-50"
                >
                  {isResetting ? 'Resetting...' : 'Reset User Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
