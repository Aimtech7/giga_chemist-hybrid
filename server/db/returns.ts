import { pgPool, isLocalMode, supabaseAdmin, isSupabaseConfigured } from './client';
import { serverDb } from '../db';
import { recordInventoryMovement } from './inventory';
import { isExpired } from '../../src/utils/expiry';
import type { CustomerReturn } from '../../src/types';

export async function getAllReturns(): Promise<CustomerReturn[]> {
  try {
    const res = await pgPool.query(`
      SELECT 
        r.id, r.branch_id, r.sale_id, r.receipt_number,
        r.medicine_id, m.name as medicine_name,
        r.batch_id, b.batch_number,
        COALESCE(r.quantity, 0)::int as quantity,
        COALESCE(r.unit_price, 0)::float as unit_price,
        COALESCE(r.refund_amount, 0)::float as refund_amount,
        r.reason, r.action, r.user_id, u.name as user_name,
        r.device_id, r.created_at
      FROM returns r
      LEFT JOIN medicines m ON r.medicine_id = m.id
      LEFT JOIN medicine_batches b ON r.batch_id = b.id
      LEFT JOIN users u ON r.user_id = u.id
      ORDER BY r.created_at DESC
    `);
    if (res.rows && res.rows.length > 0) {
      return res.rows.map((r) => ({
        id: r.id,
        branch_id: r.branch_id,
        sale_id: r.sale_id,
        receipt_number: r.receipt_number,
        medicine_id: r.medicine_id,
        medicine_name: r.medicine_name || 'Item',
        batch_id: r.batch_id,
        batch_number: r.batch_number || 'Batch',
        quantity: Number(r.quantity) || 0,
        unit_price: Number(r.unit_price) || 0,
        refund_amount: Number(r.refund_amount) || 0,
        reason: r.reason,
        action: r.action,
        user_id: r.user_id,
        user_name: r.user_name || 'Staff',
        device_id: r.device_id || 'SERVER',
        date: r.created_at ? new Date(r.created_at).toISOString().split('T')[0] : '',
        timestamp: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
        sync_status: 'synced',
      }));
    }
  } catch (err) {}

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      const { data, error } = await supabaseAdmin
        .from('returns')
        .select('*')
        .order('created_at', { ascending: false });
      if (!error && data) return data as CustomerReturn[];
    } catch (err) {
      console.warn('[Server DB] Supabase returns query failed:', err);
    }
  }
  return serverDb.get().customer_returns;
}

