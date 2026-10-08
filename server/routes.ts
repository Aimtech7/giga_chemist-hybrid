import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import {
  getAllCategories,
  getAllMedicines,
  createMedicine,
  updateMedicineDetails,
  adminUpdateMedicinePricing,
  getAllBatches,
  getAllMovements,
  adminSetStock,
  adminAddStock,
  adminRemoveStock,
  adminEditBatchExpiry,
  adminPhysicalStockCount,
  getAllSales,
  checkoutSale,
  voidSale,
  getTodaySalesSummary,
  getAllCustomers,
  upsertCustomer,
  getAllSuppliers,
  upsertSupplier,
  getAllPurchases,
  receivePurchaseOrder,
  getAllReturns,
  requestReturn,
  approveReturn,
  rejectReturn,
  getAllExpenses,
  recordExpense,
  getAllAuditLogs,
  recordAuditLog,
  getPharmacySettings,
  updatePharmacySettings,
  getAllUsers,
  getUserById,
  getActiveUserForSession,
  createUser,
  updateUser,
  toggleUserStatus,
  changeUserPassword,
  adminResetUserPassword,
  authenticateUser,
  registerDevice,
  normalizeDeviceId,
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
import { getSyncStatus, syncWorker } from './sync/worker';
import { resolveRange, getSalesReport } from './db/reports';
import {
  getEmailSettings, updateEmailSettings, enqueueTestEmail, enqueueReport, getEmailStatus, listEmailJobs,
  requeueFailedEmails, businessDate,
} from './email/service';
import { runBackup, getBackupStatus } from './ops/backup';
import { getSystemHealth } from './ops/health';
import { appVersion, currentCommit } from './ops/runtime';
import { pgPool } from './db/client';
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
  // Login attempts per IP per minute (default 20). Overridable for the isolated integration-test server.
  const maxAttempts = Number(process.env.AUTH_RATE_LIMIT_PER_MINUTE) > 0 ? Number(process.env.AUTH_RATE_LIMIT_PER_MINUTE) : 20;

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

  // Authorization comes only from a verified token. x-user-* headers are never trusted.
  req.userRole = undefined;
  req.userId = undefined;
  req.userName = undefined;
  if (!token) return next();

  const { valid, payload } = verifyJwtToken(token);
  if (!valid || !payload) return next();

  // Re-read the account on every request: a deactivated user or changed role takes effect
  // immediately instead of when the 12-hour token expires.
  getActiveUserForSession(payload.userId)
    .then((user) => {
      if (user) {
        req.tokenPayload = payload;
        req.userId = user.id;
        req.userRole = user.role;
        req.userName = user.name;
        req.userEmail = user.email;
      }
      next();
    })
    .catch((err) => {
      console.error('[API] Session lookup failed:', err.message);
      res.status(503).json({ error: 'Database unavailable: cannot verify the session.' });
    });
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
    // Public, non-secret identity of the running code + worker state (used by the updater's health gate).
    app_version: appVersion(),
    commit: currentCommit(),
    sync_worker: { enabled: syncWorker.status().running, leader: syncWorker.status().leader },
    database: {
      provider: 'PostgreSQL',
      connected: pgStatus.connected,
      mode: getAppMode(),
      cloud_ready: isSupabaseConfigured,
    },
  });
});

// --- 2. DEVICE REGISTRATION ---
apiRouter.post('/devices/register', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { device_id, name, device_type, app_version } = req.body || {};
    const device = await registerDevice({ device_id, name, device_type, app_version, user_id: req.userId });
    res.json({ status: 'registered', device, server_time: new Date().toISOString() });
  } catch (err: any) {
    console.error('[API] /devices/register failed:', err.message);
    res.status(errorStatus(err)).json({ error: err.message || 'Failed to register device.' });
  }
});

