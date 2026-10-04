import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import {
  getAllCategories,
  getAllMedicines,
  upsertMedicine,
  adminUpdateMedicinePricing,
  getAllBatches,
  upsertBatch,
  getAllMovements,
  recordInventoryMovement,
  adminSetStock,
  adminAddStock,
  adminRemoveStock,
  adminEditBatchExpiry,
  adminPhysicalStockCount,
  getAllSales,
  processSaleCheckout,
  getTodaySalesSummary,
  getAllCustomers,
  upsertCustomer,
  getAllSuppliers,
  upsertSupplier,
  getAllPurchases,
  receivePurchaseOrder,
  getAllReturns,
  processCustomerReturn,
  getAllExpenses,
  recordExpense,
  getAllAuditLogs,
  recordAuditLog,
  getPharmacySettings,
  updatePharmacySettings,
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  toggleUserStatus,
  changeUserPassword,
  adminResetUserPassword,
  authenticateUser,
  registerDevice,
  checkPgConnection,
  getAppMode,
  isSupabaseConfigured,
  requireUuid,
} from './db/index';
import {
  createJwtToken,
  verifyJwtToken,
  hasPermission,
  ROLE_PERMISSIONS,
  type JwtPayload,
} from './auth';
import type {
  User,
  UserRole,
  Medicine,
  MedicineBatch,
  Sale,
  SyncPayload,
  SyncResponse,
  InventoryMovement,
  PharmacySettings,
} from '../src/types';

export const apiRouter = Router();

export interface AuthenticatedRequest extends Request {
  userRole?: UserRole;
  userId?: string;
  userName?: string;
  userEmail?: string;
  tokenPayload?: JwtPayload;
}

// 1. In-Memory Sliding-Window Rate Limiter for Authentication Endpoints
interface RateLimitRecord {
  count: number;
  resetAt: number;
}
const authRateLimits = new Map<string, RateLimitRecord>();

function authRateLimiter(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxAttempts = 20;

  const record = authRateLimits.get(ip);
  if (!record || now > record.resetAt) {
    authRateLimits.set(ip, { count: 1, resetAt: now + windowMs });
    return next();
  }

  record.count++;
  if (record.count > maxAttempts) {
    return res.status(429).json({
      error: 'Too many authentication attempts. Please wait 1 minute before retrying.',
      retryAfter: Math.ceil((record.resetAt - now) / 1000),
    });
  }

  next();
}

// 2. Authentication & JWT Extraction Middleware
export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  let token = '';

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }

  // Also support fallback header in test / legacy clients if provided
  if (!token && req.headers['x-auth-token']) {
    token = (req.headers['x-auth-token'] as string).trim();
  }

  if (token) {
    const { valid, payload } = verifyJwtToken(token);
    if (valid && payload) {
      req.tokenPayload = payload;
      req.userId = payload.userId;
      req.userRole = payload.role;
      req.userName = payload.name;
      req.userEmail = payload.email;
      return next();
    }
  }

  // Authorization comes only from a verified token. x-user-* headers are never trusted.
  // Unauthenticated / Anonymous default
  req.userRole = undefined;
  req.userId = undefined;
  req.userName = undefined;
  next();
}

// 3. RBAC Guards & Middleware
export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.userRole || !req.userId) {
    return res.status(401).json({
      error: 'Unauthorized: Valid authentication credentials or Bearer token required.',
    });
  }
  next();
}

export function requirePermission(permissionKey: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.userRole) {
      return res.status(401).json({
        error: 'Unauthorized: Authentication required to access this resource.',
      });
    }

    if (!hasPermission(req.userRole, permissionKey)) {
      return res.status(403).json({
        error: `Forbidden: User role "${req.userRole}" is not authorized for permission "${permissionKey}".`,
      });
    }

    next();
  };
}

export function requireRole(...allowedRoles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.userRole) {
      return res.status(401).json({
        error: 'Unauthorized: Authentication required to access this resource.',
      });
    }

    if (!allowedRoles.includes(req.userRole)) {
      return res.status(403).json({
        error: `Forbidden: Only roles [${allowedRoles.join(', ')}] are authorized to perform this operation.`,
      });
    }

    next();
  };
}

/** Maps an error to an HTTP status: HttpError carries its own; PostgreSQL errors are 500. */
function errorStatus(err: any): number {
  if (typeof err?.status === 'number') return err.status;
  if (typeof err?.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) return 500;
  return 400;
}

