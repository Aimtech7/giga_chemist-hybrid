import { supabaseAdmin, isSupabaseConfigured, pgPool } from './client';
import { hashCredential, verifyCredential } from '../auth';
import type { User, UserRole } from '../../src/types';

export interface ServerUserRecord extends User {
  password_hash: string;
  pin_hash: string;
  salt: string;
  created_by?: string;
  updated_by?: string;
  updated_at?: string;
}

// In-memory persistent user repository for offline/isolated server environments
let localUsersStore: ServerUserRecord[] = [];

// Default production accounts with PBKDF2-SHA512 hashes (zero plaintext passwords)
const ADMIN_PWD_HASH = '779dee3d684fedaf93208ec655922c2d$6c586a0921bc148e975fa3213f5042f3c50f78675973b4ec1f13a0dbe169a264afd8451bc3864cbc23402132c723758f7216c2b0ffcc719352f002dc97446c31';
const ADMIN_PIN_HASH = '779dee3d684fedaf93208ec655922c2d$c8fe04e878654e4c19b6edccfe20e709084e606ddd83c1b8d57f6ef0b98b1da83e12edafa3df59662a165c9e09e41dd9ba2d04cb780d04934f3e09a2e6422524';
const CASHIER_PWD_HASH = '64366af56fd0eaeaf3953cdb930ddbea$0e91b3f2ad71606545da39425918b1e9d32732e29eddb7dd53dfdec87e2bd8629181632b400de352abc3e9054bee69ecfc69d7743a06eb5d98ae4c0e3b9216c0';
const CASHIER_PIN_HASH = '64366af56fd0eaeaf3953cdb930ddbea$29a014b818995f1a6d567e3aa108c65228411a2fbade8e54b7caeea4eeedb8fbc42b2c161c15bdf585be9024d7a61c6d0213b12324f535ca0b510152d21dd654';

function initializeDefaultDevUsers(): ServerUserRecord[] {
  return [
    {
      id: '00000000-0000-0000-0000-000000000099',
      name: 'Administrator',
      email: 'admin@gigachemist.co.ke',
      role: 'ADMIN',
      phone: '+254 700 123 456',
      active: true,
      created_at: '2026-01-01T00:00:00.000Z',
      password_hash: ADMIN_PWD_HASH,
      pin_hash: ADMIN_PIN_HASH,
      salt: '779dee3d684fedaf93208ec655922c2d',
    },
    {
      id: '00000000-0000-0000-0000-000000000098',
      name: 'Cashier',
      email: 'cashier@gigachemist.co.ke',
      role: 'CASHIER',
      phone: '+254 700 123 456',
      active: true,
      created_at: '2026-01-01T00:00:00.000Z',
      password_hash: CASHIER_PWD_HASH,
      pin_hash: CASHIER_PIN_HASH,
      salt: '64366af56fd0eaeaf3953cdb930ddbea',
    },
  ];
}

localUsersStore = initializeDefaultDevUsers();

export function sanitizeUser(user: ServerUserRecord): User {
  const { password_hash, pin_hash, salt, ...sanitized } = user;
  return sanitized;
}

export async function getAllUsers(): Promise<User[]> {
  try {
    const res = await pgPool.query(
      `SELECT id, branch_id, name, email, role, phone, active, created_at, updated_at, last_login FROM users ORDER BY name`
    );
    if (res.rows && res.rows.length > 0) {
      return res.rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        role: r.role,
        phone: r.phone || undefined,
        active: Boolean(r.active),
        created_at: r.created_at,
        updated_at: r.updated_at,
        last_login: r.last_login,
      }));
    }
  } catch (pgErr) {}

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabaseAdmin
        .from('users')
        .select('id, name, email, role, phone, active, created_at, updated_at, last_login')
        .order('name');
      if (!error && data && data.length > 0) {
        return data as User[];
      }
    } catch (err) {
      console.warn('[Server DB] Supabase users query failed:', err);
    }
  }
  return localUsersStore.map(sanitizeUser);
}