// --- 3. AUTHENTICATION & CENTRALIZED USER MANAGEMENT ---
apiRouter.post('/auth/login', authRateLimiter, async (req: Request, res: Response) => {
  try {
    const { email, username, password, pin } = req.body || {};
    const identifier = String(email || username || '').trim();
    const secret = String(password || pin || '').trim();
    if (!identifier || !secret) {
      return res.status(400).json({ error: 'Email and password (or PIN) are required.' });
    }

    const user = await authenticateUser(identifier, secret);
    const token = createJwtToken({ userId: user.id, role: user.role, email: user.email, name: user.name });

    await recordAuditLog({
      user_id: user.id,
      user_name: user.name,
      role: user.role,
      action: 'SERVER_AUTH_LOGIN',
      entity: 'auth',
      entity_id: user.id,
      device_id: normalizeDeviceId(req.headers['x-device-id']) || 'SERVER',
      new_value: { email: user.email, role: user.role },
    });

    res.json({ success: true, user, token, permissions: ROLE_PERMISSIONS[user.role] });
  } catch (err: any) {
    const status = errorStatus(err);
    if (status >= 500) console.error('[API] /auth/login failed:', err.message);
    res.status(status === 400 && !err.status ? 401 : status).json({ error: err.message || 'Authentication failed.' });
  }
});

// Validates the caller's token against the database and returns the current account.
apiRouter.get('/auth/me', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const user = await getUserById(req.userId!).catch(() => null);
  res.json({
    user: user || { id: req.userId, name: req.userName, email: req.userEmail, role: req.userRole },
    permissions: ROLE_PERMISSIONS[req.userRole!],
    token_expires_at: req.tokenPayload?.exp ? req.tokenPayload.exp * 1000 : undefined,
  });
});

function actorAudit(req: AuthenticatedRequest) {
  return {
    user_id: req.userId!,
    user_name: req.userName || 'Admin',
    role: req.userRole!,
    device_id: normalizeDeviceId(req.headers['x-device-id']) || 'SERVER',
  };
}

apiRouter.get('/users', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    res.json(await getAllUsers());
  } catch (err: any) {
    console.error('[API] GET /users failed:', err.message);
    res.status(500).json({ error: 'Failed to retrieve users directory.' });
  }
});

apiRouter.post('/users', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, email, username, role, password, pin, phone, active } = req.body || {};
    const created = await createUser({ name, email, username, role, password, pin, phone, active, created_by: req.userId });
    await recordAuditLog({
      ...actorAudit(req),
      action: 'USER_CREATED',
      entity: 'user',
      entity_id: created.id,
      new_value: { name: created.name, role: created.role, email: created.email, username: created.username, active: created.active },
    });
    res.status(201).json({ success: true, user: created });
  } catch (err: any) {
    res.status(errorStatus(err)).json({ error: err.message || 'Failed to create user.' });
  }
});

apiRouter.put('/users/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    // Credentials are never changed through this endpoint (see reset-password / change-password).
    const { name, email, username, role, phone, active } = req.body || {};
    const before = await getUserById(id);
    const updated = await updateUser(id, { name, email, username, role, phone, active }, req.userId);
    await recordAuditLog({
      ...actorAudit(req),
      action: 'USER_UPDATED',
      entity: 'user',
      entity_id: id,
      previous_value: before ? { name: before.name, email: before.email, username: before.username, role: before.role, active: before.active } : undefined,
      new_value: { name: updated.name, email: updated.email, username: updated.username, role: updated.role, active: updated.active },
    });
    res.json({ success: true, user: updated });
  } catch (err: any) {
    res.status(errorStatus(err)).json({ error: err.message || 'Failed to update user.' });
  }
});

apiRouter.patch('/users/:id/role', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const before = await getUserById(id);
    const updated = await updateUser(id, { role: req.body?.role }, req.userId);
    await recordAuditLog({
      ...actorAudit(req),
      action: 'USER_ROLE_CHANGED',
      entity: 'user',
      entity_id: id,
      previous_value: before ? { role: before.role } : undefined,
      new_value: { role: updated.role },
    });
    res.json({ success: true, user: updated });
  } catch (err: any) {
    res.status(errorStatus(err)).json({ error: err.message || 'Failed to change user role.' });
  }
});

