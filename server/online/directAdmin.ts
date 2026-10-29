import type pg from 'pg';
import type { CommandType } from '../sync/commandSchema';

/**
 * Direct-write implementations for every admin command type.
 *
 * Instead of queuing a PENDING command for the local shop PC to apply, these
 * functions write immediately to `giga_cloud.*` tables via the Vercel API.
 *
 * Architecture: Admin → Vercel API → giga_cloud.* tables (immediate)
 *
 * All writes are scoped by shop_id. source_seq for direct writes is set to
 * microseconds since epoch so they are treated as newer than any historical shop sync event.
 */

type WithCloud = <T>(fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>;
type WithShopId = <T>(shopId: string, fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>;

/** Compute expiry_status from an ISO date string (or null). */
function computeExpiryStatus(expiryDate: string | null): string {
  if (!expiryDate) return 'unknown';
  const exp = new Date(`${expiryDate}T00:00:00Z`);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (exp < today) return 'expired';
  const soon = new Date(today);
  soon.setUTCDate(soon.getUTCDate() + 90);
  if (exp < soon) return 'expiring_soon';
  return 'valid';
}

/** Generate a high source_seq: microseconds since epoch as bigint string. */
function directSeq(): string {
  return String(BigInt(Date.now()) * 1000n);
}

/** Build a short order number from a timestamp, e.g. "ORD-17301234567890". */
function orderNumber(): string {
  return `ORD-${Date.now()}`;
}

export async function applyCommandDirect(
  withCloud: WithCloud,
  withShopId: WithShopId,
  shopId: string,
  type: CommandType,
  payload: Record<string, any>,
  userId: string,
): Promise<{ applied: true; result?: Record<string, unknown> }> {
  const seq = directSeq();

  switch (type) {
    // ------------------------------------------------------------------ stock
    case 'STOCK_ADD':
    case 'STOCK_OVERRIDE_ADD': {
      const { medicine_id, batch_id, batch_number, expiry_date, quantity } = payload;
      let bId = batch_id as string | null;
      if (!bId && batch_number) {
        bId = await withCloud(async (c) => {
          const r = await c.query(
            `SELECT batch_id FROM giga_cloud.medicine_batches WHERE shop_id = $1 AND medicine_id = $2 AND batch_number = $3 LIMIT 1`,
            [shopId, medicine_id, batch_number],
          );
          if (r.rows[0]) return r.rows[0].batch_id as string;
          // Auto-create batch row so stock_levels can reference it
          const newId = (await c.query(
            `INSERT INTO giga_cloud.medicine_batches
               (shop_id, batch_id, medicine_id, batch_number, expiry_date, expiry_status, status, data, source_seq, updated_at)
             VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, 'active', '{}'::jsonb, $6, now())
             RETURNING batch_id`,
            [shopId, medicine_id, batch_number, expiry_date ?? null, computeExpiryStatus(expiry_date ?? null), seq],
          )).rows[0].batch_id;
          return newId as string;
        });
      }
      if (!bId) throw new Error('batch_id or batch_number required for stock add');
      await withCloud((c) =>
        c.query(
          `INSERT INTO giga_cloud.stock_levels
             (shop_id, medicine_id, batch_id, has_baseline, baseline_quantity, delta_since_baseline, last_movement_at)
           VALUES ($1, $2, $3, true, $4, 0, now())
           ON CONFLICT (shop_id, medicine_id, batch_id) DO UPDATE
             SET delta_since_baseline = giga_cloud.stock_levels.delta_since_baseline + $4,
                 last_movement_at = now()`,
          [shopId, medicine_id, bId, quantity],
        ),
      );
      return { applied: true };
    }

    case 'STOCK_REMOVE':
    case 'STOCK_OVERRIDE_REMOVE': {
      const { medicine_id, batch_id, quantity } = payload;
      await withCloud((c) =>
        c.query(
          `INSERT INTO giga_cloud.stock_levels
             (shop_id, medicine_id, batch_id, has_baseline, baseline_quantity, delta_since_baseline, last_movement_at)
           VALUES ($1, $2, $3, true, 0, 0, now())
           ON CONFLICT (shop_id, medicine_id, batch_id) DO UPDATE
             SET delta_since_baseline = GREATEST(
                   giga_cloud.stock_levels.delta_since_baseline - $4,
                   -giga_cloud.stock_levels.baseline_quantity
                 ),
                 last_movement_at = now()`,
          [shopId, medicine_id, batch_id, quantity],
        ),
      );
      return { applied: true };
    }

    case 'STOCK_SET':
    case 'STOCK_OVERRIDE_SET': {
      const { medicine_id, quantity, batch_counts, batch_id, batch_number } = payload;
      if (Array.isArray(batch_counts) && batch_counts.length > 0) {
        await withCloud(async (c) => {
          for (const bc of batch_counts) {
            await c.query(
              `INSERT INTO giga_cloud.stock_levels
                 (shop_id, medicine_id, batch_id, has_baseline, baseline_quantity, delta_since_baseline, last_movement_at)
               VALUES ($1, $2, $3, true, $4, 0, now())
               ON CONFLICT (shop_id, medicine_id, batch_id) DO UPDATE
                 SET has_baseline = true,
                     baseline_quantity = $4,
                     delta_since_baseline = 0,
                     last_movement_at = now()`,
              [shopId, medicine_id, bc.batch_id, bc.quantity],
            );
          }
        });
      } else {
        let bId = batch_id as string | undefined;
        if (!bId && batch_number) {
          bId = await withCloud(async (c) => {
            const r = await c.query(
              `SELECT batch_id FROM giga_cloud.medicine_batches WHERE shop_id = $1 AND medicine_id = $2 AND batch_number = $3 LIMIT 1`,
              [shopId, medicine_id, batch_number],
            );
            if (r.rows[0]) return r.rows[0].batch_id as string;
            const newId = (await c.query(
              `INSERT INTO giga_cloud.medicine_batches
                 (shop_id, batch_id, medicine_id, batch_number, expiry_date, expiry_status, status, data, source_seq, updated_at)
               VALUES ($1, gen_random_uuid(), $2, $3, null, 'unknown', 'active', '{}'::jsonb, $4, now())
               RETURNING batch_id`,
              [shopId, medicine_id, batch_number, seq],
            )).rows[0].batch_id;
            return newId as string;
          });
        }
        if (!bId) throw new Error('batch_id or batch_number required for STOCK_SET');
        await withCloud((c) =>
          c.query(
            `INSERT INTO giga_cloud.stock_levels
               (shop_id, medicine_id, batch_id, has_baseline, baseline_quantity, delta_since_baseline, last_movement_at)
             VALUES ($1, $2, $3, true, $4, 0, now())
             ON CONFLICT (shop_id, medicine_id, batch_id) DO UPDATE
               SET has_baseline = true,
                   baseline_quantity = $4,
                   delta_since_baseline = 0,
                   last_movement_at = now()`,
            [shopId, medicine_id, bId, quantity],
          ),
        );
      }
      return { applied: true };
    }

    case 'STOCK_SNAPSHOT_REQUEST': {
      // No-op for online-only mode — no local PC to send snapshot to
      return { applied: true };
    }

    // ------------------------------------------------------------------ prices
    case 'PRICE_UPDATE': {
      const { medicine_id, selling_price, wholesale_price, min_selling_price, purchase_price } = payload;
      const sets: string[] = [];
      const params: any[] = [shopId, medicine_id];

      const addField = (col: string, val: any) => {
        if (val !== undefined) {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        }
      };
      addField('selling_price', selling_price);
      addField('wholesale_price', wholesale_price);
      addField('min_selling_price', min_selling_price);
      addField('purchase_price', purchase_price);

      // Also merge into data JSONB
      const patch: Record<string, any> = {};
      if (selling_price !== undefined) patch.selling_price = selling_price;
      if (wholesale_price !== undefined) patch.wholesale_price = wholesale_price;
      if (min_selling_price !== undefined) patch.min_selling_price = min_selling_price;
      if (purchase_price !== undefined) patch.purchase_price = purchase_price;

      if (sets.length > 0) {
        params.push(JSON.stringify(patch));
        params.push(seq);
        await withCloud((c) =>
          c.query(
            `UPDATE giga_cloud.medicines
                SET ${sets.join(', ')},
                    data = data || $${params.length - 1}::jsonb,
                    source_seq = $${params.length},
                    updated_at = now()
              WHERE shop_id = $1 AND medicine_id = $2`,
            params,
          ),
        );
      }
      return { applied: true };
    }

    // ------------------------------------------------------------------ medicine metadata
    case 'MEDICINE_METADATA_UPDATE': {
      const { medicine_id, ...rest } = payload;
      const directCols = ['name', 'generic_name', 'barcode', 'sku', 'category', 'status', 'reorder_level'];
      const allowed = [
        ...directCols,
        'brand_name', 'manufacturer', 'description', 'dosage_form', 'dosage_strength', 'unit',
        'prescription_required', 'medicine_type',
      ];
      const sets: string[] = [];
      const params: any[] = [shopId, medicine_id];
      const patch: Record<string, any> = {};
      for (const key of allowed) {
        if (rest[key] !== undefined) {
          if (directCols.includes(key)) {
            params.push(rest[key]);
            sets.push(`${key} = $${params.length}`);
          }
          patch[key] = rest[key];
        }
      }
      if (sets.length > 0 || Object.keys(patch).length > 0) {
        params.push(JSON.stringify(patch));
        params.push(seq);
        const setSql = sets.length > 0 ? `${sets.join(', ')}, ` : '';
        await withCloud((c) =>
          c.query(
            `UPDATE giga_cloud.medicines
                SET ${setSql}data = data || $${params.length - 1}::jsonb,
                    source_seq = $${params.length},
                    updated_at = now()
              WHERE shop_id = $1 AND medicine_id = $2`,
            params,
          ),
        );
      }
      return { applied: true };
    }

    // ------------------------------------------------------------------ medicine CRUD
    case 'MEDICINE_CREATE': {
      const {
        medicine_id, name, generic_name, barcode, sku, category, reorder_level,
        selling_price, wholesale_price, min_selling_price, purchase_price,
        brand_name, manufacturer, description, dosage_form, dosage_strength,
        unit, prescription_required, medicine_type, batch_number, expiry_date, quantity,
      } = payload;
      const dataJson = {
        name, generic_name, barcode, sku, category, brand_name, manufacturer,
        description, dosage_form, dosage_strength, unit, prescription_required, medicine_type,
        selling_price, wholesale_price, min_selling_price, purchase_price, reorder_level,
      };
      await withCloud(async (c) => {
        await c.query(
          `INSERT INTO giga_cloud.medicines
             (shop_id, medicine_id, name, generic_name, barcode, sku, category, status,
              selling_price, wholesale_price, min_selling_price, purchase_price,
              reorder_level, local_version, data, source_seq, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'active',
                   $8, $9, $10, $11,
                   $12, 1, $13::jsonb, $14, now())
           ON CONFLICT (shop_id, medicine_id) DO UPDATE
             SET name = EXCLUDED.name,
                 generic_name = EXCLUDED.generic_name,
                 barcode = EXCLUDED.barcode,
                 sku = EXCLUDED.sku,
                 category = EXCLUDED.category,
                 status = EXCLUDED.status,
                 selling_price = EXCLUDED.selling_price,
                 wholesale_price = EXCLUDED.wholesale_price,
                 min_selling_price = EXCLUDED.min_selling_price,
                 purchase_price = EXCLUDED.purchase_price,
                 reorder_level = EXCLUDED.reorder_level,
                 data = giga_cloud.medicines.data || EXCLUDED.data,
                 source_seq = EXCLUDED.source_seq,
                 updated_at = now()`,
          [
            shopId, medicine_id, name ?? null, generic_name ?? null, barcode ?? null, sku ?? null,
            category ?? null, selling_price ?? null, wholesale_price ?? null, min_selling_price ?? null,
            purchase_price ?? null, reorder_level ?? 0, JSON.stringify(dataJson), seq,
          ],
        );

        if (batch_number) {
          const bId = (await c.query(
            `INSERT INTO giga_cloud.medicine_batches
               (shop_id, batch_id, medicine_id, batch_number, expiry_date, expiry_status, status, data, source_seq, updated_at)
             VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, 'active', '{}'::jsonb, $6, now())
             ON CONFLICT (shop_id, batch_id) DO NOTHING
             RETURNING batch_id`,
            [shopId, medicine_id, batch_number, expiry_date ?? null, computeExpiryStatus(expiry_date ?? null), seq],
          )).rows[0]?.batch_id;
          if (bId && quantity && quantity > 0) {
            await c.query(
              `INSERT INTO giga_cloud.stock_levels
                 (shop_id, medicine_id, batch_id, has_baseline, baseline_quantity, delta_since_baseline, last_movement_at)
               VALUES ($1, $2, $3, true, $4, 0, now())
               ON CONFLICT (shop_id, medicine_id, batch_id) DO UPDATE
                 SET baseline_quantity = $4, has_baseline = true, delta_since_baseline = 0, last_movement_at = now()`,
              [shopId, medicine_id, bId, quantity],
            );
          }
        }
      });
      return { applied: true, result: { medicine_id } };
    }

    case 'MEDICINE_SET_ACTIVE': {
      const { medicine_id, active } = payload;
      const status = active ? 'active' : 'archived';
      await withCloud((c) =>
        c.query(
          `UPDATE giga_cloud.medicines
              SET status = $3, data = data || $4::jsonb, source_seq = $5, updated_at = now()
            WHERE shop_id = $1 AND medicine_id = $2`,
          [shopId, medicine_id, status, JSON.stringify({ status }), seq],
        ),
      );
      return { applied: true };
    }

    case 'MEDICINE_DELETE_PREFLIGHT': {
      // Read-only: return current stock totals from cloud
      const { medicine_id } = payload;
      const result = await withCloud(async (c) => {
        const r = await c.query(
          `SELECT COALESCE(SUM(
            CASE WHEN has_baseline THEN baseline_quantity + delta_since_baseline
                 ELSE COALESCE(last_reported_quantity, 0)
            END
          ), 0)::int AS current_stock
           FROM giga_cloud.stock_levels
           WHERE shop_id = $1 AND medicine_id = $2`,
          [shopId, medicine_id],
        );
        const current_stock = Number(r.rows[0]?.current_stock ?? 0);
        return { current_stock, has_stock: current_stock > 0 };
      });
      return { applied: true, result };
    }

    case 'MEDICINE_DELETE': {
      const { medicine_id } = payload;
      // Delete stock_levels, batches, then medicine (only if no stock)
      await withCloud(async (c) => {
        const stockRow = await c.query(
          `SELECT COALESCE(SUM(
            CASE WHEN has_baseline THEN baseline_quantity + delta_since_baseline
                 ELSE COALESCE(last_reported_quantity, 0)
            END
          ), 0)::int AS current_stock
           FROM giga_cloud.stock_levels
           WHERE shop_id = $1 AND medicine_id = $2`,
          [shopId, medicine_id],
        );
        const currentStock = Number(stockRow.rows[0]?.current_stock ?? 0);
        if (currentStock > 0) {
          throw new Error(`Cannot delete medicine: it still has ${currentStock} units of stock.`);
        }
        await c.query(`DELETE FROM giga_cloud.stock_levels WHERE shop_id = $1 AND medicine_id = $2`, [shopId, medicine_id]);
        await c.query(`DELETE FROM giga_cloud.medicine_batches WHERE shop_id = $1 AND medicine_id = $2`, [shopId, medicine_id]);
        await c.query(`DELETE FROM giga_cloud.medicines WHERE shop_id = $1 AND medicine_id = $2`, [shopId, medicine_id]);
        await c.query(
          `INSERT INTO giga_cloud.medicine_tombstones (shop_id, medicine_id, deleted_at, deletion_seq)
           VALUES ($1, $2, now(), $3)
           ON CONFLICT (shop_id, medicine_id) DO UPDATE SET deleted_at = now(), deletion_seq = EXCLUDED.deletion_seq`,
          [shopId, medicine_id, seq],
        );
      });
      return { applied: true };
    }

    // ------------------------------------------------------------------ batches
    case 'BATCH_CREATE': {
      const { batch_id, medicine_id, batch_number, expiry_date, quantity, purchase_price, selling_price_override, supplier_id } = payload;
      const expiryStatus = computeExpiryStatus(expiry_date ?? null);
      const dataJson: Record<string, any> = {};
      if (purchase_price !== undefined) dataJson.purchase_price = purchase_price;
      if (selling_price_override !== undefined) dataJson.selling_price_override = selling_price_override;
      if (supplier_id !== undefined) dataJson.supplier_id = supplier_id;

      await withCloud(async (c) => {
        await c.query(
          `INSERT INTO giga_cloud.medicine_batches
             (shop_id, batch_id, medicine_id, batch_number, expiry_date, expiry_status, status, data, source_seq, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'active', $7::jsonb, $8, now())
           ON CONFLICT (shop_id, batch_id) DO UPDATE
             SET batch_number = EXCLUDED.batch_number,
                 expiry_date = EXCLUDED.expiry_date,
                 expiry_status = EXCLUDED.expiry_status,
                 data = giga_cloud.medicine_batches.data || EXCLUDED.data,
                 source_seq = EXCLUDED.source_seq,
                 updated_at = now()`,
          [shopId, batch_id, medicine_id, batch_number, expiry_date ?? null, expiryStatus, JSON.stringify(dataJson), seq],
        );
        if (quantity && quantity > 0) {
          await c.query(
            `INSERT INTO giga_cloud.stock_levels
               (shop_id, medicine_id, batch_id, has_baseline, baseline_quantity, delta_since_baseline, last_movement_at)
             VALUES ($1, $2, $3, true, $4, 0, now())
             ON CONFLICT (shop_id, medicine_id, batch_id) DO UPDATE
               SET delta_since_baseline = giga_cloud.stock_levels.delta_since_baseline + $4,
                   last_movement_at = now()`,
            [shopId, medicine_id, batch_id, quantity],
          );
        }
      });
      return { applied: true, result: { batch_id } };
    }

    case 'BATCH_UPDATE': {
      const { batch_id, medicine_id: _medId, batch_number, purchase_price, selling_price_override, notes, supplier_id } = payload;
      const patch: Record<string, any> = {};
      if (batch_number !== undefined) patch.batch_number = batch_number;
      if (purchase_price !== undefined) patch.purchase_price = purchase_price;
      if (selling_price_override !== undefined) patch.selling_price_override = selling_price_override;
      if (notes !== undefined) patch.notes = notes;
      if (supplier_id !== undefined) patch.supplier_id = supplier_id;

      const sets: string[] = [];
      const params: any[] = [shopId, batch_id];
      if (batch_number !== undefined) {
        params.push(batch_number);
        sets.push(`batch_number = $${params.length}`);
      }
      params.push(JSON.stringify(patch));
      params.push(seq);
      sets.push(`data = data || $${params.length - 1}::jsonb`);
      sets.push(`source_seq = $${params.length}`);
      sets.push(`updated_at = now()`);

      await withCloud((c) =>
        c.query(
          `UPDATE giga_cloud.medicine_batches SET ${sets.join(', ')} WHERE shop_id = $1 AND batch_id = $2`,
          params,
        ),
      );
      return { applied: true };
    }

    case 'BATCH_EXPIRY_UPDATE': {
      const { batch_id, expiry_date } = payload;
      const expiryStatus = computeExpiryStatus(expiry_date ?? null);
      await withCloud((c) =>
        c.query(
          `UPDATE giga_cloud.medicine_batches
              SET expiry_date = $3, expiry_status = $4, data = data || $5::jsonb, source_seq = $6, updated_at = now()
            WHERE shop_id = $1 AND batch_id = $2`,
          [shopId, batch_id, expiry_date ?? null, expiryStatus, JSON.stringify({ expiry_date, expiry_status: expiryStatus }), seq],
        ),
      );
      return { applied: true };
    }

    case 'BATCH_SET_ACTIVE': {
      const { batch_id, active } = payload;
      const status = active ? 'active' : 'archived';
      await withCloud((c) =>
        c.query(
          `UPDATE giga_cloud.medicine_batches
              SET status = $3, data = data || $4::jsonb, source_seq = $5, updated_at = now()
            WHERE shop_id = $1 AND batch_id = $2`,
          [shopId, batch_id, status, JSON.stringify({ status }), seq],
        ),
      );
      return { applied: true };
    }

    // ------------------------------------------------------------------ suppliers
    case 'SUPPLIER_CREATE': {
      const { supplier_id, name, contact_person, phone, email, address, tax_pin } = payload;
      const dataJson = { contact_person, phone, email, address, tax_pin };
      await withCloud((c) =>
        c.query(
          `INSERT INTO giga_cloud.suppliers
             (shop_id, supplier_id, name, status, data, source_seq, updated_at)
           VALUES ($1, $2, $3, 'active', $4::jsonb, $5, now())
           ON CONFLICT (shop_id, supplier_id) DO UPDATE
             SET name = EXCLUDED.name,
                 status = EXCLUDED.status,
                 data = giga_cloud.suppliers.data || EXCLUDED.data,
                 source_seq = EXCLUDED.source_seq,
                 updated_at = now()`,
          [shopId, supplier_id, name, JSON.stringify(dataJson), seq],
        ),
      );
      return { applied: true, result: { supplier_id } };
    }

    case 'SUPPLIER_UPDATE': {
      const { supplier_id, name, contact_person, phone, email, address, tax_pin } = payload;
      const patch: Record<string, any> = {};
      if (contact_person !== undefined) patch.contact_person = contact_person;
      if (phone !== undefined) patch.phone = phone;
      if (email !== undefined) patch.email = email;
      if (address !== undefined) patch.address = address;
      if (tax_pin !== undefined) patch.tax_pin = tax_pin;
      if (name !== undefined) patch.name = name;

      const sets: string[] = [];
      const params: any[] = [shopId, supplier_id];

      if (name !== undefined) {
        params.push(name);
        sets.push(`name = $${params.length}`);
      }
      params.push(JSON.stringify(patch));
      params.push(seq);
      sets.push(`data = data || $${params.length - 1}::jsonb`);
      sets.push(`source_seq = $${params.length}`);
      sets.push(`updated_at = now()`);

      await withCloud((c) =>
        c.query(
          `UPDATE giga_cloud.suppliers SET ${sets.join(', ')} WHERE shop_id = $1 AND supplier_id = $2`,
          params,
        ),
      );
      return { applied: true };
    }

    case 'SUPPLIER_SET_ACTIVE': {
      const { supplier_id, active } = payload;
      const status = active ? 'active' : 'inactive';
      await withCloud((c) =>
        c.query(
          `UPDATE giga_cloud.suppliers
              SET status = $3, data = data || $4::jsonb, source_seq = $5, updated_at = now()
            WHERE shop_id = $1 AND supplier_id = $2`,
          [shopId, supplier_id, status, JSON.stringify({ status }), seq],
        ),
      );
      return { applied: true };
    }

    // ------------------------------------------------------------------ customers
    case 'CUSTOMER_CREATE': {
      const { customer_id, name, phone, email, address, notes } = payload;
      const dataJson = { phone, email, address, notes, active: true, loyalty_points: 0 };
      await withCloud((c) =>
        c.query(
          `INSERT INTO giga_cloud.customers
             (shop_id, customer_id, name, phone, data, source_seq, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, now())
           ON CONFLICT (shop_id, customer_id) DO UPDATE
             SET name = EXCLUDED.name,
                 phone = EXCLUDED.phone,
                 data = giga_cloud.customers.data || EXCLUDED.data,
                 source_seq = EXCLUDED.source_seq,
                 updated_at = now()`,
          [shopId, customer_id, name, phone ?? null, JSON.stringify(dataJson), seq],
        ),
      );
      return { applied: true, result: { customer_id } };
    }

    case 'CUSTOMER_UPDATE': {
      const { customer_id, name, phone, email, address, notes } = payload;
      const patch: Record<string, any> = {};
      if (name !== undefined) patch.name = name;
      if (phone !== undefined) patch.phone = phone;
      if (email !== undefined) patch.email = email;
      if (address !== undefined) patch.address = address;
      if (notes !== undefined) patch.notes = notes;

      const sets: string[] = [];
      const params: any[] = [shopId, customer_id];

      if (name !== undefined) {
        params.push(name);
        sets.push(`name = $${params.length}`);
      }
      if (phone !== undefined) {
        params.push(phone);
        sets.push(`phone = $${params.length}`);
      }
      params.push(JSON.stringify(patch));
      params.push(seq);
      sets.push(`data = data || $${params.length - 1}::jsonb`);
      sets.push(`source_seq = $${params.length}`);
      sets.push(`updated_at = now()`);

      await withCloud((c) =>
        c.query(
          `UPDATE giga_cloud.customers SET ${sets.join(', ')} WHERE shop_id = $1 AND customer_id = $2`,
          params,
        ),
      );
      return { applied: true };
    }

    case 'CUSTOMER_SET_ACTIVE': {
      const { customer_id, active } = payload;
      await withCloud((c) =>
        c.query(
          `UPDATE giga_cloud.customers
              SET data = data || $3::jsonb, source_seq = $4, updated_at = now()
            WHERE shop_id = $1 AND customer_id = $2`,
          [shopId, customer_id, JSON.stringify({ active }), seq],
        ),
      );
      return { applied: true };
    }

    // ------------------------------------------------------------------ purchases
    case 'PURCHASE_CREATE': {
      const { purchase_id, supplier_id, invoice_number, payment_status, notes, items } = payload;
      const total = Array.isArray(items)
        ? Math.round(items.reduce((s: number, i: any) => s + i.quantity * i.purchase_price, 0) * 100) / 100
        : 0;
      const dataJson = { status: 'pending', notes, items };
      await withCloud(async (c) => {
        await c.query(
          `INSERT INTO giga_cloud.purchases
             (shop_id, purchase_id, order_number, invoice_number, supplier_id,
              received_date, total_amount, payment_status, data, source_seq)
           VALUES ($1, $2, $3, $4, $5, null, $6, $7, $8::jsonb, $9)
           ON CONFLICT (shop_id, purchase_id) DO NOTHING`,
          [shopId, purchase_id, orderNumber(), invoice_number ?? null, supplier_id,
            total, payment_status ?? 'unpaid', JSON.stringify(dataJson), seq],
        );
        if (Array.isArray(items)) {
          for (const item of items) {
            await c.query(
              `INSERT INTO giga_cloud.purchase_items
                 (shop_id, purchase_item_id, purchase_id, medicine_id, batch_number,
                  quantity, purchase_price, total, data)
               VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8::jsonb)
               ON CONFLICT (shop_id, purchase_item_id) DO NOTHING`,
              [shopId, purchase_id, item.medicine_id, item.batch_number, item.quantity,
                item.purchase_price, Math.round(item.quantity * item.purchase_price * 100) / 100,
                JSON.stringify({ expiry_date: item.expiry_date, manufacturing_date: item.manufacturing_date })],
            );
          }
        }
      });
      return { applied: true, result: { purchase_id } };
    }

    case 'PURCHASE_UPDATE_DRAFT': {
      const { purchase_id, supplier_id, invoice_number, payment_status, notes, items } = payload;
      const sets: string[] = [];
      const params: any[] = [shopId, purchase_id];
      const patch: Record<string, any> = {};

      if (supplier_id !== undefined) { params.push(supplier_id); sets.push(`supplier_id = $${params.length}`); }
      if (invoice_number !== undefined) { params.push(invoice_number); sets.push(`invoice_number = $${params.length}`); patch.invoice_number = invoice_number; }
      if (payment_status !== undefined) { params.push(payment_status); sets.push(`payment_status = $${params.length}`); }
      if (notes !== undefined) patch.notes = notes;
      if (items !== undefined) {
        patch.items = items;
        const total = Math.round(items.reduce((s: number, i: any) => s + i.quantity * i.purchase_price, 0) * 100) / 100;
        params.push(total);
        sets.push(`total_amount = $${params.length}`);
      }

      params.push(JSON.stringify(patch));
      params.push(seq);
      sets.push(`data = data || $${params.length - 1}::jsonb`);
      sets.push(`source_seq = $${params.length}`);

      await withCloud(async (c) => {
        await c.query(
          `UPDATE giga_cloud.purchases SET ${sets.join(', ')} WHERE shop_id = $1 AND purchase_id = $2`,
          params,
        );
        // Replace items if provided
        if (Array.isArray(items)) {
          await c.query(`DELETE FROM giga_cloud.purchase_items WHERE shop_id = $1 AND purchase_id = $2`, [shopId, purchase_id]);
          for (const item of items) {
            await c.query(
              `INSERT INTO giga_cloud.purchase_items
                 (shop_id, purchase_item_id, purchase_id, medicine_id, batch_number,
                  quantity, purchase_price, total, data)
               VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8::jsonb)`,
              [shopId, purchase_id, item.medicine_id, item.batch_number, item.quantity,
                item.purchase_price, Math.round(item.quantity * item.purchase_price * 100) / 100,
                JSON.stringify({ expiry_date: item.expiry_date, manufacturing_date: item.manufacturing_date })],
            );
          }
        }
      });
      return { applied: true };
    }

    case 'PURCHASE_RECEIVE': {
      const { purchase_id, invoice_number, payment_status, supplier_id, items, notes } = payload;
      await withCloud(async (c) => {
        let receiveItems = items;
        if (!receiveItems) {
          // Receiving an existing pending purchase — load items from data
          const pur = (await c.query(
            `SELECT data FROM giga_cloud.purchases WHERE shop_id = $1 AND purchase_id = $2`,
            [shopId, purchase_id],
          )).rows[0];
          receiveItems = pur?.data?.items;
        }

        // Update purchase record
        const sets: string[] = [`received_date = CURRENT_DATE`, `source_seq = $3`];
        const params: any[] = [shopId, purchase_id, seq];
        const dataPayload: Record<string, any> = { status: 'received' };
        if (notes !== undefined) dataPayload.notes = notes;
        if (items !== undefined) {
          // Insert items
          for (const item of items) {
            await c.query(
              `INSERT INTO giga_cloud.purchase_items
                 (shop_id, purchase_item_id, purchase_id, medicine_id, batch_number,
                  quantity, purchase_price, total, data)
               VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8::jsonb)
               ON CONFLICT DO NOTHING`,
              [shopId, purchase_id, item.medicine_id, item.batch_number, item.quantity,
                item.purchase_price, Math.round(item.quantity * item.purchase_price * 100) / 100,
                JSON.stringify({ expiry_date: item.expiry_date, manufacturing_date: item.manufacturing_date })],
            );
          }
          if (supplier_id) { params.push(supplier_id); sets.push(`supplier_id = $${params.length}`); }
          if (invoice_number) { params.push(invoice_number); sets.push(`invoice_number = $${params.length}`); }
          const total = Math.round(items.reduce((s: number, i: any) => s + i.quantity * i.purchase_price, 0) * 100) / 100;
          params.push(total); sets.push(`total_amount = $${params.length}`);
          dataPayload.items = items;
        } else if (invoice_number) {
          params.push(invoice_number); sets.push(`invoice_number = $${params.length}`);
        }
        if (payment_status) { params.push(payment_status); sets.push(`payment_status = $${params.length}`); }
        params.push(JSON.stringify(dataPayload));
        sets.push(`data = data || $${params.length}::jsonb`);

        await c.query(
          `UPDATE giga_cloud.purchases SET ${sets.join(', ')} WHERE shop_id = $1 AND purchase_id = $2`,
          params,
        );

        // Upsert stock for each received item that has a batch reference
        if (Array.isArray(receiveItems)) {
          for (const item of receiveItems) {
            if (!item.medicine_id || !item.quantity) continue;
            // Resolve or create batch
            let batchId: string | null = null;
            if (item.batch_id) {
              batchId = item.batch_id;
            } else if (item.batch_number) {
              const bRow = (await c.query(
                `SELECT batch_id FROM giga_cloud.medicine_batches WHERE shop_id = $1 AND medicine_id = $2 AND batch_number = $3 LIMIT 1`,
                [shopId, item.medicine_id, item.batch_number],
              )).rows[0];
              if (bRow) {
                batchId = bRow.batch_id;
              } else {
                const expiryStatus = computeExpiryStatus(item.expiry_date ?? null);
                batchId = (await c.query(
                  `INSERT INTO giga_cloud.medicine_batches
                     (shop_id, batch_id, medicine_id, batch_number, expiry_date, expiry_status, status, data, source_seq, updated_at)
                   VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, 'active', '{}'::jsonb, $6, now())
                   RETURNING batch_id`,
                  [shopId, item.medicine_id, item.batch_number, item.expiry_date ?? null, expiryStatus, seq],
                )).rows[0].batch_id;
              }
            }
            if (batchId) {
              await c.query(
                `INSERT INTO giga_cloud.stock_levels
                   (shop_id, medicine_id, batch_id, has_baseline, baseline_quantity, delta_since_baseline, last_movement_at)
                 VALUES ($1, $2, $3, true, $4, 0, now())
                 ON CONFLICT (shop_id, medicine_id, batch_id) DO UPDATE
                   SET delta_since_baseline = giga_cloud.stock_levels.delta_since_baseline + $4,
                       last_movement_at = now()`,
                [shopId, item.medicine_id, batchId, item.quantity],
              );
            }
          }
        }
      });
      return { applied: true };
    }

    case 'PURCHASE_CANCEL': {
      const { purchase_id, reason } = payload;
      await withCloud((c) =>
        c.query(
          `UPDATE giga_cloud.purchases
              SET payment_status = 'cancelled',
                  data = data || $3::jsonb,
                  source_seq = $4
            WHERE shop_id = $1 AND purchase_id = $2`,
          [shopId, purchase_id, JSON.stringify({ status: 'cancelled', cancel_reason: reason ?? null }), seq],
        ),
      );
      return { applied: true };
    }

    // ------------------------------------------------------------------ expenses
    case 'EXPENSE_CREATE': {
      const { expense_id, category, description, amount, payment_method, reference, date: expDate } = payload;
      const dataJson = { status: 'posted', reference };
      await withCloud((c) =>
        c.query(
          `INSERT INTO giga_cloud.expenses
             (shop_id, expense_id, category, description, amount, payment_method,
              expense_date, user_id, data, source_seq)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
           ON CONFLICT (shop_id, expense_id) DO NOTHING`,
          [shopId, expense_id, category, description, amount, payment_method ?? 'Cash',
            expDate ?? new Date().toISOString().slice(0, 10), userId, JSON.stringify(dataJson), seq],
        ),
      );
      return { applied: true, result: { expense_id } };
    }

    case 'EXPENSE_UPDATE': {
      const { expense_id, category, description, amount, payment_method, reference, date: expDate } = payload;
      const sets: string[] = [];
      const params: any[] = [shopId, expense_id];
      const patch: Record<string, any> = {};

      if (category !== undefined) { params.push(category); sets.push(`category = $${params.length}`); }
      if (description !== undefined) { params.push(description); sets.push(`description = $${params.length}`); }
      if (amount !== undefined) { params.push(amount); sets.push(`amount = $${params.length}`); }
      if (payment_method !== undefined) { params.push(payment_method); sets.push(`payment_method = $${params.length}`); }
      if (expDate !== undefined) { params.push(expDate); sets.push(`expense_date = $${params.length}`); }
      if (reference !== undefined) patch.reference = reference;

      params.push(JSON.stringify(patch));
      params.push(seq);
      sets.push(`data = data || $${params.length - 1}::jsonb`);
      sets.push(`source_seq = $${params.length}`);

      if (sets.length > 2) {
        await withCloud((c) =>
          c.query(
            `UPDATE giga_cloud.expenses SET ${sets.join(', ')} WHERE shop_id = $1 AND expense_id = $2`,
            params,
          ),
        );
      }
      return { applied: true };
    }

    case 'EXPENSE_VOID': {
      const { expense_id, reason } = payload;
      await withCloud((c) =>
        c.query(
          `UPDATE giga_cloud.expenses
              SET data = data || $3::jsonb, source_seq = $4
            WHERE shop_id = $1 AND expense_id = $2`,
          [shopId, expense_id, JSON.stringify({ status: 'voided', void_reason: reason ?? null, voided_at: new Date().toISOString(), voided_by: userId }), seq],
        ),
      );
      return { applied: true };
    }

    // ------------------------------------------------------------------ returns
    case 'RETURN_APPROVE': {
      const { return_id, restock, disposition, notes, refund_method } = payload;
      await withCloud(async (c) => {
        // Get return data for amounts
        const ret = (await c.query(
          `SELECT data, quantity, requested_refund, medicine_id, batch_id FROM giga_cloud.returns WHERE shop_id = $1 AND return_id = $2`,
          [shopId, return_id],
        )).rows[0];
        const retData = ret?.data ?? {};
        const approvedQty = ret?.quantity ?? retData.quantity ?? retData.approved_quantity ?? null;
        const refundAmt = ret?.requested_refund ?? retData.requested_refund ?? retData.refund_amount ?? null;
        const medId = ret?.medicine_id ?? retData.medicine_id ?? null;
        const bId = ret?.batch_id ?? retData.batch_id ?? null;
        const patchData: Record<string, any> = { notes, refund_method, disposition, reviewed_by_name: 'Administrator' };
        await c.query(
          `UPDATE giga_cloud.returns
              SET status = 'approved',
                  approved_quantity = $3,
                  refund_amount = $4,
                  restocked = $5,
                  reviewed_by = $6,
                  reviewed_at = now(),
                  data = data || $7::jsonb,
                  source_seq = $8,
                  updated_at = now()
            WHERE shop_id = $1 AND return_id = $2`,
          [shopId, return_id, approvedQty, refundAmt, restock, userId, JSON.stringify(patchData), seq],
        );
        // If restocking, add stock back
        if (restock && medId && bId) {
          const qty = Number(approvedQty ?? 0);
          if (qty > 0) {
            await c.query(
              `INSERT INTO giga_cloud.stock_levels
                 (shop_id, medicine_id, batch_id, has_baseline, baseline_quantity, delta_since_baseline, last_movement_at)
               VALUES ($1, $2, $3, true, 0, 0, now())
               ON CONFLICT (shop_id, medicine_id, batch_id) DO UPDATE
                 SET delta_since_baseline = giga_cloud.stock_levels.delta_since_baseline + $4,
                     last_movement_at = now()`,
              [shopId, medId, bId, qty],
            );
          }
        }
      });
      return { applied: true };
    }

    case 'RETURN_REJECT': {
      const { return_id, reason } = payload;
      await withCloud((c) =>
        c.query(
          `UPDATE giga_cloud.returns
              SET status = 'rejected', reviewed_by = $3, reviewed_at = now(),
                  data = data || $4::jsonb, source_seq = $5, updated_at = now()
            WHERE shop_id = $1 AND return_id = $2`,
          [shopId, return_id, userId, JSON.stringify({ reject_reason: reason ?? null }), seq],
        ),
      );
      return { applied: true };
    }

    // ------------------------------------------------------------------ sales
    case 'SALE_VOID': {
      const { sale_id, void_reason, reason } = payload;
      const vReason = void_reason ?? reason ?? null;
      await withCloud((c) =>
        c.query(
          `UPDATE giga_cloud.sales
              SET status = 'voided', void_reason = $3, voided_by = $4,
                  data = data || $5::jsonb, source_seq = $6
            WHERE shop_id = $1 AND sale_id = $2`,
          [shopId, sale_id, vReason, userId,
            JSON.stringify({ void_reason: vReason, voided_by: userId }), seq],
        ),
      );
      return { applied: true };
    }

    // ------------------------------------------------------------------ categories (global, no shop_id)
    case 'CATEGORY_UPSERT': {
      const { name, description } = payload;
      await withCloud((c) =>
        c.query(
          `INSERT INTO giga_cloud.categories (id, name, description, updated_at)
           VALUES (gen_random_uuid(), $1, $2, now())
           ON CONFLICT (name) DO UPDATE
             SET description = EXCLUDED.description, updated_at = now()`,
          [name, description ?? null],
        ),
      );
      return { applied: true };
    }

    // ------------------------------------------------------------------ shop settings
    case 'SETTINGS_UPDATE': {
      const { ...settings } = payload;
      // Remove known-non-settings fields
      delete settings.reason;
      await withCloud((c) =>
        c.query(
          `UPDATE giga_cloud.shops SET data = data || $2::jsonb WHERE shop_id = $1`,
          [shopId, JSON.stringify(settings)],
        ),
      );
      return { applied: true };
    }

    // ------------------------------------------------------------------ users
    case 'USER_SET_ACTIVE': {
      const { user_id, active } = payload;
      await withCloud(async (c) => {
        await c.query(
          `UPDATE giga_cloud.users
              SET active = $2, source_seq = $4, updated_at = now()
            WHERE user_id = $1 AND shop_id = $3`,
          [user_id, active, shopId, seq],
        );
        await c.query(
          `UPDATE giga_cloud.online_users
              SET active = $2, token_version = token_version + CASE WHEN $2 THEN 0 ELSE 1 END, updated_at = now()
            WHERE (id = $1 OR local_user_id = $1) AND (shop_id = $3 OR shop_id IS NULL)`,
          [user_id, active, shopId],
        );
      });
      return { applied: true };
    }

    case 'USER_ROLE_UPDATE': {
      const { user_id, role } = payload;
      await withCloud(async (c) => {
        await c.query(
          `UPDATE giga_cloud.users
              SET role = $2, source_seq = $4, updated_at = now()
            WHERE user_id = $1 AND shop_id = $3`,
          [user_id, role, shopId, seq],
        );
        await c.query(
          `UPDATE giga_cloud.online_users
              SET role = $2, token_version = token_version + CASE WHEN role = 'ADMIN' AND $2 <> 'ADMIN' THEN 1 ELSE 0 END, updated_at = now()
            WHERE (id = $1 OR local_user_id = $1) AND (shop_id = $3 OR shop_id IS NULL)`,
          [user_id, role, shopId],
        );
      });
      return { applied: true };
    }

    case 'USER_PROFILE_UPDATE': {
      const { user_id, name, username, email } = payload;
      const sets: string[] = [];
      const params: any[] = [shopId, user_id];
      if (name !== undefined) { params.push(name); sets.push(`name = $${params.length}`); }
      if (username !== undefined) { params.push(username); sets.push(`username = $${params.length}`); }
      if (email !== undefined) { params.push(email); sets.push(`email = $${params.length}`); }

      await withCloud(async (c) => {
        if (sets.length > 0) {
          params.push(seq);
          sets.push(`source_seq = $${params.length}`);
          sets.push(`updated_at = now()`);
          await c.query(
            `UPDATE giga_cloud.users SET ${sets.join(', ')} WHERE shop_id = $1 AND user_id = $2`,
            params,
          );
        }
        const oSets: string[] = ['updated_at = now()'];
        const oParams: any[] = [user_id, shopId];
        if (name !== undefined) { oParams.push(name); oSets.push(`name = $${oParams.length}`); }
        if (username !== undefined) { oParams.push(username); oSets.push(`username = $${oParams.length}`); }
        if (email !== undefined) { oParams.push(email); oSets.push(`email = $${oParams.length}`); }
        await c.query(
          `UPDATE giga_cloud.online_users SET ${oSets.join(', ')} WHERE (id = $1 OR local_user_id = $1) AND (shop_id = $2 OR shop_id IS NULL)`,
          oParams,
        );
      });
      return { applied: true };
    }

    case 'USER_SESSION_REVOKE': {
      const { user_id } = payload;
      const revokedAt = new Date().toISOString();
      await withCloud(async (c) => {
        await c.query(
          `UPDATE giga_cloud.online_users
              SET token_version = token_version + 1, updated_at = now()
            WHERE (id = $1 OR local_user_id = $1)`,
          [user_id],
        );
        await c.query(
          `UPDATE giga_cloud.users
              SET data = data || $2::jsonb, source_seq = $3, updated_at = now()
            WHERE user_id = $1 AND shop_id = $4`,
          [user_id, JSON.stringify({ session_revoked_at: revokedAt }), seq, shopId],
        );
      });
      return { applied: true };
    }

    // ------------------------------------------------------------------ cashier shifts
    case 'SHIFT_REVIEW': {
      const { shift_id, notes } = payload;
      await withCloud((c) =>
        c.query(
          `UPDATE giga_cloud.cashier_shifts
              SET status = 'REVIEWED', reviewed_at = now(),
                  data = data || $3::jsonb, source_seq = $4, updated_at = now()
            WHERE shop_id = $1 AND shift_id = $2`,
          [shopId, shift_id, JSON.stringify({ reviewed_by: userId, review_notes: notes ?? null }), seq],
        ),
      );
      return { applied: true };
    }

    // ------------------------------------------------------------------ no-ops for online-only mode
    case 'APP_UPDATE_APPROVE':
    case 'SYNC_RETRY_FAILED': {
      return { applied: true };
    }

    default: {
      throw new Error(`applyCommandDirect: unhandled command type "${type}"`);
    }
  }
}