export async function getUserById(id: string): Promise<User | null> {
  try {
    const res = await pgPool.query(
      `SELECT id, branch_id, name, email, role, phone, active, created_at, updated_at, last_login FROM users WHERE id::text = $1`,
      [id]
    );
    if (res.rows && res.rows.length > 0) {
      const r = res.rows[0];
      return {
        id: r.id,
        name: r.name,
        email: r.email,
        role: r.role,
        phone: r.phone || undefined,
        active: Boolean(r.active),
        created_at: r.created_at,
        updated_at: r.updated_at,
        last_login: r.last_login,
      };
    }
  } catch (pgErr) {}

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabaseAdmin
        .from('users')
        .select('id, name, email, role, phone, active, created_at, updated_at, last_login')
        .eq('id', id)
        .single();
      if (!error && data) {
        return data as User;
      }
    } catch (err) {}
  }
  const found = localUsersStore.find((u) => u.id === id);
  return found ? sanitizeUser(found) : null;
}

export async function getUserAuthRecord(identifier: string): Promise<ServerUserRecord | null> {
  const cleanId = identifier.trim().toLowerCase();

  try {
    const res = await pgPool.query(
      `SELECT * FROM users WHERE LOWER(email) = $1 OR id::text = $1 LIMIT 1`,
      [cleanId]
    );
    if (res.rows && res.rows.length > 0) {
      const r = res.rows[0];
      return {
        id: r.id,
        name: r.name,
        email: r.email,
        role: r.role,
        phone: r.phone || undefined,
        active: Boolean(r.active),
        password_hash: r.password_hash,
        pin_hash: r.pin_hash,
        salt: r.password_hash?.includes('$') ? r.password_hash.split('$')[0] : '',
        created_at: r.created_at,
        updated_at: r.updated_at,
        last_login: r.last_login,
      };
    }
  } catch (pgErr) {}

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabaseAdmin
        .from('users')
        .select('*')
        .or(`email.ilike.${cleanId},id.eq.${cleanId}`)
        .single();
      if (!error && data) {
        return {
          ...data,
          salt: data.password_hash?.includes('$') ? data.password_hash.split('$')[0] : (data.salt || ''),
        } as ServerUserRecord;
      }
    } catch (err) {}
  }

  const found = localUsersStore.find(
    (u) => u.email.toLowerCase() === cleanId || u.id.toLowerCase() === cleanId
  );
  return found || null;
}