apiRouter.patch('/users/:id/status', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { active } = req.body || {};
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'active must be true or false.' });
    }
    const updated = await toggleUserStatus(id, active, req.userId);
    await recordAuditLog({
      ...actorAudit(req),
      action: active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
      entity: 'user',
      entity_id: id,
      new_value: { active: updated.active },
    });
    res.json({ success: true, user: updated });
  } catch (err: any) {
    res.status(errorStatus(err)).json({ error: err.message || 'Failed to change user status.' });
  }
});

// Admin resets another user's password (and optionally PIN). ADMIN ONLY.
apiRouter.post('/users/:id/reset-password', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { new_password, new_pin, admin_password } = req.body || {};
    const result = await adminResetUserPassword({
      targetUserId: id,
      newPassword: new_password,
      newPin: new_pin,
      adminUserId: req.userId,
      adminPassword: admin_password,
    });
    await recordAuditLog({
      ...actorAudit(req),
      action: 'USER_PASSWORD_RESET',
      entity: 'user',
      entity_id: id,
      new_value: { reset_by: req.userName, pin_reset: Boolean(new_pin) },
    });
    res.json(result);
  } catch (err: any) {
    res.status(errorStatus(err)).json({ error: err.message || 'Failed to reset user password.' });
  }
});

// Any authenticated user changes their OWN password.
apiRouter.post('/users/change-password', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { current_password, new_password, confirm_password } = req.body || {};
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password are required.' });
    }
    if (confirm_password !== undefined && new_password !== confirm_password) {
      return res.status(400).json({ error: 'New password and confirmation do not match.' });
    }
    const result = await changeUserPassword({
      userId: req.userId!,
      currentPassword: current_password,
      newPassword: new_password,
    });
    await recordAuditLog({
      ...actorAudit(req),
      action: 'USER_PASSWORD_CHANGED',
      entity: 'user',
      entity_id: req.userId!,
      new_value: { action: 'Self password change' },
    });
    res.json(result);
  } catch (err: any) {
    res.status(errorStatus(err)).json({ error: err.message || 'Failed to change password.' });
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
    const saved = await createMedicine(req.body || {}, actorAudit(req));
    res.status(201).json({ success: true, medicine: saved });
  } catch (err: any) {
    console.error('[API] POST /medicines failed:', err.message);
    res.status(errorStatus(err)).json({ error: err.message || 'Failed to create medicine.' });
  }
});

apiRouter.put('/medicines/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const saved = await updateMedicineDetails(req.params.id, req.body || {}, actorAudit(req));
    res.json({ success: true, medicine: saved });
  } catch (err: any) {
    console.error('[API] PUT /medicines/:id failed:', err.message);
    res.status(errorStatus(err)).json({ error: err.message || 'Failed to update medicine.' });
  }
});

// Admin Update Medicine Pricing (ADMIN ONLY). Historical sale_items are never rewritten.
async function handlePricingUpdate(req: AuthenticatedRequest, res: Response) {
  try {
    const { selling_price, purchase_price, min_selling_price, wholesale_price, reorder_level } = req.body || {};
    const saved = await adminUpdateMedicinePricing({
      id: req.params.id,
      selling_price,
      purchase_price,
      min_selling_price,
      wholesale_price,
      reorder_level,
      ...actorAudit(req),
    });
    res.json({ success: true, medicine: saved });
  } catch (err: any) {
    console.error('[API] medicine pricing update failed:', err.message);
    res.status(errorStatus(err)).json({ error: err.message || 'Failed to update pricing.' });
  }
}
apiRouter.patch('/medicines/:id/pricing', requireRole('ADMIN'), handlePricingUpdate);
apiRouter.patch('/medicines/:id/price', requireRole('ADMIN'), handlePricingUpdate);

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