export async function processCustomerReturn(ret: CustomerReturn): Promise<CustomerReturn> {
  const store = serverDb.get();
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  // 1. Idempotency check: prevent duplicate return submissions
  if (ret.idempotency_key) {
    if (store.processed_idempotency_keys[ret.idempotency_key]) {
      const existingId = store.processed_idempotency_keys[ret.idempotency_key];
      const existing = store.customer_returns.find((r) => r.id === existingId);
      if (existing) {
        return existing;
      }
    }
  }

  const processedReturn: CustomerReturn = {
    ...ret,
    id: ret.id || `ret-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    sync_status: 'synced',
  };

  // 2. Validate original sale & over-return limits
  const originalSale = store.sales.find((s) => s.id === processedReturn.sale_id || s.sale_number === processedReturn.sale_id);
  if (originalSale && Array.isArray(originalSale.items)) {
    const originalItem = originalSale.items.find(
      (it) => it.medicine_id === processedReturn.medicine_id && it.batch_id === processedReturn.batch_id
    );
    if (originalItem) {
      const priorReturns = store.customer_returns.filter(
        (r) => r.sale_id === originalSale.id && r.medicine_id === processedReturn.medicine_id && r.batch_id === processedReturn.batch_id
      );
      const alreadyReturnedQty = priorReturns.reduce((sum, r) => sum + r.quantity, 0);
      const remainingAllowedQty = originalItem.quantity - alreadyReturnedQty;

      if (processedReturn.quantity > remainingAllowedQty) {
        console.warn(
          `[Server DB] Return quantity ${processedReturn.quantity} exceeds remaining allowed ${remainingAllowedQty} for sale ${originalSale.receipt_number}. Clamping.`
        );
        processedReturn.quantity = Math.max(1, remainingAllowedQty);
      }
    }
  }

  const targetBatch = store.medicine_batches.find((b) => b.id === processedReturn.batch_id);

  // 3. Expiry Safety: If return_to_stock is requested but batch is expired, force quarantine
  let finalAction = processedReturn.action;
  const isBatchExpired = targetBatch ? isExpired(targetBatch.expiry_date, now) : false;
  if (finalAction === 'return_to_stock' && isBatchExpired) {
    finalAction = 'quarantine';
    processedReturn.action = 'quarantine';
  }

  // 4. Persist to PostgreSQL if local mode
  try {
    await pgPool.query(`
      INSERT INTO returns (id, sale_id, receipt_number, medicine_id, batch_id, quantity, unit_price, refund_amount, reason, action, user_id, device_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [
      processedReturn.id,
      processedReturn.sale_id,
      processedReturn.receipt_number,
      processedReturn.medicine_id,
      processedReturn.batch_id,
      processedReturn.quantity,
      processedReturn.unit_price,
      processedReturn.refund_amount,
      processedReturn.reason,
      finalAction,
      processedReturn.user_id || null,
      processedReturn.device_id || 'SERVER',
    ]);
  } catch (pgErr) {}

  // 5. Persist to Supabase if configured
  if (!isLocalMode && isSupabaseConfigured) {
    try {
      await supabaseAdmin.from('returns').insert({
        id: processedReturn.id,
        sale_id: processedReturn.sale_id,
        receipt_number: processedReturn.receipt_number,
        medicine_id: processedReturn.medicine_id,
        batch_id: processedReturn.batch_id,
        quantity: processedReturn.quantity,
        unit_price: processedReturn.unit_price,
        refund_amount: processedReturn.refund_amount,
        reason: processedReturn.reason,
        action: finalAction,
        user_id: processedReturn.user_id || 'admin',
        device_id: processedReturn.device_id || 'SERVER',
      });
    } catch (err) {
      console.warn('[Server DB] Supabase return insert failed:', err);
    }
  }

  // 5. If returning to stock and NOT expired, restock and update medicine total
  if (finalAction === 'return_to_stock' && !isBatchExpired) {
    const prevQty = targetBatch ? targetBatch.quantity_available : 0;
    if (targetBatch) {
      targetBatch.quantity_available = prevQty + processedReturn.quantity;
      if (targetBatch.status === 'exhausted') targetBatch.status = 'active';
    }

    const targetMed = store.medicines.find((m) => m.id === processedReturn.medicine_id);
    if (targetMed) {
      targetMed.current_stock = (targetMed.current_stock || 0) + processedReturn.quantity;
      targetMed.updated_at = todayStr;
    }

    await recordInventoryMovement({
      id: `mov-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      medicine_id: processedReturn.medicine_id,
      medicine_name: processedReturn.medicine_name,
      batch_id: processedReturn.batch_id,
      batch_number: processedReturn.batch_number,
      previous_quantity: prevQty,
      adjustment_quantity: processedReturn.quantity,
      new_quantity: prevQty + processedReturn.quantity,
      reason: 'customer_return',
      reference_id: processedReturn.receipt_number,
      user_id: processedReturn.user_id || 'admin',
      user_name: processedReturn.user_name || 'Staff',
      device_id: processedReturn.device_id || 'SERVER',
      date: processedReturn.date || todayStr,
      timestamp: Date.now(),
    });
  } else {
    // Quarantine movement
    await recordInventoryMovement({
      id: `mov-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      medicine_id: processedReturn.medicine_id,
      medicine_name: processedReturn.medicine_name,
      batch_id: processedReturn.batch_id,
      batch_number: processedReturn.batch_number,
      previous_quantity: targetBatch ? targetBatch.quantity_available : 0,
      adjustment_quantity: 0,
      new_quantity: targetBatch ? targetBatch.quantity_available : 0,
      reason: 'expiry',
      reference_id: processedReturn.receipt_number,
      notes: `Quarantined customer return (${finalAction})`,
      user_id: processedReturn.user_id || 'admin',
      user_name: processedReturn.user_name || 'Staff',
      device_id: processedReturn.device_id || 'SERVER',
      date: processedReturn.date || todayStr,
      timestamp: Date.now(),
    });
  }

  // 6. Update customer total spend
  if (originalSale && originalSale.customer_id) {
    const cust = store.customers.find((c) => c.id === originalSale.customer_id);
    if (cust) {
      cust.total_spent = Math.max(0, (cust.total_spent || 0) - processedReturn.refund_amount);
    }
  }

  // 7. Store processed return and cache idempotency
  store.customer_returns.unshift(processedReturn);
  if (processedReturn.idempotency_key) {
    store.processed_idempotency_keys[processedReturn.idempotency_key] = processedReturn.id;
  }
  serverDb.persist();

  return processedReturn;
}
