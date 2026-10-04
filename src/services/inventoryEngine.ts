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