// --- 6. INVENTORY MOVEMENTS & STOCK ADJUSTMENTS ---
apiRouter.get('/inventory/movements', requirePermission('inventory.view'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const movements = await getAllMovements();
    res.json(movements);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch inventory movements.' });
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

// --- 7. SALES (server-authoritative checkout, explicit void, PostgreSQL daily summary) ---
function saleActor(req: AuthenticatedRequest) {
  return stockActor(req) as ReturnType<typeof stockActor> & { role: UserRole };
}

function sendError(res: Response, err: any, fallback: string, label: string) {
  const status = errorStatus(err);
  if (status >= 500) console.error(`[API] ${label} failed:`, err.message);
  res.status(status).json({ error: err.message || fallback, code: err.code, details: err.details });
}

// Today's totals. A CASHIER always gets only their own; an ADMIN gets all (or ?cashierId=<uuid>).
apiRouter.get('/sales/today-summary', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const cashierId = req.userRole === 'ADMIN' ? (req.query.cashierId as string | undefined) || undefined : req.userId;
    const summary = await getTodaySalesSummary({ cashierId });
    if (req.userRole !== 'ADMIN') delete summary.grossProfit;
    res.json(summary);
  } catch (err: any) {
    sendError(res, err, 'Failed to calculate today sales summary.', 'GET /sales/today-summary');
  }
});

apiRouter.get('/sales', requirePermission('sales.view_own'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await getAllSales({
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      search: req.query.search as string | undefined,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
      cashierId: req.userRole === 'CASHIER' ? req.userId : (req.query.cashierId as string | undefined),
      paymentMethod: (req.query.paymentMethod as string | undefined) || undefined,
      customerId: (req.query.customerId as string | undefined) || undefined,
      priceMode: (req.query.priceMode as string | undefined) || undefined,
      status: (req.query.status as string | undefined) || undefined,
    });
    if (req.userRole !== 'CASHIER') return res.json(result);
    // Cost and profit are hidden from Cashiers.
    const strip = (s: Sale) => ({
      ...s,
      cost_total: 0,
      gross_profit: 0,
      items: s.items?.map((item) => ({ ...item, cost_price_snapshot: 0 })),
    });
    res.json(Array.isArray(result) ? result.map(strip) : { ...result, sales: result.sales.map(strip) });
  } catch (err: any) {
    sendError(res, err, 'Failed to fetch sales history.', 'GET /sales');
  }
});

apiRouter.post('/sales/checkout', requirePermission('sales.create'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await checkoutSale(req.body || {}, saleActor(req));
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (err: any) {
    sendError(res, err, 'Failed to process sale checkout.', 'POST /sales/checkout');
  }
});

// Explicit, transactional reversal. ADMIN only. Never re-runs checkout; history is kept.
apiRouter.post('/sales/:id/void', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    res.json(await voidSale(req.params.id, req.body?.void_reason ?? req.body?.reason, saleActor(req)));
  } catch (err: any) {
    sendError(res, err, 'Failed to void sale.', 'POST /sales/:id/void');
  }
});

// --- 8. SYNCHRONIZATION ENDPOINT (/api/sync) ---
// In APP_MODE=local every write is completed online against PostgreSQL, so browser-queued
// (offline) sales/returns/expenses are refused rather than replayed with browser-made numbers.
apiRouter.post('/sync', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const payload: Partial<SyncPayload> = req.body || {};
    const queued =
      (payload.sales?.length || 0) + (payload.returns?.length || 0) + (payload.expenses?.length || 0);
    if (queued > 0) {
      return res.status(409).json({
        error: `Offline-queued writes are not accepted in local mode. ${queued} queued item(s) were NOT applied; ` +
          'complete them again while connected to the POS server.',
        code: 'OFFLINE_QUEUE_REJECTED',
      });
    }
    const [medicines, batches, settings] = await Promise.all([getAllMedicines(), getAllBatches(), getPharmacySettings()]);
    const syncResponse: SyncResponse = {
      success: true,
      synced_sale_ids: [],
      synced_movement_ids: [],
      synced_return_ids: [],
      synced_expense_ids: [],
      authoritative_medicines:
        req.userRole === 'CASHIER' ? medicines.map((m) => ({ ...m, purchase_price: 0 })) : medicines,
      authoritative_batches: batches,
      authoritative_settings: settings,
      server_timestamp: Date.now(),
    };
    res.json(syncResponse);
  } catch (err: any) {
    sendError(res, err, 'Sync processing error.', 'POST /sync');
  }
});