/** Actor for stock operations, taken from the verified token only. */
function stockActor(req: AuthenticatedRequest) {
  return {
    user_id: req.userId!,
    user_name: req.userName || 'Admin',
    role: req.userRole || 'ADMIN',
    device_id: (req.headers['x-device-id'] as string) || 'SERVER',
  };
}

apiRouter.use(authMiddleware);

// --- 1. HEALTH & METADATA ---
apiRouter.get('/health', async (req, res) => {
  const pgStatus = await checkPgConnection();
  res.json({
    status: 'online',
    system: 'GIGA CHEMIST POS API',
    app_mode: getAppMode(),
    timestamp: Date.now(),
    version: '1.0.0-pwa',
    database: {
      provider: 'PostgreSQL',
      connected: pgStatus.connected,
      mode: getAppMode(),
      cloud_ready: isSupabaseConfigured,
    },
  });
});

// --- 2. DEVICE REGISTRATION ---
apiRouter.post('/devices/register', async (req: Request, res: Response) => {
  try {
    const { device_id, name, device_type, app_version } = req.body;
    if (!device_id) {
      return res.status(400).json({ error: 'device_id is required' });
    }
    const device = await registerDevice({
      device_id,
      name,
      device_type,
      app_version,
    });
    res.json({
      status: 'registered',
      device,
      server_time: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to register device', details: err.message });
  }
});

// --- 3. AUTHENTICATION & CENTRALIZED USER MANAGEMENT ---
apiRouter.post('/auth/login', authRateLimiter, async (req: Request, res: Response) => {
  try {
    const { email, username, pin, password } = req.body;
    const identifier = email || username || pin || '';
    const secret = password || pin || '';

    if (!identifier || !secret) {
      return res.status(400).json({ error: 'Identifier (email/username/pin) and secret are required.' });
    }

    const authenticatedUser = await authenticateUser(identifier, secret);
    const token = createJwtToken({
      userId: authenticatedUser.id,
      role: authenticatedUser.role,
      email: authenticatedUser.email,
      name: authenticatedUser.name,
    });

    await recordAuditLog({
      user_id: authenticatedUser.id,
      user_name: authenticatedUser.name,
      role: authenticatedUser.role,
      action: 'SERVER_AUTH_LOGIN',
      entity: 'auth',
      entity_id: authenticatedUser.id,
      device_id: (req.headers['x-device-id'] as string) || 'REMOTE-CLIENT',
      new_value: JSON.stringify({ email: authenticatedUser.email, role: authenticatedUser.role }),
    });

    res.json({
      success: true,
      user: authenticatedUser,
      token,
      permissions: ROLE_PERMISSIONS[authenticatedUser.role],
    });
  } catch (err: any) {
    res.status(401).json({ error: err.message || 'Authentication failed.' });
  }
});

apiRouter.get('/users', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const users = await getAllUsers();
    res.json(users);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve users directory.' });
  }
});

apiRouter.post('/users', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, email, role, password, pin, phone, active } = req.body;
    if (!name || !email || !role) {
      return res.status(400).json({ error: 'Name, email, and role are required.' });
    }

    const created = await createUser({
      name,
      email,
      role,
      password,
      pin,
      phone,
      active,
      created_by: req.userId,
    });

    await recordAuditLog({
      user_id: req.userId || 'admin',
      user_name: req.userName || 'Admin',
      role: req.userRole || 'ADMIN',
      action: 'USER_CREATED',
      entity: 'user',
      entity_id: created.id,
      new_value: JSON.stringify({ name: created.name, role: created.role, email: created.email }),
    });

    res.status(201).json({ success: true, user: created });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to create user.' });
  }
});

apiRouter.put('/users/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const updated = await updateUser(id, updates, req.userId);

    await recordAuditLog({
      user_id: req.userId || 'admin',
      user_name: req.userName || 'Admin',
      role: req.userRole || 'ADMIN',
      action: 'USER_UPDATED',
      entity: 'user',
      entity_id: id,
      new_value: JSON.stringify(updates),
    });

    res.json({ success: true, user: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to update user.' });
  }
});

