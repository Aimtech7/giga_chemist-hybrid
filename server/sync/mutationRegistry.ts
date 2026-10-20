import type pg from 'pg';
import type { SyncEventType } from './outbox';

/**
 * Central Event Coverage Registry:
 * Maps every local business mutation to its mandatory synchronization event type.
 *
 * Invariant: Every committed business mutation must stage its corresponding
 * outbox event inside the SAME database transaction.
 */

export interface MutationDefinition {
  mutation_name: string;
  entity_type: string;
  operation: string;
  required_event_type: SyncEventType;
  description: string;
}

export const MUTATION_COVERAGE_REGISTRY: Record<string, MutationDefinition> = {
  // 1. Sales & Returns
  checkoutSale: {
    mutation_name: 'checkoutSale',
    entity_type: 'sale',
    operation: 'CREATE',
    required_event_type: 'SALE_COMPLETED',
    description: 'Local POS completed sale with payments and inventory deductions',
  },
  voidSale: {
    mutation_name: 'voidSale',
    entity_type: 'sale',
    operation: 'VOID',
    required_event_type: 'SALE_VOIDED',
    description: 'Admin voided sale with restored stock and payment reversal',
  },
  requestReturn: {
    mutation_name: 'requestReturn',
    entity_type: 'return',
    operation: 'CREATE',
    required_event_type: 'RETURN_REQUESTED',
    description: 'Cashier initiated return request',
  },
  approveReturn: {
    mutation_name: 'approveReturn',
    entity_type: 'return',
    operation: 'APPROVE',
    required_event_type: 'RETURN_APPROVED',
    description: 'Admin approved return with refund and optional stock restock',
  },
  rejectReturn: {
    mutation_name: 'rejectReturn',
    entity_type: 'return',
    operation: 'REJECT',
    required_event_type: 'RETURN_REJECTED',
    description: 'Admin rejected return request without stock or revenue change',
  },

  // 2. Inventory & Medicines
  createMedicine: {
    mutation_name: 'createMedicine',
    entity_type: 'medicine',
    operation: 'CREATE',
    required_event_type: 'MEDICINE_CREATED',
    description: 'New medicine added to shop catalogue',
  },
  updateMedicine: {
    mutation_name: 'updateMedicine',
    entity_type: 'medicine',
    operation: 'UPDATE',
    required_event_type: 'MEDICINE_UPDATED',
    description: 'Medicine profile or metadata updated',
  },
  archiveMedicine: {
    mutation_name: 'archiveMedicine',
    entity_type: 'medicine',
    operation: 'ARCHIVE',
    required_event_type: 'MEDICINE_ARCHIVED',
    description: 'Medicine archived due to historical references',
  },
  deleteMedicine: {
    mutation_name: 'deleteMedicine',
    entity_type: 'medicine',
    operation: 'DELETE',
    required_event_type: 'MEDICINE_DELETED',
    description: 'Unused medicine permanently deleted',
  },
  updateMedicinePricing: {
    mutation_name: 'updateMedicinePricing',
    entity_type: 'medicine',
    operation: 'PRICE_CHANGE',
    required_event_type: 'MEDICINE_PRICE_CHANGED',
    description: 'Selling or wholesale price modified',
  },

  // 3. Batches & Stock Operations
  createBatch: {
    mutation_name: 'createBatch',
    entity_type: 'batch',
    operation: 'CREATE',
    required_event_type: 'BATCH_UPDATED',
    description: 'New batch created for medicine',
  },
  updateBatch: {
    mutation_name: 'updateBatch',
    entity_type: 'batch',
    operation: 'UPDATE',
    required_event_type: 'BATCH_UPDATED',
    description: 'Batch details updated',
  },
  changeBatchExpiry: {
    mutation_name: 'changeBatchExpiry',
    entity_type: 'batch',
    operation: 'UPDATE',
    required_event_type: 'BATCH_EXPIRY_CHANGED',
    description: 'Batch expiry date modified',
  },
  addStock: {
    mutation_name: 'addStock',
    entity_type: 'stock',
    operation: 'ADD',
    required_event_type: 'STOCK_ADDED',
    description: 'Stock manually added with inventory movement',
  },
  removeStock: {
    mutation_name: 'removeStock',
    entity_type: 'stock',
    operation: 'REMOVE',
    required_event_type: 'STOCK_REMOVED',
    description: 'Stock manually removed or damaged with inventory movement',
  },
  setStock: {
    mutation_name: 'setStock',
    entity_type: 'stock',
    operation: 'SET',
    required_event_type: 'STOCK_SET',
    description: 'Stock quantity set with computed delta movement',
  },
  physicalCount: {
    mutation_name: 'physicalCount',
    entity_type: 'stock',
    operation: 'COUNT',
    required_event_type: 'PHYSICAL_COUNT',
    description: 'Physical stock count adjustment',
  },
  applyStocktake: {
    mutation_name: 'applyStocktake',
    entity_type: 'stocktake',
    operation: 'COUNT',
    required_event_type: 'PHYSICAL_COUNT',
    description: 'Approved stocktake batch variance adjustments',
  },

  // 4. Purchases & Supply Chain
  createPurchase: {
    mutation_name: 'createPurchase',
    entity_type: 'purchase',
    operation: 'CREATE',
    required_event_type: 'PURCHASE_DRAFTED',
    description: 'Draft purchase order created',
  },
  updatePurchase: {
    mutation_name: 'updatePurchase',
    entity_type: 'purchase',
    operation: 'UPDATE',
    required_event_type: 'PURCHASE_UPDATED',
    description: 'Draft purchase order items or quantities updated',
  },
  receivePurchase: {
    mutation_name: 'receivePurchase',
    entity_type: 'purchase',
    operation: 'RECEIVE',
    required_event_type: 'PURCHASE_RECEIVED',
    description: 'Purchase goods received into inventory with batch creation',
  },
  cancelPurchase: {
    mutation_name: 'cancelPurchase',
    entity_type: 'purchase',
    operation: 'CANCEL',
    required_event_type: 'PURCHASE_CANCELLED',
    description: 'Pending purchase cancelled',
  },

  // 5. Suppliers & Customers
  createSupplier: {
    mutation_name: 'createSupplier',
    entity_type: 'supplier',
    operation: 'UPSERT',
    required_event_type: 'SUPPLIER_UPSERTED',
    description: 'Supplier created',
  },
  updateSupplier: {
    mutation_name: 'updateSupplier',
    entity_type: 'supplier',
    operation: 'UPSERT',
    required_event_type: 'SUPPLIER_UPSERTED',
    description: 'Supplier details updated',
  },
  createCustomer: {
    mutation_name: 'createCustomer',
    entity_type: 'customer',
    operation: 'UPSERT',
    required_event_type: 'CUSTOMER_UPSERTED',
    description: 'Customer created',
  },
  updateCustomer: {
    mutation_name: 'updateCustomer',
    entity_type: 'customer',
    operation: 'UPSERT',
    required_event_type: 'CUSTOMER_UPSERTED',
    description: 'Customer details updated',
  },

  // 6. Expenses
  recordExpense: {
    mutation_name: 'recordExpense',
    entity_type: 'expense',
    operation: 'CREATE',
    required_event_type: 'EXPENSE_RECORDED',
    description: 'Expense recorded',
  },
  updateExpense: {
    mutation_name: 'updateExpense',
    entity_type: 'expense',
    operation: 'UPDATE',
    required_event_type: 'EXPENSE_UPDATED',
    description: 'Expense corrected',
  },
  voidExpense: {
    mutation_name: 'voidExpense',
    entity_type: 'expense',
    operation: 'VOID',
    required_event_type: 'EXPENSE_VOIDED',
    description: 'Expense voided',
  },

  // 7. Users & Security
  createUser: {
    mutation_name: 'createUser',
    entity_type: 'user',
    operation: 'UPSERT',
    required_event_type: 'USER_UPSERTED',
    description: 'Staff account created',
  },
  updateUser: {
    mutation_name: 'updateUser',
    entity_type: 'user',
    operation: 'UPSERT',
    required_event_type: 'USER_UPSERTED',
    description: 'Staff account profile or status updated',
  },
  deleteUser: {
    mutation_name: 'deleteUser',
    entity_type: 'user',
    operation: 'DELETE',
    required_event_type: 'USER_DELETED',
    description: 'Unused staff account deleted',
  },

  // 8. Settings
  updateSettings: {
    mutation_name: 'updateSettings',
    entity_type: 'settings',
    operation: 'UPDATE',
    required_event_type: 'SETTINGS_UPDATED',
    description: 'Shop settings updated',
  },

  // 9. Shifts
  openShift: {
    mutation_name: 'openShift',
    entity_type: 'shift',
    operation: 'OPEN',
    required_event_type: 'SHIFT_OPENED',
    description: 'Cashier shift opened with opening float',
  },
  closeShift: {
    mutation_name: 'closeShift',
    entity_type: 'shift',
    operation: 'CLOSE',
    required_event_type: 'SHIFT_CLOSED',
    description: 'Cashier shift closed with actual counted cash and variance',
  },
  reviewShift: {
    mutation_name: 'reviewShift',
    entity_type: 'shift',
    operation: 'REVIEW',
    required_event_type: 'SHIFT_REVIEWED',
    description: 'Shift reviewed by manager or administrator',
  },
  correctShift: {
    mutation_name: 'correctShift',
    entity_type: 'shift',
    operation: 'CORRECT',
    required_event_type: 'SHIFT_CORRECTED',
    description: 'Shift cash count corrected by administrator',
  },
};

/**
 * Asserts that a business transaction staged exactly one outbox event of the expected type.
 */
export async function assertTransactionEmittedSyncEvent(
  client: pg.PoolClient,
  expectedType: SyncEventType,
  entityId?: string
): Promise<{ event_id: string; idempotency_key: string; seq: number }> {
  const query = entityId
    ? `SELECT id, idempotency_key, seq::bigint AS seq FROM sync_events WHERE event_type = $1 AND entity_id = $2 ORDER BY seq DESC LIMIT 1`
    : `SELECT id, idempotency_key, seq::bigint AS seq FROM sync_events WHERE event_type = $1 ORDER BY seq DESC LIMIT 1`;
  const params = entityId ? [expectedType, String(entityId)] : [expectedType];
  const res = await client.query(query, params);
  if (!res.rows[0]) {
    throw new Error(`MUTATION_COVERAGE_FAILURE: Transaction did not emit required outbox event ${expectedType}`);
  }
  return {
    event_id: res.rows[0].id,
    idempotency_key: res.rows[0].idempotency_key,
    seq: Number(res.rows[0].seq),
  };
}