// --- 8b. HYBRID CLOUD SYNC STATUS (server outbox -> cloud) ---
// Internet/cloud connectivity is reported separately from local PostgreSQL availability.
// Admins get full details; Cashiers only a summary. No keys, tokens or URLs with credentials.
apiRouter.get('/sync/status', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [status, pg] = await Promise.all([getSyncStatus(), checkPgConnection()]);
    const local_database = { connected: pg.connected };
    if (req.userRole === 'ADMIN') return res.json({ ...status, local_database });
    res.json({
      mode: status.mode,
      enabled: status.enabled,
      local_database,
      cloud_reachable: (status as any).cloud_reachable ?? null,
      counts: status.counts ? { pending: status.counts.pending + status.counts.processing, failed: status.counts.failed } : null,
      last_sync: (status as any).last_sync ?? null,
    });
  } catch (err: any) {
    sendError(res, err, 'Failed to read sync status.', 'GET /sync/status');
  }
});

// ADMIN: wake the worker now. It still claims only due events and the cloud still dedupes.
apiRouter.post('/sync/now', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  const result = syncWorker.wake(true);
  if (result === 'disabled') {
    return res.status(409).json({ error: 'Cloud sync is not enabled on this server (APP_MODE=hybrid and SYNC_ENABLED=true are required).' });
  }
  res.json({ success: true, result });
});

// ADMIN: re-queue events the cloud rejected (after the cause was fixed). Idempotency keys are kept.
apiRouter.post('/sync/retry-failed', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const r = await pgPool.query(
      `UPDATE sync_events SET status = 'PENDING', next_attempt_at = CURRENT_TIMESTAMP WHERE status = 'FAILED' RETURNING id`
    );
    await recordAuditLog({
      ...actorAudit(req),
      action: 'SYNC_FAILED_EVENTS_REQUEUED',
      entity: 'sync',
      entity_id: 'sync_events',
      new_value: { requeued: r.rowCount || 0 },
    });
    syncWorker.wake(false);
    res.json({ success: true, requeued: r.rowCount || 0 });
  } catch (err: any) {
    sendError(res, err, 'Failed to re-queue failed events.', 'POST /sync/retry-failed');
  }
});

// --- 8c. SERVER-SIDE REPORTS (PostgreSQL aggregates; never the browser cache) ---
// ?range=today|week|month|custom&start=YYYY-MM-DD&end=YYYY-MM-DD[&cashierId=<uuid> (Admin)]
// Cashier: own sales only, no cost/profit/expenses/purchases.
apiRouter.get('/reports/summary', requirePermission('sales.view_own'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const isAdmin = req.userRole === 'ADMIN';
    const range = await resolveRange(req.query.range, req.query.start, req.query.end);
    const report = await getSalesReport(range, {
      cashierId: isAdmin ? ((req.query.cashierId as string) || null) : req.userId!,
      includeCost: isAdmin,
    });
    res.json(report);
  } catch (err: any) {
    sendError(res, err, 'Failed to build report.', 'GET /reports/summary');
  }
});

// --- 8d. EMAIL REPORTS (ADMIN). SMTP credentials are never returned. ---
apiRouter.get('/email/settings', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [settings, status] = await Promise.all([getEmailSettings(), getEmailStatus()]);
    res.json({ settings, status });
  } catch (err: any) {
    sendError(res, err, 'Failed to read email settings.', 'GET /email/settings');
  }
});

apiRouter.put('/email/settings', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    res.json({ success: true, settings: await updateEmailSettings(req.body || {}, actorAudit(req)) });
  } catch (err: any) {
    sendError(res, err, 'Failed to save email settings.', 'PUT /email/settings');
  }
});

apiRouter.post('/email/test', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const recipients = req.body?.recipients ? String(req.body.recipients).split(/[,;\s]+/).filter(Boolean) : undefined;
    const job = await enqueueTestEmail(recipients, req.userName || 'Admin');
    await recordAuditLog({ ...actorAudit(req), action: 'EMAIL_TEST_QUEUED', entity: 'email_job', entity_id: job.id, new_value: { recipients: recipients || 'default' } });
    res.status(202).json({ success: true, job });
  } catch (err: any) {
    sendError(res, err, 'Failed to queue test email.', 'POST /email/test');
  }
});