apiRouter.patch('/users/:id/role', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    if (!role || !['ADMIN', 'MANAGER', 'CASHIER'].includes(role)) {
      return res.status(400).json({ error: 'Valid role (ADMIN, MANAGER, CASHIER) is required.' });
    }

    const updated = await updateUser(id, { role }, req.userId);

    await recordAuditLog({
      user_id: req.userId || 'admin',
      user_name: req.userName || 'Admin',
      role: req.userRole || 'ADMIN',
      action: 'USER_ROLE_CHANGED',
      entity: 'user',
      entity_id: id,
      new_value: JSON.stringify({ role: updated.role }),
    });

    res.json({ success: true, user: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to change user role.' });
  }
});

apiRouter.patch('/users/:id/status', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { active } = req.body;
    if (active === undefined) {
      return res.status(400).json({ error: 'active boolean status required.' });
    }

    if (id === req.userId && active === false) {
      return res.status(400).json({ error: 'Cannot deactivate your own logged-in administrator account.' });
    }

    const updated = await toggleUserStatus(id, Boolean(active), req.userId);

    await recordAuditLog({
      user_id: req.userId || 'admin',
      user_name: req.userName || 'Admin',
      role: req.userRole || 'ADMIN',
      action: active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
      entity: 'user',
      entity_id: id,
      new_value: JSON.stringify({ active: updated.active }),
    });

    res.json({ success: true, user: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to toggle user status.' });
  }
});

// Admin Reset Another User's Password (ADMIN ONLY)
apiRouter.post('/users/:id/reset-password', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { new_password, admin_password } = req.body;

    if (!new_password) {
      return res.status(400).json({ error: 'new_password is required.' });
    }

    const result = await adminResetUserPassword({
      targetUserId: id,
      newPassword: new_password,
      adminUserId: req.userId,
      adminPassword: admin_password,
    });

    await recordAuditLog({
      user_id: req.userId || 'admin',
      user_name: req.userName || 'Admin',
      role: req.userRole || 'ADMIN',
      action: 'USER_PASSWORD_RESET',
      entity: 'user',
      entity_id: id,
      new_value: JSON.stringify({ reset_by: req.userName }),
    });

    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to reset user password.' });
  }
});

// Change Own Password (Any authenticated Cashier / Admin)
apiRouter.post('/users/change-password', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { current_password, new_password, confirm_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password are required.' });
    }

    if (confirm_password && new_password !== confirm_password) {
      return res.status(400).json({ error: 'New password and confirmation do not match.' });
    }

    const result = await changeUserPassword({
      userId: req.userId!,
      currentPassword: current_password,
      newPassword: new_password,
    });

    await recordAuditLog({
      user_id: req.userId || 'user',
      user_name: req.userName || 'User',
      role: req.userRole || 'CASHIER',
      action: req.userRole === 'ADMIN' ? 'ADMIN_PASSWORD_CHANGED' : 'USER_PASSWORD_CHANGED',
      entity: 'user',
      entity_id: req.userId || 'self',
      new_value: JSON.stringify({ action: 'Self password change' }),
    });

    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to change password.' });
  }
});

// --- 4. MEDICINES & FORMULARY (WITH CASHIER COST-DATA SHAPING) ---
apiRouter.get('/medicines', requirePermission('medicine.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const medicines = await getAllMedicines();
    if (req.userRole === 'CASHIER') {
      // Protect financial cost data from Cashier role
      const sanitized = medicines.map((m) => ({
        ...m,
        purchase_price: 0,
        wholesale_price: 0,
      }));
      return res.json(sanitized);
    }
    res.json(medicines);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch medicines formulary.' });
  }
});

apiRouter.post('/medicines', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const medData: Medicine = req.body;
    if (!medData.name || !medData.selling_price) {
      return res.status(400).json({ error: 'Medicine name and selling price are required.' });
    }

    const saved = await upsertMedicine(medData);
    await recordAuditLog({
      user_id: req.userId || 'admin',
      user_name: req.userName || 'Admin',
      role: req.userRole || 'ADMIN',
      action: 'CREATE_MEDICINE',
      entity: 'medicine',
      entity_id: saved.id,
      new_value: JSON.stringify(saved),
    });

    res.status(201).json({ success: true, medicine: saved });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to create medicine.' });
  }
});

apiRouter.put('/medicines/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updates: Partial<Medicine> = req.body;

    const saved = await upsertMedicine({ ...updates, id, name: updates.name || 'Unnamed' });
    await recordAuditLog({
      user_id: req.userId || 'admin',
      user_name: req.userName || 'Admin',
      role: req.userRole || 'ADMIN',
      action: 'UPDATE_MEDICINE',
      entity: 'medicine',
      entity_id: id,
      new_value: JSON.stringify(updates),
    });

    res.json({ success: true, medicine: saved });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to update medicine.' });
  }
});

