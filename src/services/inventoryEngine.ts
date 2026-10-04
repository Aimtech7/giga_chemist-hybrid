import { db, getDeviceId } from '../db/dexie';
import {
  isExpired,
  isExpiringSoon,
  compareExpiryDates,
  normalizeExpiryDate,
} from '../utils/expiry';
import type {
  Medicine,
  MedicineBatch,
  InventoryMovement,
  MovementReason,
  CartItem,
  User,
  ReturnAction,
} from '../types';

export interface BatchAllocation {
  batch_id: string;
  batch_number: string;
  expiry_date: string;
  quantity: number;
  cost_price: number;
}

export interface FefoAllocationResult {
  possible: boolean;
  allocations: BatchAllocation[];
  allocatedTotal: number;
  shortfall: number;
  batchesExpiringSoon: string[];
}

/**
 * FEFO (First Expiry, First Out) batch allocator.
 * Automatically distributes requested quantity across the earliest expiring, active, non-expired batches.
 * Uses normalized date parsing to safely support mixed formats (YYYY-MM-DD and YYYY-MM).
 */
export async function allocateFefo(
  medicineId: string,
  requestedQuantity: number
): Promise<FefoAllocationResult> {
  const now = new Date();

  // Fetch batches for this medicine
  const batches = await db.medicine_batches
    .where('medicine_id')
    .equals(medicineId)
    .toArray();

  // Filter: Must be active, non-exhausted, quantity_available > 0, and strictly NOT EXPIRED!
  const validBatches = batches
    .filter(
      (b) =>
        b.status === 'active' &&
        b.quantity_available > 0 &&
        !isExpired(b.expiry_date, now)
    )
    .sort((a, b) => {
      const cmp = compareExpiryDates(a.expiry_date, b.expiry_date);
      if (cmp !== 0) return cmp;
      return a.batch_number.localeCompare(b.batch_number);
    });

  let remaining = requestedQuantity;
  const allocations: BatchAllocation[] = [];
  const batchesExpiringSoon: string[] = [];

  for (const batch of validBatches) {
    if (remaining <= 0) break;

    const allocQty = Math.min(remaining, batch.quantity_available);
    allocations.push({
      batch_id: batch.id,
      batch_number: batch.batch_number,
      expiry_date: normalizeExpiryDate(batch.expiry_date),
      quantity: allocQty,
      cost_price: batch.purchase_price,
    });

    if (isExpiringSoon(batch.expiry_date, 30, now)) {
      batchesExpiringSoon.push(batch.batch_number);
    }

    remaining -= allocQty;
  }

  const allocatedTotal = requestedQuantity - remaining;

  return {
    possible: remaining === 0,
    allocations,
    allocatedTotal,
    shortfall: Math.max(0, remaining),
    batchesExpiringSoon,
  };
}

/**
 * Perform a strictly controlled stock movement.
 * Creates an InventoryMovement entry, updates the batch quantity,
 * and synchronizes the total medicine current_stock.
 */
export async function executeStockMovement(params: {
  medicineId: string;
  batchId: string;
  adjustmentQuantity: number; // positive to add, negative to deduct
  reason: MovementReason;
  user: User;
  referenceId?: string;
  notes?: string;
}): Promise<InventoryMovement> {
  const { medicineId, batchId, adjustmentQuantity, reason, user, referenceId, notes } = params;
  const deviceId = await getDeviceId();
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  return await db.transaction(
    'rw',
    [db.medicines, db.medicine_batches, db.inventory_movements, db.audit_logs],
    async () => {
      const medicine = await db.medicines.get(medicineId);
      if (!medicine) {
        throw new Error(`Medicine ${medicineId} not found.`);
      }

      const batch = await db.medicine_batches.get(batchId);
      if (!batch) {
        throw new Error(`Batch ${batchId} not found.`);
      }

      const prevBatchQty = batch.quantity_available;
      const newBatchQty = prevBatchQty + adjustmentQuantity;

      if (newBatchQty < 0) {
        throw new Error(
          `Insufficient batch stock for batch ${batch.batch_number}. Available: ${prevBatchQty}, Requested adjustment: ${adjustmentQuantity}`
        );
      }

      // Update batch
      batch.quantity_available = newBatchQty;
      if (newBatchQty === 0) {
        batch.status = 'exhausted';
      } else if (batch.status === 'exhausted' && newBatchQty > 0) {
        batch.status = 'active';
      }
      await db.medicine_batches.put(batch);

      // Recalculate medicine current_stock from all active batches
      const allBatches = await db.medicine_batches
        .where('medicine_id')
        .equals(medicineId)
        .toArray();
      
      const now = new Date();
      const totalAvailable = allBatches
        .filter((b) => b.status === 'active' && !isExpired(b.expiry_date, now))
        .reduce((sum, b) => sum + b.quantity_available, 0);

      const prevMedStock = medicine.current_stock;
      medicine.current_stock = totalAvailable;
      medicine.updated_at = dateStr;
      medicine.updated_by = user.name;
      medicine.version = (medicine.version || 1) + 1;
      await db.medicines.put(medicine);

      // Record controlled movement
      const movement: InventoryMovement = {
        id: crypto.randomUUID(),
        medicine_id: medicine.id,
        medicine_name: medicine.name,
        batch_id: batch.id,
        batch_number: batch.batch_number,
        previous_quantity: prevBatchQty,
        adjustment_quantity: adjustmentQuantity,
        new_quantity: newBatchQty,
        reason,
        reference_id: referenceId,
        notes,
        user_id: user.id,
        user_name: user.name,
        date: dateStr,
        device_id: deviceId,
        timestamp: Date.now(),
      };
      await db.inventory_movements.put(movement);

      // Record audit log for stock modification
      await db.audit_logs.put({
        id: crypto.randomUUID(),
        user_id: user.id,
        user_name: user.name,
        role: user.role,
        action: `STOCK_${reason.toUpperCase()}`,
        entity: 'inventory_movement',
        entity_id: movement.id,
        previous_value: `Med stock: ${prevMedStock}, Batch ${batch.batch_number}: ${prevBatchQty}`,
        new_value: `Med stock: ${totalAvailable}, Batch ${batch.batch_number}: ${newBatchQty} (adj: ${adjustmentQuantity})`,
        device_id: deviceId,
        timestamp: Date.now(),
        date: dateStr,
      });

      return movement;
    }
  );
}