// Generates today's report of that type now (same idempotency key as the schedule: never a duplicate).
apiRouter.post('/email/reports/:type/run', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const types = ['DAILY_STOCK', 'DAILY_BUSINESS', 'WEEKLY_EXPIRY', 'LOW_STOCK_DIGEST'] as const;
    const type = String(req.params.type || '').toUpperCase() as (typeof types)[number];
    if (!types.includes(type)) return res.status(400).json({ error: `type must be one of ${types.join(', ')}.` });
    const { date } = await businessDate();
    const job = await enqueueReport(type, date, { createdBy: req.userName || 'Admin' });
    res.status(job.created ? 202 : 200).json({ success: true, job });
  } catch (err: any) {
    sendError(res, err, 'Failed to queue report.', 'POST /email/reports/:type/run');
  }
});

apiRouter.get('/email/jobs', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    res.json(await listEmailJobs(Number(req.query.limit) || 50));
  } catch (err: any) {
    sendError(res, err, 'Failed to list email jobs.', 'GET /email/jobs');
  }
});

apiRouter.post('/email/retry-failed', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const n = await requeueFailedEmails();
    await recordAuditLog({ ...actorAudit(req), action: 'EMAIL_FAILED_REQUEUED', entity: 'email_job', entity_id: 'email_jobs', new_value: { requeued: n } });
    res.json({ success: true, requeued: n });
  } catch (err: any) {
    sendError(res, err, 'Failed to re-queue emails.', 'POST /email/retry-failed');
  }
});

// --- 8e. BACKUPS (ADMIN). There is deliberately NO restore endpoint. ---
apiRouter.get('/backups/status', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    res.json(await getBackupStatus());
  } catch (err: any) {
    sendError(res, err, 'Failed to read backup status.', 'GET /backups/status');
  }
});

apiRouter.post('/backups/run', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const r = await runBackup('MANUAL');
    await recordAuditLog({ ...actorAudit(req), action: r.success ? 'BACKUP_CREATED' : 'BACKUP_FAILED', entity: 'backup', entity_id: r.id || 'none', new_value: r.success ? { size_bytes: r.size_bytes, duration_ms: r.duration_ms } : { error: r.error } });
    if (!r.success) return res.status(500).json({ success: false, error: r.error });
    res.json({ success: true, file: r.file.split(/[\\/]/).pop(), size_bytes: r.size_bytes, duration_ms: r.duration_ms, pruned: r.pruned.length });
  } catch (err: any) {
    sendError(res, err, 'Backup failed.', 'POST /backups/run');
  }
});

// --- 8f. SYSTEM HEALTH (ADMIN) ---
apiRouter.get('/admin/health', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    res.json(await getSystemHealth());
  } catch (err: any) {
    sendError(res, err, 'Failed to read system health.', 'GET /admin/health');
  }
});

// --- 9. CUSTOMERS ---
apiRouter.get('/customers', requirePermission('sales.view_own'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    res.json(await getAllCustomers());
  } catch (err: any) {
    sendError(res, err, 'Failed to fetch customers.', 'GET /customers');
  }
});

apiRouter.post('/customers', requirePermission('sales.create'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    res.json({ success: true, customer: await upsertCustomer(req.body || {}, saleActor(req)) });
  } catch (err: any) {
    sendError(res, err, 'Failed to save customer.', 'POST /customers');
  }
});

// --- 10. SUPPLIERS (ADMIN) ---
apiRouter.get('/suppliers', requirePermission('suppliers.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    res.json(await getAllSuppliers());
  } catch (err: any) {
    sendError(res, err, 'Failed to fetch suppliers.', 'GET /suppliers');
  }
});

apiRouter.post('/suppliers', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    res.json({ success: true, supplier: await upsertSupplier(req.body || {}, saleActor(req)) });
  } catch (err: any) {
    sendError(res, err, 'Failed to save supplier.', 'POST /suppliers');
  }
});