// Admin Update Medicine Pricing (ADMIN ONLY)
apiRouter.patch('/medicines/:id/pricing', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { selling_price, purchase_price, min_selling_price, wholesale_price, reorder_level } = req.body;

    if (
      selling_price === undefined &&
      purchase_price === undefined &&
      min_selling_price === undefined &&
      wholesale_price === undefined &&
      reorder_level === undefined
    ) {
      return res.status(400).json({ error: 'At least one pricing field (selling_price, purchase_price, reorder_level) must be provided.' });
    }

    const saved = await adminUpdateMedicinePricing({
      id,
      selling_price: selling_price !== undefined ? Number(selling_price) : undefined,
      purchase_price: purchase_price !== undefined ? Number(purchase_price) : undefined,
      min_selling_price: min_selling_price !== undefined ? Number(min_selling_price) : undefined,
      wholesale_price: wholesale_price !== undefined ? Number(wholesale_price) : undefined,
      reorder_level: reorder_level !== undefined ? Number(reorder_level) : undefined,
      user_id: req.userId || 'admin',
      user_name: req.userName || 'Admin',
      role: req.userRole || 'ADMIN',
      device_id: (req.headers['x-device-id'] as string) || 'SERVER',
    });

    res.json({ success: true, medicine: saved });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to update pricing.' });
  }
});

apiRouter.patch('/medicines/:id/price', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { selling_price, purchase_price, min_selling_price, wholesale_price, reorder_level } = req.body;

    const saved = await adminUpdateMedicinePricing({
      id,
      selling_price: selling_price !== undefined ? Number(selling_price) : undefined,
      purchase_price: purchase_price !== undefined ? Number(purchase_price) : undefined,
      min_selling_price: min_selling_price !== undefined ? Number(min_selling_price) : undefined,
      wholesale_price: wholesale_price !== undefined ? Number(wholesale_price) : undefined,
      reorder_level: reorder_level !== undefined ? Number(reorder_level) : undefined,
      user_id: req.userId || 'admin',
      user_name: req.userName || 'Admin',
      role: req.userRole || 'ADMIN',
      device_id: (req.headers['x-device-id'] as string) || 'SERVER',
    });

    res.json({ success: true, medicine: saved });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to update price.' });
  }
});

// Medicine categories (formulary metadata; same access as the medicine list)
apiRouter.get('/categories', requirePermission('medicine.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const categories = await getAllCategories();
    res.json(categories);
  } catch (err: any) {
    console.error('[API] /categories failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch categories.' });
  }
});

// --- 5. BATCHES ---
apiRouter.get('/batches', requirePermission('medicine.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const batches = await getAllBatches();
    if (req.userRole === 'CASHIER') {
      const sanitized = batches.map((b) => ({
        ...b,
        purchase_price: 0,
      }));
      return res.json(sanitized);
    }
    res.json(batches);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch batches.' });
  }
});

apiRouter.post('/batches', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const batchData: MedicineBatch = req.body;
    if (!batchData.medicine_id || !batchData.batch_number) {
      return res.status(400).json({ error: 'Medicine ID and batch number are required.' });
    }

    const saved = await upsertBatch(batchData);
    await recordAuditLog({
      user_id: req.userId || 'admin',
      user_name: req.userName || 'Admin',
      role: req.userRole || 'ADMIN',
      action: 'CREATE_BATCH',
      entity: 'medicine_batch',
      entity_id: saved.id,
      new_value: JSON.stringify(saved),
    });

    res.json({ success: true, batch: saved });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to create batch.' });
  }
});

// --- 6. INVENTORY MOVEMENTS & STOCK ADJUSTMENTS ---
apiRouter.get('/inventory/movements', requirePermission('inventory.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const movements = await getAllMovements();
    res.json(movements);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch inventory movements.' });
  }
});

