import { pgPool, isLocalMode, supabaseAdmin, isSupabaseConfigured } from './client';
import { serverDb } from '../db';
import { upsertBatch } from './batches';
import { recordInventoryMovement } from './inventory';
import type { Purchase } from '../../src/types';

export async function getAllPurchases(): Promise<Purchase[]> {
  try {
    const res = await pgPool.query(`
      SELECT 
        p.id, p.branch_id, p.order_number, p.invoice_number,
        p.supplier_id, s.name as supplier_name,
        p.order_date, p.received_date, p.status,
        COALESCE(p.total_amount, 0)::float as total_amount,
        p.payment_status, p.notes, p.created_at
      FROM purchases p
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      ORDER BY p.order_date DESC, p.created_at DESC
    `);
    if (res.rows && res.rows.length > 0) {
      const purchaseIds = res.rows.map((r) => r.id);
      const itemsRes = await pgPool.query(`
        SELECT 
          pi.id, pi.purchase_id, pi.medicine_id, m.name as medicine_name,
          pi.batch_number, pi.manufacturing_date, pi.expiry_date,
          COALESCE(pi.quantity, 0)::int as quantity,
          COALESCE(pi.purchase_price, 0)::float as purchase_price,
          COALESCE(pi.total, 0)::float as total
        FROM purchase_items pi
        LEFT JOIN medicines m ON pi.medicine_id = m.id
        WHERE pi.purchase_id = ANY($1::uuid[])
      `, [purchaseIds]);

      const itemsByPurchase = new Map<string, any[]>();
      for (const item of itemsRes.rows) {
        const list = itemsByPurchase.get(item.purchase_id) || [];
        list.push({
          id: item.id,
          medicine_id: item.medicine_id,
          medicine_name: item.medicine_name || 'Pharmaceutical Item',
          batch_number: item.batch_number || '',
          manufacturing_date: item.manufacturing_date ? new Date(item.manufacturing_date).toISOString().split('T')[0] : '',
          expiry_date: item.expiry_date ? new Date(item.expiry_date).toISOString().split('T')[0] : '',
          quantity: Number(item.quantity) || 0,
          purchase_price: Number(item.purchase_price) || 0,
          total: Number(item.total) || 0,
        });
        itemsByPurchase.set(item.purchase_id, list);
      }

      return res.rows.map((r) => ({
        id: r.id,
        branch_id: r.branch_id,
        order_number: r.order_number,
        invoice_number: r.invoice_number,
        supplier_id: r.supplier_id,
        supplier_name: r.supplier_name || 'Supplier',
        order_date: r.order_date ? new Date(r.order_date).toISOString().split('T')[0] : '',
        received_date: r.received_date ? new Date(r.received_date).toISOString().split('T')[0] : undefined,
        status: r.status,
        total_amount: Number(r.total_amount) || 0,
        payment_status: r.payment_status || 'unpaid',
        notes: r.notes || '',
        items: itemsByPurchase.get(r.id) || [],
        created_by: r.created_by || 'Admin',
        created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        sync_status: 'synced',
      }));
    }
  } catch (err) {}

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      const { data, error } = await supabaseAdmin
        .from('purchases')
        .select('*')
        .order('created_at', { ascending: false });
      if (!error && data) return data as Purchase[];
    } catch (err) {
      console.warn('[Server DB] Supabase purchases query failed:', err);
    }
  }
  return serverDb.get().purchases;
}

export async function receivePurchaseOrder(purchase: Purchase): Promise<Purchase> {
  const processedPurchase: Purchase = {
    ...purchase,
    id: purchase.id || `pur-${Date.now()}`,
    status: 'received',
    received_date: purchase.received_date || new Date().toISOString().split('T')[0],
  };

  try {
    await pgPool.query(`
      INSERT INTO purchases (id, order_number, invoice_number, supplier_id, order_date, received_date, status, total_amount, payment_status, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        received_date = EXCLUDED.received_date,
        total_amount = EXCLUDED.total_amount,
        payment_status = EXCLUDED.payment_status,
        notes = EXCLUDED.notes
    `, [
      processedPurchase.id,
      processedPurchase.order_number,
      processedPurchase.invoice_number,
      processedPurchase.supplier_id,
      processedPurchase.order_date || new Date().toISOString().split('T')[0],
      processedPurchase.received_date,
      processedPurchase.status,
      processedPurchase.total_amount || 0,
      processedPurchase.payment_status || 'paid',
      processedPurchase.notes || '',
    ]);
  } catch (pgErr) {}

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      await supabaseAdmin.from('purchases').upsert({
        id: processedPurchase.id,
        order_number: processedPurchase.order_number,
        invoice_number: processedPurchase.invoice_number,
        supplier_id: processedPurchase.supplier_id,
        order_date: processedPurchase.order_date,
        received_date: processedPurchase.received_date,
        status: processedPurchase.status,
        total_amount: processedPurchase.total_amount,
        payment_status: processedPurchase.payment_status,
        notes: processedPurchase.notes || '',
      });
    } catch (err) {
      console.warn('[Server DB] Supabase receivePurchaseOrder failed:', err);
    }
  }

  // Process batch updates and movements for items
  if (Array.isArray(processedPurchase.items)) {
    for (const item of processedPurchase.items) {
      const batchId = `bat-${item.medicine_id}-${item.batch_number}`;
      await upsertBatch({
        id: batchId,
        medicine_id: item.medicine_id,
        medicine_name: item.medicine_name,
        batch_number: item.batch_number,
        supplier_id: processedPurchase.supplier_id,
        supplier_name: processedPurchase.supplier_name,
        quantity_received: item.quantity,
        quantity_available: item.quantity,
        purchase_price: item.purchase_price,
        manufacturing_date: item.manufacturing_date,
        expiry_date: item.expiry_date,
        received_date: processedPurchase.received_date,
        purchase_invoice: processedPurchase.invoice_number,
        status: 'active',
      });

      await recordInventoryMovement({
        id: `mov-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        medicine_id: item.medicine_id,
        medicine_name: item.medicine_name,
        batch_id: batchId,
        batch_number: item.batch_number,
        previous_quantity: 0,
        adjustment_quantity: item.quantity,
        new_quantity: item.quantity,
        reason: 'purchase_receipt',
        reference_id: processedPurchase.invoice_number,
        user_id: 'admin',
        user_name: 'Administrator',
        device_id: 'SERVER',
        date: processedPurchase.received_date || new Date().toISOString().split('T')[0],
        timestamp: Date.now(),
      });
    }
  }

  const store = serverDb.get();
  const index = store.purchases.findIndex((p) => p.id === processedPurchase.id);
  if (index >= 0) {
    store.purchases[index] = processedPurchase;
  } else {
    store.purchases.unshift(processedPurchase);
  }
  serverDb.persist();

  return processedPurchase;
}
