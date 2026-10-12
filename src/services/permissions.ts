import type { User, UserRole, PermissionKey } from '../types';

/**
 * Granular Role-Based Permissions Matrix
 */
const ROLE_PERMISSIONS: Record<UserRole, PermissionKey[]> = {
  ADMIN: [
    'medicine.create',
    'medicine.update',
    'medicine.delete',
    'medicine.change_price',
    'medicine.view',
    'inventory.view',
    'inventory.adjust',
    'stock.receive',
    'sales.create',
    'sales.view',
    'sales.void',
    'reports.view',
    'users.manage',
    'settings.manage',
    'audit.view',
    'returns.process',
    'returns.request',
    'customers.manage',
    'expenses.manage',
    'history.stock.view',
    'shift.open',
    'shift.close',
    'shift.view_own',
    'shift.view_all',
    'shift.review',
    'shift.correct',
  ],
  MANAGER: [
    'medicine.view',
    'inventory.view',
    'stock.receive',
    'sales.create',
    'sales.view',
    'sales.void',
    'reports.view',
    'returns.process',
    'returns.request',
    'customers.manage',
    'expenses.manage',
    'history.stock.view',
    'shift.open',
    'shift.close',
    'shift.view_own',
    'shift.view_all',
    'shift.review',
  ],
  CASHIER: [
    'sales.create',
    'sales.view',
    'medicine.view',
    'customers.manage',
    'returns.request',
    'history.stock.view',
    'shift.open',
    'shift.close',
    'shift.view_own',
  ],
};

/**
 * Check if a user possesses a specific granular permission.
 */
export function hasPermission(user: User | null | undefined, permission: PermissionKey): boolean {
  if (!user || !user.active) return false;
  const permissions = ROLE_PERMISSIONS[user.role] || [];
  return permissions.includes(permission);
}

/**
 * Role predicates
 */
export function isCashier(user: User | null | undefined): boolean {
  return user?.role === 'CASHIER';
}

export function isManager(user: User | null | undefined): boolean {
  return user?.role === 'MANAGER';
}

export function isAdmin(user: User | null | undefined): boolean {
  return user?.role === 'ADMIN';
}

/**
 * CRITICAL FINANCIAL PRIVACY RULE:
 * Cashiers must NEVER see purchase prices, cost prices, gross profits, profit margins,
 * supplier financials, or inventory valuations anywhere in the UI or receipts.
 */
export function canViewCostData(user: User | null | undefined): boolean {
  if (!user || !user.active) return false;
  return user.role === 'ADMIN' || user.role === 'MANAGER';
}

/**
 * Determines whether a user has access to a top-level application module.
 */
export function canAccessModule(user: User | null | undefined, module: string): boolean {
  if (!user || !user.active) return false;

  if (user.role === 'ADMIN') return true;

  if (user.role === 'MANAGER') {
    const forbiddenForManager = ['users', 'audit', 'settings', 'stocktake', 'remote'];
    return !forbiddenForManager.includes(module);
  }

  if (user.role === 'CASHIER') {
    // 'history' = Stock History ONLY for a cashier (the Sales / Supply tabs stay Administrator / Manager).
    const allowedForCashier = ['dashboard', 'pos', 'medicines', 'customers', 'sales', 'returns', 'history'];
    return allowedForCashier.includes(module);
  }

  return false;
}

/** History tabs: Sales / Supply history are Administrator / Manager; Stock History is every role. */
export function canViewTransactionHistory(user: User | null | undefined): boolean {
  return user?.role === 'ADMIN' || user?.role === 'MANAGER';
}
export function canViewStockHistory(user: User | null | undefined): boolean {
  return hasPermission(user, 'history.stock.view');
}
/** Shifts tab: every role sees its OWN shifts; Administrator / Manager see every shift of the shop. */
export function canViewShifts(user: User | null | undefined): boolean {
  return hasPermission(user, 'shift.view_own') || hasPermission(user, 'shift.view_all');
}
export function canViewAllShifts(user: User | null | undefined): boolean {
  return hasPermission(user, 'shift.view_all');
}
export function canReviewShifts(user: User | null | undefined): boolean {
  return hasPermission(user, 'shift.review');
}
export function canCorrectShifts(user: User | null | undefined): boolean {
  return hasPermission(user, 'shift.correct');
}

/**
 * Specific permission helper functions
 */
export function canChangePrice(user: User | null | undefined): boolean {
  return user?.role === 'ADMIN';
}

export function canAdjustStock(user: User | null | undefined): boolean {
  return user?.role === 'ADMIN';
}

export function canCreateMedicine(user: User | null | undefined): boolean {
  return user?.role === 'ADMIN';
}

export function canReceiveStock(user: User | null | undefined): boolean {
  return user?.role === 'ADMIN' || user?.role === 'MANAGER';
}

export function canVoidSale(user: User | null | undefined): boolean {
  return user?.role === 'ADMIN';
}

export function canViewReports(user: User | null | undefined): boolean {
  return user?.role === 'ADMIN' || user?.role === 'MANAGER';
}

export function canManageUsers(user: User | null | undefined): boolean {
  return user?.role === 'ADMIN';
}

export function canManageSettings(user: User | null | undefined): boolean {
  return user?.role === 'ADMIN';
}

export function canViewAuditTrail(user: User | null | undefined): boolean {
  return user?.role === 'ADMIN';
}

export function canProcessReturns(user: User | null | undefined): boolean {
  return user?.role === 'ADMIN' || user?.role === 'MANAGER';
}