apiRouter.post('/inventory/adjust', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { medicine_id, medicine_name, batch_id, batch_number, adjustment_quantity, reason, notes } = req.body;
    if (!medicine_id || !batch_id || adjustment_quantity === undefined) {
      return res.status(400).json({ error: 'medicine_id, batch_id, and adjustment_quantity are required.' });
    }
    requireUuid(medicine_id, 'medicine_id');
    requireUuid(batch_id, 'batch_id');

    const movement = await recordInventoryMovement({
      id: crypto.randomUUID(),
      medicine_id,
      medicine_name: medicine_name || 'Item',
      batch_id,
      batch_number: batch_number || 'Batch',
      previous_quantity: 0,
      adjustment_quantity: Number(adjustment_quantity),
      new_quantity: Number(adjustment_quantity),
      reason: (reason as any) || 'stock_adjustment',
      notes,
      user_id: req.userId!,
      user_name: req.userName || 'Admin',
      device_id: (req.headers['x-device-id'] as string) || 'SERVER',
      date: new Date().toLocaleDateString('en-CA'),
      timestamp: Date.now(),
    });

    await recordAuditLog({
      user_id: req.userId!,
      user_name: req.userName || 'Admin',
      role: req.userRole || 'ADMIN',
      action: 'INVENTORY_ADJUSTMENT',
      entity: 'inventory_movement',
      entity_id: movement.id,
      new_value: JSON.stringify({ adjustment_quantity, reason, notes }),
    });

    res.json({ success: true, movement });
  } catch (err: any) {
    console.error('[API] /inventory/adjust failed:', err.message);
    res.status(errorStatus(err)).json({ error: err.message || 'Failed to adjust stock.' });
  }
});

// Admin Set Stock (exact quantity; the Admin-entered number is authoritative)
apiRouter.post('/inventory/set-stock', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { medicine_id, batch_id, new_stock, reason, notes } = req.body;
    if (!medicine_id || new_stock === undefined || new_stock === null || new_stock === '') {
      return res.status(400).json({ error: 'medicine_id and new_stock are required.' });
    }
    const result = await adminSetStock({ ...stockActor(req), medicine_id, batch_id, new_stock: Number(new_stock), reason, notes });
    res.json(result);
  } catch (err: any) {
    console.error('[API] /inventory/set-stock failed:', err.message);
    res.status(errorStatus(err)).json({ error: err.message || 'Failed to set stock level.' });
  }
});

// Admin Add Stock
apiRouter.post('/inventory/add-stock', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { medicine_id, quantity, batch_number, expiry_date, supplier_id, purchase_price, selling_price_override, notes } = req.body;
    if (!medicine_id || !quantity || !batch_number) {
      return res.status(400).json({ error: 'medicine_id, quantity, and batch_number are required.' });
    }
    const result = await adminAddStock({
      ...stockActor(req),
      medicine_id,
      quantity: Number(quantity),
      batch_number,
      expiry_date,
      supplier_id,
      purchase_price: purchase_price !== undefined && purchase_price !== null ? Number(purchase_price) : undefined,
      selling_price_override: selling_price_override !== undefined && selling_price_override !== null ? Number(selling_price_override) : undefined,
      notes,
    });
    res.json(result);
  } catch (err: any) {
    console.error('[API] /inventory/add-stock failed:', err.message);
    res.status(errorStatus(err)).json({ error: err.message || 'Failed to add stock.' });
  }
});

// Admin Remove Stock
apiRouter.post('/inventory/remove-stock', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { medicine_id, batch_id, quantity, reason, notes } = req.body;
    if (!medicine_id || !batch_id || !quantity) {
      return res.status(400).json({ error: 'medicine_id, batch_id, and quantity are required.' });
    }
    const result = await adminRemoveStock({ ...stockActor(req), medicine_id, batch_id, quantity: Number(quantity), reason: reason || 'DAMAGE', notes });
    res.json(result);
  } catch (err: any) {
    console.error('[API] /inventory/remove-stock failed:', err.message);
    res.status(errorStatus(err)).json({ error: err.message || 'Failed to remove stock.' });
  }
});

// Admin Edit Batch Expiry Date (null/empty = UNKNOWN expiry)
apiRouter.patch('/batches/:id/expiry', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await adminEditBatchExpiry({
      ...stockActor(req),
      batch_id: req.params.id,
      expiry_date: req.body?.expiry_date ?? null,
    });
    res.json(result);
  } catch (err: any) {
    console.error('[API] /batches/:id/expiry failed:', err.message);
    res.status(errorStatus(err)).json({ error: err.message || 'Failed to update batch expiry.' });
  }
});

