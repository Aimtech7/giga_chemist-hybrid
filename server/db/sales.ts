import { pgPool, isLocalMode, supabaseAdmin, isSupabaseConfigured } from './client';
import { serverDb } from '../db';
import { recordInventoryMovement } from './inventory';
import { isExpired } from '../../src/utils/expiry';
import type { Sale, PaginatedSalesResponse } from '../../src/types';

export interface SalesQueryParams {
  page?: number;
  limit?: number;
  search?: string;
  startDate?: string;
  endDate?: string;
  cashierId?: string;
}

export async function getAllSales(params?: SalesQueryParams): Promise<Sale[] | PaginatedSalesResponse> {
  const page = Math.max(1, Number(params?.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(params?.limit) || 50));
  const offset = (page - 1) * limit;

  try {
    const conditions: string[] = [];
    const values: any[] = [];
    let valIndex = 1;

    if (params?.search && params.search.trim()) {
      const q = `%${params.search.trim()}%`;
      conditions.push(`(s.receipt_number ILIKE $${valIndex} OR s.sale_number ILIKE $${valIndex} OR s.payment_reference ILIKE $${valIndex} OR c.name ILIKE $${valIndex})`);
      values.push(q);
      valIndex++;
    }

    if (params?.startDate) {
      conditions.push(`s.date >= $${valIndex}`);
      values.push(params.startDate);
      valIndex++;
    }

    if (params?.endDate) {
      conditions.push(`s.date <= $${valIndex}`);
      values.push(params.endDate);
      valIndex++;
    }

    if (params?.cashierId) {
      conditions.push(`s.cashier_id::text = $${valIndex}`);
      values.push(params.cashierId);
      valIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Total count for pagination
    const countRes = await pgPool.query(`
      SELECT COUNT(*) as count 
      FROM sales s 
      LEFT JOIN customers c ON s.customer_id = c.id 
      ${whereClause}
    `, values);
    const total = parseInt(countRes.rows[0]?.count || '0', 10);

    const salesRes = await pgPool.query(`
      SELECT 
        s.id, s.branch_id, s.sale_number, s.receipt_number,
        s.cashier_id, u.name as cashier_name,
        s.customer_id, c.name as customer_name, c.phone as customer_phone,
        s.device_id, s.date, s.time,
        COALESCE(s.subtotal, 0)::float as subtotal,
        COALESCE(s.discount_percent, 0)::float as discount_percent,
        COALESCE(s.discount_total, 0)::float as discount_total,
        COALESCE(s.tax_total, 0)::float as tax_total,
        COALESCE(s.total, 0)::float as total,
        COALESCE(s.cost_total, 0)::float as cost_total,
        COALESCE(s.gross_profit, 0)::float as gross_profit,
        s.payment_method, s.payment_reference,
        COALESCE(s.amount_received, 0)::float as amount_received,
        COALESCE(s.change_given, 0)::float as change_given,
        s.status, s.void_reason, s.idempotency_key, s.sync_status,
        s.created_at
      FROM sales s
      LEFT JOIN users u ON s.cashier_id = u.id
      LEFT JOIN customers c ON s.customer_id = c.id
      ${whereClause}
      ORDER BY s.created_at DESC
      LIMIT $${valIndex} OFFSET $${valIndex + 1}
    `, [...values, limit, offset]);

    if (salesRes.rows && salesRes.rows.length > 0) {
      const saleIds = salesRes.rows.map((r) => r.id);
      
      // Fetch line items for these sales
      const itemsRes = await pgPool.query(`
        SELECT 
          si.id, si.sale_id, si.medicine_id, m.name as medicine_name, m.generic_name,
          si.batch_id, si.batch_number, si.expiry_date,
          COALESCE(si.quantity, 0)::int as quantity,
          COALESCE(si.unit_price, 0)::float as unit_price,
          COALESCE(si.discount, 0)::float as discount,
          COALESCE(si.cost_price_snapshot, 0)::float as cost_price_snapshot,
          COALESCE(si.total, 0)::float as total
        FROM sale_items si
        LEFT JOIN medicines m ON si.medicine_id = m.id
        WHERE si.sale_id = ANY($1::uuid[])
      `, [saleIds]);

      const itemsBySale = new Map<string, any[]>();
      for (const it of itemsRes.rows) {
        const list = itemsBySale.get(it.sale_id) || [];
        list.push({
          medicine_id: it.medicine_id,
          medicine_name: it.medicine_name || 'Pharmaceutical Item',
          generic_name: it.generic_name || '',
          batch_id: it.batch_id,
          batch_number: it.batch_number,
          expiry_date: it.expiry_date ? new Date(it.expiry_date).toISOString().split('T')[0] : '',
          quantity: Number(it.quantity) || 0,
          unit_price: Number(it.unit_price) || 0,
          discount: Number(it.discount) || 0,
          cost_price_snapshot: Number(it.cost_price_snapshot) || 0,
          total: Number(it.total) || 0,
        });
        itemsBySale.set(it.sale_id, list);
      }

      const sales: Sale[] = salesRes.rows.map((r) => ({
        id: r.id,
        branch_id: r.branch_id,
        sale_number: r.sale_number,
        receipt_number: r.receipt_number,
        date: r.date ? new Date(r.date).toISOString().split('T')[0] : '',
        time: r.time || '',
        timestamp: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
        cashier_id: r.cashier_id,
        cashier_name: r.cashier_name || 'Cashier',
        customer_id: r.customer_id || undefined,
        customer_name: r.customer_name || 'Walk-in',
        customer_phone: r.customer_phone || undefined,
        device_id: r.device_id || 'SERVER-POS',
        items: itemsBySale.get(r.id) || [],
        subtotal: Number(r.subtotal) || 0,
        discount_percent: Number(r.discount_percent) || 0,
        discount_total: Number(r.discount_total) || 0,
        tax_total: Number(r.tax_total) || 0,
        total: Number(r.total) || 0,
        cost_total: Number(r.cost_total) || 0,
        gross_profit: Number(r.gross_profit) || 0,
        payment_method: r.payment_method || 'Cash',
        payment_reference: r.payment_reference || undefined,
        amount_received: Number(r.amount_received) || 0,
        change_given: Number(r.change_given) || 0,
        status: r.status || 'completed',
        void_reason: r.void_reason || undefined,
        sync_status: 'synced',
        retry_count: 0,
        idempotency_key: r.idempotency_key || `key_${r.id}`,
      }));

      if (params?.page || params?.limit) {
        return {
          sales,
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit) || 1,
        };
      }
      return sales;
    }
  } catch (err: any) {}

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      const { data, error } = await supabaseAdmin
        .from('sales')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      if (!error && data) return data as Sale[];
    } catch (err) {}
  }

  const inMemory = serverDb.get().sales;
  if (params?.page || params?.limit) {
    return {
      sales: inMemory.slice(offset, offset + limit),
      total: inMemory.length,
      page,
      limit,
      totalPages: Math.ceil(inMemory.length / limit) || 1,
    };
  }
  return inMemory;
}