// --- 11. PURCHASES (ADMIN) ---
apiRouter.get('/purchases', requirePermission('stock.receive'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    res.json(await getAllPurchases());
  } catch (err: any) {
    sendError(res, err, 'Failed to fetch purchases.', 'GET /purchases');
  }
});

async function handleReceivePurchase(req: AuthenticatedRequest, res: Response) {
  try {
    res.status(201).json(await receivePurchaseOrder(req.body || {}, saleActor(req)));
  } catch (err: any) {
    sendError(res, err, 'Failed to receive purchase.', 'POST /purchases');
  }
}
apiRouter.post('/purchases', requireRole('ADMIN'), handleReceivePurchase);
apiRouter.post('/purchases/receive', requireRole('ADMIN'), handleReceivePurchase);

// --- 12. RETURNS (Cashier/Admin request -> Admin approve/reject) ---
// Cashiers see only their own requests. ?status=PENDING|APPROVED|REJECTED filters.
apiRouter.get('/returns', requirePermission('returns.create'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status.toUpperCase() : undefined;
    res.json(await getAllReturns({ userId: req.userRole === 'CASHIER' ? req.userId : undefined, status }));
  } catch (err: any) {
    sendError(res, err, 'Failed to fetch returns.', 'GET /returns');
  }
});

// Creates a PENDING request only: no stock, refund, movement or reporting effect.
apiRouter.post('/returns', requirePermission('returns.create'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sale_id, medicine_id, batch_id, quantity, reason } = req.body || {};
    res.status(201).json(await requestReturn({ sale_id, medicine_id, batch_id, quantity, reason }, saleActor(req)));
  } catch (err: any) {
    sendError(res, err, 'Failed to submit return request.', 'POST /returns');
  }
});

// ADMIN ONLY: the single place where return effects (refund, restock, movement) are applied.
apiRouter.post('/returns/:id/approve', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { restock, disposition, notes } = req.body || {};
    res.json(await approveReturn(req.params.id, { restock, disposition, notes }, saleActor(req)));
  } catch (err: any) {
    sendError(res, err, 'Failed to approve return.', 'POST /returns/:id/approve');
  }
});

apiRouter.post('/returns/:id/reject', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    res.json(await rejectReturn(req.params.id, req.body?.notes ?? req.body?.reason, saleActor(req)));
  } catch (err: any) {
    sendError(res, err, 'Failed to reject return.', 'POST /returns/:id/reject');
  }
});

// No direct status editing: status changes only through approve / reject above.
const noDirectReturnEdit = (req: AuthenticatedRequest, res: Response) =>
  res.status(405).json({ error: 'Return status cannot be edited directly. Use approve or reject.' });
apiRouter.put('/returns/:id', requireRole('ADMIN'), noDirectReturnEdit);
apiRouter.patch('/returns/:id', requireRole('ADMIN'), noDirectReturnEdit);
apiRouter.patch('/returns/:id/status', requireRole('ADMIN'), noDirectReturnEdit);

// --- 13. EXPENSES (ADMIN) ---
apiRouter.get('/expenses', requirePermission('expenses.manage'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    res.json(await getAllExpenses());
  } catch (err: any) {
    sendError(res, err, 'Failed to fetch expenses.', 'GET /expenses');
  }
});

apiRouter.post('/expenses', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    res.status(201).json({ success: true, expense: await recordExpense(req.body || {}, saleActor(req)) });
  } catch (err: any) {
    sendError(res, err, 'Failed to record expense.', 'POST /expenses');
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
  } catch (err: any) {
    console.error('[API] GET /settings failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch settings.' });
  }
});

apiRouter.put('/settings', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const saved = await updatePharmacySettings(req.body || {}, actorAudit(req));
    res.json({ success: true, settings: saved });
  } catch (err: any) {
    console.error('[API] PUT /settings failed:', err.message);
    res.status(errorStatus(err)).json({ error: err.message || 'Failed to update settings.' });
  }
});

// Unknown /api paths return JSON 404 instead of falling through to the SPA index.html fallback.
apiRouter.use((req: Request, res: Response) => {
  res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
});