// Admin Direct Physical Stock Count (ADMIN ONLY, applied immediately)
apiRouter.post('/inventory/physical-count', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { medicine_id, counts, notes } = req.body;
    if (!medicine_id || !Array.isArray(counts) || counts.length === 0) {
      return res.status(400).json({ error: 'medicine_id and at least one batch count in counts array are required.' });
    }
    const result = await adminPhysicalStockCount({ ...stockActor(req), medicine_id, counts, notes });
    res.json(result);
  } catch (err: any) {
    console.error('[API] /inventory/physical-count failed:', err.message);
    res.status(errorStatus(err)).json({ error: err.message || 'Failed to apply physical stock count.' });
  }
});

// --- 7. SALES & ATOMIC TRANSACTION CHECKOUT ---
// Today's Sales Summary (Server-side calculated with Cashier isolation)
apiRouter.get('/sales/today-summary', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Strict isolation: CASHIER can only ever fetch their own daily sales summary
    const cashierId = req.userRole === 'CASHIER' ? req.userId : (req.query.cashierId as string | undefined);
    const summary = await getTodaySalesSummary({ cashierId, role: req.userRole });
    res.json(summary);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to calculate today sales summary.', details: err.message });
  }
});

apiRouter.get('/sales', requirePermission('sales.view_own'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const search = req.query.search as string | undefined;
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;
    const cashierId = req.userRole === 'CASHIER' ? req.userId : (req.query.cashierId as string | undefined);

    const result = await getAllSales({ page, limit, search, startDate, endDate, cashierId });

    if (req.userRole === 'CASHIER') {
      if (Array.isArray(result)) {
        const sanitized = result.map((s) => ({
          ...s,
          cost_total: 0,
          gross_profit: 0,
          items: s.items?.map((item) => ({ ...item, cost_price_snapshot: 0 })),
        }));
        return res.json(sanitized);
      } else {
        const sanitized = {
          ...result,
          sales: result.sales.map((s) => ({
            ...s,
            cost_total: 0,
            gross_profit: 0,
            items: s.items?.map((item) => ({ ...item, cost_price_snapshot: 0 })),
          })),
        };
        return res.json(sanitized);
      }
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch sales history.' });
  }
});

apiRouter.post('/sales/checkout', requirePermission('sales.create'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const saleData: Sale = req.body;
    if (!saleData.receipt_number || !Array.isArray(saleData.items) || saleData.items.length === 0) {
      return res.status(400).json({ error: 'Invalid sale payload structure.' });
    }

    const result = await processSaleCheckout(
      {
        ...saleData,
        cashier_id: req.userId || saleData.cashier_id,
        cashier_name: req.userName || saleData.cashier_name,
      },
      {
        userRole: req.userRole,
        userId: req.userId,
      }
    );

    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to process sale checkout.' });
  }
});

apiRouter.post('/sales/:id/void', requirePermission('sales.void'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { void_reason } = req.body;

    const result = await processSaleCheckout({
      id,
      receipt_number: req.body.receipt_number || id,
      sale_number: req.body.sale_number || id,
      status: 'voided',
      void_reason: void_reason || 'Administrative void',
      voided_by: req.userId,
      items: [],
      total: 0,
      subtotal: 0,
      amount_received: 0,
      cost_total: 0,
      gross_profit: 0,
      payment_method: 'Cash',
      date: new Date().toISOString().split('T')[0],
      time: new Date().toLocaleTimeString(),
    } as any);

    await recordAuditLog({
      user_id: req.userId || 'admin',
      user_name: req.userName || 'Admin',
      role: 'ADMIN',
      action: 'SALE_VOIDED',
      entity: 'sale',
      entity_id: id,
      new_value: JSON.stringify({ void_reason }),
    });

    res.json({ success: true, result });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to void sale.' });
  }
});