export interface ProcessSaleOptions {
  userRole?: string;
  userId?: string;
}

export async function processSaleCheckout(
  sale: Sale,
  options?: ProcessSaleOptions
): Promise<{ success: boolean; sale: Sale; duplicate?: boolean }> {
  const store = serverDb.get();
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const timeStr = now.toLocaleTimeString();

  if (!Array.isArray(sale.items) || sale.items.length === 0) {
    throw new Error('Sale must contain at least one item.');
  }

  // 1. Independent Server-Side Financial Calculations
  // Calculate Subtotal from items
  const calculatedSubtotal = sale.items.reduce((sum, item) => {
    const qty = Number(item.quantity) || 0;
    const price = Number(item.unit_price) || 0;
    return sum + (qty * price);
  }, 0);

  const roundedSubtotal = Math.round(calculatedSubtotal * 100) / 100;

  // Determine and Validate Discount Percentage
  let discountPct = 0;
  if (sale.discount_percent !== undefined && sale.discount_percent !== null) {
    discountPct = Number(sale.discount_percent);
  } else if (sale.discount_total && roundedSubtotal > 0) {
    discountPct = Math.round((Number(sale.discount_total) / roundedSubtotal) * 10000) / 100;
  }

  if (isNaN(discountPct) || discountPct < 0) {
    throw new Error('Discount percentage cannot be negative.');
  }

  // Strict RBAC Enforcement: Cashiers are strictly capped at 10% maximum discount
  const userRole = options?.userRole || 'CASHIER';
  if (userRole === 'CASHIER' && discountPct > 10) {
    throw new Error('Cashier discount cannot exceed 10%.');
  }

  if (discountPct > 100) {
    throw new Error('Discount percentage cannot exceed 100%.');
  }

  // Calculate discount amount and final total with safe numeric precision
  const discountAmount = Math.round((roundedSubtotal * discountPct) / 100 * 100) / 100;
  const taxableSubtotal = Math.max(0, roundedSubtotal - discountAmount);
  const taxTotal = sale.tax_total ? Math.round(Number(sale.tax_total) * 100) / 100 : 0;
  const finalTotal = Math.round((taxableSubtotal + taxTotal) * 100) / 100;

  // Validate amount received
  const amountReceived = sale.payment_method === 'Cash'
    ? (Number(sale.amount_received) >= finalTotal ? Number(sale.amount_received) : finalTotal)
    : finalTotal;
  const changeGiven = sale.payment_method === 'Cash' ? Math.max(0, Math.round((amountReceived - finalTotal) * 100) / 100) : 0;

  // Calculate cost and gross profit
  let costTotal = 0;
  for (const item of sale.items) {
    const costPrice = Number(item.cost_price_snapshot) || Number(item.unit_price);
    costTotal += (Number(item.quantity) || 0) * costPrice;
  }
  costTotal = Math.round(costTotal * 100) / 100;
  const grossProfit = Math.round((finalTotal - costTotal) * 100) / 100;

  const processedSale: Sale = {
    ...sale,
    id: sale.id || `sal-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    date: sale.date || todayStr,
    time: sale.time || timeStr,
    subtotal: roundedSubtotal,
    discount_percent: discountPct,
    discount_total: discountAmount,
    tax_total: taxTotal,
    total: finalTotal,
    cost_total: costTotal,
    gross_profit: grossProfit,
    amount_received: amountReceived,
    change_given: changeGiven,
    sync_status: 'synced',
  };

  // 2. Check idempotency in PostgreSQL
  try {
    if (processedSale.idempotency_key) {
      const existing = await pgPool.query(
        `SELECT id, sale_number, receipt_number FROM sales WHERE idempotency_key = $1 LIMIT 1`,
        [processedSale.idempotency_key]
      );
      if (existing.rows && existing.rows.length > 0) {
        return { success: true, sale: { ...processedSale, id: existing.rows[0].id }, duplicate: true };
      }
    }

    // 3. Perform ACID transaction on local PostgreSQL
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');

      // Insert Sale with discount_percent
      await client.query(`
        INSERT INTO sales (
          id, sale_number, receipt_number, cashier_id, customer_id,
          device_id, date, time, subtotal, discount_percent, discount_total, tax_total,
          total, cost_total, gross_profit, payment_method, payment_reference,
          amount_received, change_given, status, idempotency_key, sync_status
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
        )
      `, [
        processedSale.id, processedSale.sale_number, processedSale.receipt_number,
        processedSale.cashier_id || '00000000-0000-0000-0000-000000000099',
        processedSale.customer_id || null, processedSale.device_id || 'SERVER-POS',
        processedSale.date, processedSale.time, processedSale.subtotal,
        processedSale.discount_percent || 0, processedSale.discount_total || 0, processedSale.tax_total || 0,
        processedSale.total, processedSale.cost_total || 0, processedSale.gross_profit || 0,
        processedSale.payment_method, processedSale.payment_reference || null,
        processedSale.amount_received, processedSale.change_given || 0,
        processedSale.status || 'completed', processedSale.idempotency_key, 'synced'
      ]);

      // Insert Sale Items and Deduct FEFO Batch Stock
      if (Array.isArray(processedSale.items)) {
        for (const item of processedSale.items) {
          const itemDiscount = (Number(item.unit_price) * (processedSale.discount_percent || 0)) / 100;
          const itemTotal = Math.round((Number(item.quantity) * Number(item.unit_price) * (1 - (processedSale.discount_percent || 0) / 100)) * 100) / 100;

          await client.query(`
            INSERT INTO sale_items (
              sale_id, medicine_id, batch_id, batch_number, expiry_date,
              quantity, unit_price, discount, cost_price_snapshot, total
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `, [
            processedSale.id, item.medicine_id, item.batch_id, item.batch_number,
            item.expiry_date || null, item.quantity, item.unit_price,
            itemDiscount, item.cost_price_snapshot || item.unit_price, itemTotal
          ]);

          // Deduct batch stock
          await client.query(`
            UPDATE medicine_batches 
            SET quantity_available = GREATEST(0, quantity_available - $1),
                status = CASE WHEN (quantity_available - $1) <= 0 THEN 'exhausted' ELSE status END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
          `, [item.quantity, item.batch_id]);

          // Record Inventory Movement
          await client.query(`
            INSERT INTO inventory_movements (
              medicine_id, batch_id, previous_quantity, adjustment_quantity,
              new_quantity, movement_type, reason, reference_id, user_id, device_id, date, timestamp
            ) VALUES (
              $1, $2, 0, -$3, 0, 'SALE', 'sale', $4, $5, $6, $7, $8
            )
          `, [
            item.medicine_id, item.batch_id, item.quantity,
            processedSale.receipt_number,
            processedSale.cashier_id || '00000000-0000-0000-0000-000000000099',
            processedSale.device_id || 'SERVER-POS',
            processedSale.date, Date.now()
          ]);
        }
      }

      // Insert Payments (support single payment method or split payments)
      if (processedSale.split_payments && processedSale.split_payments.length > 0) {
        for (const sp of processedSale.split_payments) {
          await client.query(`
            INSERT INTO payments (sale_id, method, amount, reference)
            VALUES ($1, $2, $3, $4)
          `, [
            processedSale.id, sp.method, sp.amount, sp.reference || null
          ]);
        }
      } else {
        await client.query(`
          INSERT INTO payments (sale_id, method, amount, reference)
          VALUES ($1, $2, $3, $4)
        `, [
          processedSale.id, processedSale.payment_method, processedSale.total,
          processedSale.payment_reference || null
        ]);
      }

      // Update Customer Total Spend
      if (processedSale.customer_id) {
        await client.query(`
          UPDATE customers 
          SET total_spent = total_spent + $1, last_visit = CURRENT_TIMESTAMP 
          WHERE id = $2
        `, [processedSale.total, processedSale.customer_id]);
      }

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (pgErr: any) {
    if (pgErr?.message?.includes('Cashier discount cannot exceed 10%')) {
      throw pgErr;
    }
    // Fallback if PostgreSQL is offline
  }

  // Update in-memory fallback store
  store.sales.unshift(processedSale);
  if (processedSale.idempotency_key) {
    store.processed_idempotency_keys[processedSale.idempotency_key] = processedSale.id;
  }
  serverDb.persist();

  return { success: true, sale: processedSale };
}

export interface TodaySalesSummary {
  totalSales: number;
  cashTotal: number;
  mpesaTotal: number;
  transactionCount: number;
  refundsTotal: number;
  date: string;
}

export async function getTodaySalesSummary(options?: {
  cashierId?: string;
  role?: string;
}): Promise<TodaySalesSummary> {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  try {
    const cashierFilter = options?.cashierId ? `AND s.cashier_id::text = $1` : '';
    const params = options?.cashierId ? [options.cashierId] : [];

    // 1. Overall Sales Aggregate for Today (excluding voided sales)
    const salesAggRes = await pgPool.query(`
      SELECT 
        COALESCE(SUM(s.total), 0)::float as total_sales,
        COUNT(s.id)::int as transaction_count
      FROM sales s
      WHERE s.date = CURRENT_DATE
        AND s.status != 'voided'
        ${cashierFilter}
    `, params);

    const totalSales = Number(salesAggRes.rows[0]?.total_sales) || 0;
    const transactionCount = Number(salesAggRes.rows[0]?.transaction_count) || 0;

    // 2. Payments Breakdown (Cash vs M-Pesa canonical recognition)
    const paymentsRes = await pgPool.query(`
      SELECT 
        p.method,
        COALESCE(SUM(p.amount), 0)::float as amount
      FROM payments p
      JOIN sales s ON p.sale_id = s.id
      WHERE s.date = CURRENT_DATE
        AND s.status != 'voided'
        ${cashierFilter}
      GROUP BY p.method
    `, params);

    let cashTotal = 0;
    let mpesaTotal = 0;

    for (const row of paymentsRes.rows) {
      const method = (row.method || '').toLowerCase().trim();
      const amount = Number(row.amount) || 0;

      if (method.includes('cash')) {
        cashTotal += amount;
      } else if (method.includes('mpesa') || method.includes('m-pesa') || method.includes('m_pesa')) {
        mpesaTotal += amount;
      }
    }

    // 3. Refunds for Today
    const refundCashierFilter = options?.cashierId ? `AND r.user_id::text = $1` : '';
    const refundsRes = await pgPool.query(`
      SELECT COALESCE(SUM(r.refund_amount), 0)::float as refunds_total
      FROM returns r
      WHERE r.created_at::date = CURRENT_DATE
        ${refundCashierFilter}
    `, params);

    const refundsTotal = Number(refundsRes.rows[0]?.refunds_total) || 0;

    return {
      totalSales: Math.round(totalSales * 100) / 100,
      cashTotal: Math.round(cashTotal * 100) / 100,
      mpesaTotal: Math.round(mpesaTotal * 100) / 100,
      transactionCount,
      refundsTotal: Math.round(refundsTotal * 100) / 100,
      date: todayStr,
    };
  } catch (err) {
    // Fallback to in-memory calculations if PostgreSQL not available
    const store = serverDb.get();
    const todaySales = store.sales.filter((s) => {
      if (s.date !== todayStr) return false;
      if (s.status === 'voided') return false;
      if (options?.cashierId && s.cashier_id !== options.cashierId) return false;
      return true;
    });

    let totalSales = 0;
    let cashTotal = 0;
    let mpesaTotal = 0;

    for (const s of todaySales) {
      totalSales += s.total;
      const method = (s.payment_method || '').toLowerCase().trim();
      if (method.includes('cash')) {
        cashTotal += s.total;
      } else if (method.includes('mpesa') || method.includes('m-pesa') || method.includes('m_pesa')) {
        mpesaTotal += s.total;
      } else if (method === 'mixed' && s.split_payments) {
        for (const sp of s.split_payments) {
          const spMethod = (sp.method || '').toLowerCase().trim();
          if (spMethod.includes('cash')) cashTotal += sp.amount;
          else if (spMethod.includes('mpesa') || spMethod.includes('m-pesa')) mpesaTotal += sp.amount;
        }
      }
    }

    const todayReturns = store.customer_returns.filter((r) => {
      if (r.date !== todayStr) return false;
      if (options?.cashierId && r.user_id !== options.cashierId) return false;
      return true;
    });
    const refundsTotal = todayReturns.reduce((sum, r) => sum + (r.refund_amount || 0), 0);

    return {
      totalSales: Math.round(totalSales * 100) / 100,
      cashTotal: Math.round(cashTotal * 100) / 100,
      mpesaTotal: Math.round(mpesaTotal * 100) / 100,
      transactionCount: todaySales.length,
      refundsTotal: Math.round(refundsTotal * 100) / 100,
      date: todayStr,
    };
  }
}