export async function createUser(data: {
  name: string;
  email: string;
  role: UserRole;
  password?: string;
  pin?: string;
  phone?: string;
  active?: boolean;
  created_by?: string;
}): Promise<User> {
  const cleanEmail = data.email.trim().toLowerCase();

  // Validate duplicate email
  const existing = await getUserAuthRecord(cleanEmail);
  if (existing) {
    throw new Error(`A user account with email "${cleanEmail}" already exists.`);
  }

  const defaultPassword = data.password || 'Giga@2026';
  const defaultPin = data.pin || '1234';

  const { combined: password_hash, salt } = hashCredential(defaultPassword);
  const { combined: pin_hash } = hashCredential(defaultPin, salt);

  const newUserRecord: ServerUserRecord = {
    id: `usr-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    name: data.name.trim(),
    email: cleanEmail,
    role: data.role,
    phone: data.phone?.trim() || undefined,
    active: data.active !== undefined ? data.active : true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: data.created_by,
    password_hash,
    pin_hash,
    salt,
  };

  try {
    await pgPool.query(
      `INSERT INTO users (id, name, email, role, phone, active, password_hash, pin_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (email) DO UPDATE SET password_hash = $7, pin_hash = $8, active = $6, updated_at = $10`,
      [
        newUserRecord.id,
        newUserRecord.name,
        newUserRecord.email,
        newUserRecord.role,
        newUserRecord.phone,
        newUserRecord.active,
        newUserRecord.password_hash,
        newUserRecord.pin_hash,
        newUserRecord.created_at,
        newUserRecord.updated_at,
      ]
    );
  } catch (pgErr) {}

  if (isSupabaseConfigured) {
    try {
      await supabaseAdmin.from('users').insert({
        id: newUserRecord.id,
        name: newUserRecord.name,
        email: newUserRecord.email,
        role: newUserRecord.role,
        phone: newUserRecord.phone,
        active: newUserRecord.active,
        password_hash: newUserRecord.password_hash,
        pin_hash: newUserRecord.pin_hash,
        created_at: newUserRecord.created_at,
      });
    } catch (err) {
      console.warn('[Server DB] Supabase user insert failed:', err);
    }
  }

  localUsersStore.push(newUserRecord);
  return sanitizeUser(newUserRecord);
}

export async function updateUser(
  id: string,
  updates: Partial<{
    name: string;
    email: string;
    role: UserRole;
    phone: string;
    active: boolean;
    password?: string;
    pin?: string;
  }>,
  updaterId?: string
): Promise<User> {
  const target = localUsersStore.find((u) => u.id === id);

  const updatedFields: any = {
    updated_at: new Date().toISOString(),
    updated_by: updaterId,
  };

  if (updates.name) updatedFields.name = updates.name.trim();
  if (updates.role) updatedFields.role = updates.role;
  if (updates.phone !== undefined) updatedFields.phone = updates.phone.trim();
  if (updates.active !== undefined) updatedFields.active = updates.active;

  if (updates.email) {
    const cleanEmail = updates.email.trim().toLowerCase();
    if (target && target.email.toLowerCase() !== cleanEmail) {
      const duplicate = localUsersStore.find((u) => u.id !== id && u.email.toLowerCase() === cleanEmail);
      if (duplicate) {
        throw new Error(`Email "${cleanEmail}" is already in use by another staff member.`);
      }
    }
    updatedFields.email = cleanEmail;
  }

  if (updates.password || updates.pin) {
    const salt = target?.salt || hashCredential('seed').salt;
    if (updates.password) {
      updatedFields.password_hash = hashCredential(updates.password, salt).combined;
    }
    if (updates.pin) {
      updatedFields.pin_hash = hashCredential(updates.pin, salt).combined;
    }
    updatedFields.salt = salt;
  }

  try {
    await pgPool.query(
      `UPDATE users SET name = COALESCE($1, name), email = COALESCE($2, email), role = COALESCE($3, role),
       phone = COALESCE($4, phone), active = COALESCE($5, active),
       password_hash = COALESCE($6, password_hash), pin_hash = COALESCE($7, pin_hash), updated_at = $8
       WHERE id::text = $9`,
      [
        updatedFields.name || null,
        updatedFields.email || null,
        updatedFields.role || null,
        updatedFields.phone || null,
        updatedFields.active !== undefined ? updatedFields.active : null,
        updatedFields.password_hash || null,
        updatedFields.pin_hash || null,
        updatedFields.updated_at,
        id,
      ]
    );
  } catch (pgErr) {}

  if (isSupabaseConfigured) {
    try {
      await supabaseAdmin.from('users').update(updatedFields).eq('id', id);
    } catch (err) {
      console.warn('[Server DB] Supabase update user failed:', err);
    }
  }

  if (target) {
    Object.assign(target, updatedFields);
    return sanitizeUser(target);
  }

  const updatedUser = await getUserById(id);
  if (!updatedUser) throw new Error(`User with ID ${id} not found.`);
  return updatedUser;
}

export async function toggleUserStatus(id: string, active: boolean, updaterId?: string): Promise<User> {
  // Safeguard: Check if deactivating the last active Admin
  if (active === false) {
    const target = await getUserAuthRecord(id);
    if (target && target.role === 'ADMIN') {
      let otherAdminCount = 0;
      try {
        const res = await pgPool.query(
          `SELECT COUNT(*)::int as count FROM users WHERE role = 'ADMIN' AND active = true AND id::text != $1`,
          [id]
        );
        otherAdminCount = Number(res.rows[0]?.count) || 0;
      } catch (err) {
        otherAdminCount = localUsersStore.filter((u) => u.role === 'ADMIN' && u.active && u.id !== id).length;
      }
      if (otherAdminCount < 1) {
        throw new Error('There must be at least one active Administrator. Cannot deactivate the last active Admin account.');
      }
    }
  }

  return updateUser(id, { active }, updaterId);
}

export async function changeUserPassword(data: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<{ success: boolean; message: string }> {
  const { userId, currentPassword, newPassword } = data;

  if (!currentPassword || !newPassword) {
    throw new Error('Current password and new password are required.');
  }

  if (newPassword.length < 6) {
    throw new Error('New password must be at least 6 characters long.');
  }

  const userRecord = await getUserAuthRecord(userId);
  if (!userRecord) {
    throw new Error('User not found.');
  }

  // Verify current password with PBKDF2/SHA-512
  const isCurrentValid = verifyCredential(currentPassword, userRecord.password_hash, userRecord.salt);
  if (!isCurrentValid) {
    throw new Error('Incorrect current password.');
  }

  // Hash new password using canonical PBKDF2/SHA-512
  const { combined: password_hash, salt } = hashCredential(newPassword);

  const now = new Date().toISOString();
  try {
    await pgPool.query(
      `UPDATE users SET password_hash = $1, updated_at = $2 WHERE id::text = $3`,
      [password_hash, now, userId]
    );
  } catch (pgErr) {}

  if (isSupabaseConfigured) {
    try {
      await supabaseAdmin.from('users').update({ password_hash, updated_at: now }).eq('id', userId);
    } catch (err) {}
  }

  userRecord.password_hash = password_hash;
  userRecord.salt = salt;
  userRecord.updated_at = now;

  const memUser = localUsersStore.find((u) => u.id === userId);
  if (memUser) {
    memUser.password_hash = password_hash;
    memUser.salt = salt;
    memUser.updated_at = now;
  }

  return { success: true, message: 'Password changed successfully.' };
}

export async function adminResetUserPassword(data: {
  targetUserId: string;
  newPassword: string;
  adminUserId?: string;
  adminPassword?: string;
}): Promise<{ success: boolean; message: string }> {
  const { targetUserId, newPassword, adminUserId, adminPassword } = data;

  if (!newPassword || newPassword.length < 6) {
    throw new Error('New password must be at least 6 characters long.');
  }

  // If admin password confirmation is provided, verify admin identity first
  if (adminUserId && adminPassword) {
    const adminRecord = await getUserAuthRecord(adminUserId);
    if (!adminRecord || adminRecord.role !== 'ADMIN') {
      throw new Error('Only an authorized Administrator can reset user passwords.');
    }
    const isAdminValid = verifyCredential(adminPassword, adminRecord.password_hash, adminRecord.salt);
    if (!isAdminValid) {
      throw new Error('Administrator confirmation password incorrect.');
    }
  }

  const targetRecord = await getUserAuthRecord(targetUserId);
  if (!targetRecord) {
    throw new Error('Target user account not found.');
  }

  // Hash new password using PBKDF2/SHA-512
  const { combined: password_hash, salt } = hashCredential(newPassword);
  const now = new Date().toISOString();

  try {
    await pgPool.query(
      `UPDATE users SET password_hash = $1, updated_at = $2 WHERE id::text = $3`,
      [password_hash, now, targetUserId]
    );
  } catch (pgErr) {}

  if (isSupabaseConfigured) {
    try {
      await supabaseAdmin.from('users').update({ password_hash, updated_at: now }).eq('id', targetUserId);
    } catch (err) {}
  }

  targetRecord.password_hash = password_hash;
  targetRecord.salt = salt;
  targetRecord.updated_at = now;

  const memUser = localUsersStore.find((u) => u.id === targetUserId);
  if (memUser) {
    memUser.password_hash = password_hash;
    memUser.salt = salt;
    memUser.updated_at = now;
  }

  return { success: true, message: `Password for ${targetRecord.name} was successfully reset.` };
}

export async function authenticateUser(identifier: string, secret: string): Promise<User> {
  const cleanId = identifier.trim();
  const cleanSecret = secret.trim();

  let userRecord = await getUserAuthRecord(cleanId);

  // If user identifier not found directly, also check if a user with given PIN matches
  if (!userRecord) {
    const allUsers = await getAllUsers();
    for (const u of allUsers) {
      const authRec = await getUserAuthRecord(u.email);
      if (authRec && (verifyCredential(cleanSecret || cleanId, authRec.pin_hash, authRec.salt) || verifyCredential(cleanSecret || cleanId, authRec.password_hash, authRec.salt))) {
        userRecord = authRec;
        break;
      }
    }
  }

  if (!userRecord) {
    throw new Error('Invalid credentials or account does not exist.');
  }

  if (!userRecord.active) {
    throw new Error('This staff account has been deactivated. Please contact an Administrator.');
  }

  const isPasswordValid = verifyCredential(cleanSecret, userRecord.password_hash, userRecord.salt);
  const isPinValid = verifyCredential(cleanSecret, userRecord.pin_hash, userRecord.salt);

  if (!isPasswordValid && !isPinValid) {
    throw new Error('Incorrect password or PIN.');
  }

  // Update last_login
  userRecord.last_login = new Date().toISOString();
  try {
    await pgPool.query(`UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id::text = $1`, [userRecord.id]);
  } catch (pgErr) {}

  if (isSupabaseConfigured) {
    void supabaseAdmin
      .from('users')
      .update({ last_login: userRecord.last_login })
      .eq('id', userRecord.id);
  }

  return sanitizeUser(userRecord);
}