// --- 8. SYNCHRONIZATION ENGINE ENDPOINT (/api/sync) ---
apiRouter.post('/sync', requirePermission('sales.create'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const payload: SyncPayload = req.body;
    const syncedSaleIds: string[] = [];
    const syncedMovementIds: string[] = [];
    const syncedReturnIds: string[] = [];
    const syncedExpenseIds: string[] = [];

    // 1. Process pending offline sales with idempotency
    if (Array.isArray(payload.sales)) {
      for (const sale of payload.sales) {
        const result = await processSaleCheckout(sale);
        if (result.success) {
          syncedSaleIds.push(sale.id);
        }
      }
    }

    // 2. Process customer returns
    if (Array.isArray(payload.returns)) {
      for (const ret of payload.returns) {
        await processCustomerReturn(ret);
        syncedReturnIds.push(ret.id);
      }
    }

    // 3. Process expenses
    if (Array.isArray(payload.expenses)) {
      for (const exp of payload.expenses) {
        await recordExpense(exp);
        syncedExpenseIds.push(exp.id);
      }
    }

    // Fetch latest authoritative master catalogs
    const [medicines, batches, settings] = await Promise.all([
      getAllMedicines(),
      getAllBatches(),
      getPharmacySettings(),
    ]);

    const sanitizedMedicines = req.userRole === 'CASHIER'
      ? medicines.map((m) => ({ ...m, purchase_price: 0, wholesale_price: 0 }))
      : medicines;

    const syncResponse: SyncResponse = {
      success: true,
      synced_sale_ids: syncedSaleIds,
      synced_movement_ids: syncedMovementIds,
      synced_return_ids: syncedReturnIds,
      synced_expense_ids: syncedExpenseIds,
      authoritative_medicines: sanitizedMedicines,
      authoritative_batches: batches,
      authoritative_settings: settings,
      server_timestamp: Date.now(),
    };

    res.json(syncResponse);
  } catch (err: any) {
    res.status(500).json({ error: 'Sync processing error', details: err.message });
  }
});

// --- 9. CUSTOMERS ---
apiRouter.get('/customers', requirePermission('sales.view_own'), async (req, res) => {
  try {
    const customers = await getAllCustomers();
    res.json(customers);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch customers.' });
  }
});

apiRouter.post('/customers', requirePermission('sales.create'), async (req, res) => {
  try {
    const saved = await upsertCustomer(req.body);
    res.json({ success: true, customer: saved });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to save customer.' });
  }
});

// --- 10. SUPPLIERS ---
apiRouter.get('/suppliers', requirePermission('suppliers.manage'), async (req, res) => {
  try {
    const suppliers = await getAllSuppliers();
    res.json(suppliers);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch suppliers.' });
  }
});

apiRouter.post('/suppliers', requirePermission('suppliers.manage'), async (req, res) => {
  try {
    const saved = await upsertSupplier(req.body);
    res.json({ success: true, supplier: saved });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to save supplier.' });
  }
});

// --- 11. PURCHASES ---
apiRouter.get('/purchases', requirePermission('stock.receive'), async (req, res) => {
  try {
    const purchases = await getAllPurchases();
    res.json(purchases);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch purchases.' });
  }
});

apiRouter.post('/purchases/receive', requirePermission('stock.receive'), async (req, res) => {
  try {
    const saved = await receivePurchaseOrder(req.body);
    res.json({ success: true, purchase: saved });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to receive purchase.' });
  }
});

// --- 12. RETURNS ---
apiRouter.get('/returns', requirePermission('returns.create'), async (req, res) => {
  try {
    const returns = await getAllReturns();
    res.json(returns);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch returns.' });
  }
});

apiRouter.post('/returns', requirePermission('returns.create'), async (req, res) => {
  try {
    const saved = await processCustomerReturn(req.body);
    res.json({ success: true, return: saved });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to process return.' });
  }
});

// --- 13. EXPENSES ---
apiRouter.get('/expenses', requirePermission('expenses.manage'), async (req, res) => {
  try {
    const expenses = await getAllExpenses();
    res.json(expenses);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch expenses.' });
  }
});

apiRouter.post('/expenses', requirePermission('expenses.manage'), async (req, res) => {
  try {
    const saved = await recordExpense(req.body);
    res.json({ success: true, expense: saved });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to record expense.' });
  }
});

// --- 14. AUDIT LOGS ---
apiRouter.get('/audit', requireRole('ADMIN'), async (req, res) => {
  try {
    const logs = await getAllAuditLogs();
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch audit logs.' });
  }
});

// --- 15. SETTINGS ---
apiRouter.get('/settings', async (req, res) => {
  try {
    const settings = await getPharmacySettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings.' });
  }
});

apiRouter.put('/settings', requireRole('ADMIN'), async (req, res) => {
  try {
    const saved = await updatePharmacySettings(req.body);
    res.json({ success: true, settings: saved });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to update settings.' });
  }
});

// Unknown /api paths return JSON 404 instead of falling through to the SPA index.html fallback.
apiRouter.use((req: Request, res: Response) => {
  res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
});