/**
 * Handle quarantine or disposal of expired/damaged batch
 */
export async function disposeOrQuarantineBatch(params: {
  batchId: string;
  action: 'quarantine' | 'destroy' | 'return_to_supplier' | 'remove';
  reasonNotes: string;
  user: User;
}): Promise<void> {
  const { batchId, action, reasonNotes, user } = params;
  const batch = await db.medicine_batches.get(batchId);
  if (!batch) throw new Error('Batch not found');

  const qty = batch.quantity_available;
  if (qty > 0) {
    let movementReason: MovementReason = 'expiry';
    if (action === 'destroy') movementReason = 'damage';
    if (action === 'return_to_supplier') movementReason = 'supplier_return';

    await executeStockMovement({
      medicineId: batch.medicine_id,
      batchId: batch.id,
      adjustmentQuantity: -qty,
      reason: movementReason,
      user,
      notes: `${action.toUpperCase()}: ${reasonNotes}`,
    });
  }

  batch.status = action === 'quarantine' ? 'quarantined' : 'exhausted';
  await db.medicine_batches.put(batch);
}

/**
 * Calculate total stock valuation and count metrics
 */
export async function getInventoryValuation(): Promise<{
  totalItems: number;
  totalQuantity: number;
  purchaseValuation: number;
  retailValuation: number;
  lowStockCount: number;
  outOfStockCount: number;
}> {
  const medicines = await db.medicines.where('status').equals('active').toArray();
  const batches = await db.medicine_batches.toArray();
  const now = new Date();

  let totalItems = medicines.length;
  let totalQuantity = 0;
  let purchaseValuation = 0;
  let retailValuation = 0;
  let lowStockCount = 0;
  let outOfStockCount = 0;

  for (const med of medicines) {
    const medBatches = batches.filter(
      (b) => b.medicine_id === med.id && b.status === 'active' && !isExpired(b.expiry_date, now)
    );
    const medQty = medBatches.reduce((acc, b) => acc + b.quantity_available, 0);

    totalQuantity += medQty;
    retailValuation += medQty * med.selling_price;

    for (const b of medBatches) {
      purchaseValuation += b.quantity_available * b.purchase_price;
    }

    if (medQty === 0) {
      outOfStockCount++;
    } else if (medQty <= med.reorder_level) {
      lowStockCount++;
    }
  }

  return {
    totalItems,
    totalQuantity,
    purchaseValuation,
    retailValuation,
    lowStockCount,
    outOfStockCount,
  };
}

/**
 * Derives and updates a customer's total_spent transactionally from completed sales minus returns.
 */
export async function recalculateCustomerTotalSpent(customerId: string): Promise<number> {
  const customer = await db.customers.get(customerId);
  if (!customer) return 0;

  const sales = await db.sales.where('customer_id').equals(customerId).toArray();
  const validSales = sales.filter((s) => s.status !== 'voided');

  let grossSpent = 0;
  for (const s of validSales) {
    grossSpent += s.total;
  }

  let totalRefunds = 0;
  for (const s of validSales) {
    const returns = await db.customer_returns.where('sale_id').equals(s.id).toArray();
    for (const r of returns) {
      totalRefunds += r.refund_amount || 0;
    }
  }

  const netSpent = Math.max(0, grossSpent - totalRefunds);
  customer.total_spent = netSpent;
  await db.customers.put(customer);
  return netSpent;
}
