import Dexie, { type Table } from 'dexie';
import type {
  Medicine,
  MedicineBatch,
  InventoryMovement,
  Sale,
  CustomerReturn,
  Supplier,
  Purchase,
  Customer,
  Expense,
  AuditLog,
  PharmacySettings,
  SyncQueueItem,
  DeviceInfo,
  HeldSale,
  Category,
} from '../types';

export class GigaChemistDB extends Dexie {
  medicines!: Table<Medicine, string>;
  medicine_batches!: Table<MedicineBatch, string>;
  inventory_movements!: Table<InventoryMovement, string>;
  sales!: Table<Sale, string>;
  held_sales!: Table<HeldSale, string>;
  customer_returns!: Table<CustomerReturn, string>;
  suppliers!: Table<Supplier, string>;
  purchases!: Table<Purchase, string>;
  customers!: Table<Customer, string>;
  expenses!: Table<Expense, string>;
  audit_logs!: Table<AuditLog, string>;
  pending_sync!: Table<SyncQueueItem, string>;
  devices!: Table<DeviceInfo, string>;
  settings!: Table<{ key: string; value: any }, string>;
  sync_metadata!: Table<{ key: string; value: any }, string>;
  meta!: Table<{ key: string; value: any }, string>;
  categories!: Table<Category, string>;

  constructor() {
    super('GigaChemistDB');
    this.version(1).stores({
      medicines: 'id, name, generic_name, barcode, sku, category, status, version',
      medicine_batches: 'id, medicine_id, batch_number, expiry_date, status, quantity_available',
      inventory_movements: 'id, medicine_id, batch_id, date, timestamp, reason',
      sales: 'id, sale_number, receipt_number, timestamp, cashier_id, status, sync_status, idempotency_key',
      held_sales: 'id, held_at',
      customer_returns: 'id, sale_id, receipt_number, date, sync_status',
      suppliers: 'id, name, status',
      purchases: 'id, order_number, invoice_number, status, sync_status',
      customers: 'id, name, phone',
      expenses: 'id, category, date, sync_status',
      audit_logs: 'id, user_id, action, entity, timestamp',
      pending_sync: 'id, local_id, entity_type, operation, sync_status, idempotency_key, created_at',
      devices: 'id, name, last_seen',
      settings: 'key',
      sync_metadata: 'key',
      meta: 'key',
    });
    this.version(2).stores({
      medicines: 'id, name, generic_name, barcode, sku, category, status, version',
      medicine_batches: 'id, medicine_id, batch_number, expiry_date, status, quantity_available',
      inventory_movements: 'id, medicine_id, batch_id, date, timestamp, reason',
      sales: 'id, sale_number, receipt_number, timestamp, cashier_id, status, sync_status, idempotency_key',
      held_sales: 'id, held_at',
      customer_returns: 'id, sale_id, receipt_number, date, sync_status',
      suppliers: 'id, name, status',
      purchases: 'id, order_number, invoice_number, status, sync_status',
      customers: 'id, name, phone',
      expenses: 'id, category, date, sync_status',
      audit_logs: 'id, user_id, action, entity, timestamp',
      pending_sync: 'id, local_id, entity_type, operation, sync_status, idempotency_key, created_at',
      devices: 'id, name, last_seen',
      settings: 'key',
      sync_metadata: 'key',
      meta: 'key',
      categories: 'id, name',
    });
  }
}

export const db = new GigaChemistDB();

export const DEFAULT_SETTINGS: PharmacySettings = {
  pharmacy_name: 'GIGA CHEMIST',
  tagline: 'Healthcare & Pharmaceutical Dispensing Centre',
  address: 'Commercial Street, Kitale, Kenya',
  phone: '+254 700 123 456',
  email: 'orders@gigachemist.co.ke',
  currency: 'KES',
  tax_rate: 0,
  tax_enabled: false,
  receipt_header: 'GIGA CHEMIST\nKitale, Kenya\nOfficial Dispensing Receipt',
  receipt_footer: 'Thank you for choosing GIGA CHEMIST!\nMedicines dispensed correctly cannot be returned.\nGet well soon.',
  printer_type: '80mm',
  auto_print_receipt: true,
  low_stock_threshold: 20,
  expiry_warning_days: 90,
  require_prescription_warning: true,
  allow_walk_in: true,
  version: '1.0.0-pwa',
  updated_at: new Date().toISOString(),
};

export async function getSettings(): Promise<PharmacySettings> {
  const record = await db.settings.get('pharmacy_settings');
  if (record && record.value) {
    return record.value;
  }
  await db.settings.put({ key: 'pharmacy_settings', value: DEFAULT_SETTINGS });
  return DEFAULT_SETTINGS;
}

export async function saveSettings(settings: PharmacySettings): Promise<void> {
  await db.settings.put({ key: 'pharmacy_settings', value: settings });
}

export { getDeviceId } from '../services/device';

/**
 * Clears this browser's cached copy of server data so it can be re-hydrated from PostgreSQL.
 * Keeps local-only state: held (parked) sales, settings, device identity, metadata and any
 * unsent queue items. Server data is never touched.
 */
export async function clearCachedServerData(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.medicines,
      db.medicine_batches,
      db.inventory_movements,
      db.sales,
      db.customer_returns,
      db.suppliers,
      db.purchases,
      db.customers,
      db.expenses,
      db.audit_logs,
      db.categories,
    ],
    async () => {
      await Promise.all([
        db.medicines.clear(),
        db.medicine_batches.clear(),
        db.inventory_movements.clear(),
        db.sales.clear(),
        db.customer_returns.clear(),
        db.suppliers.clear(),
        db.purchases.clear(),
        db.customers.clear(),
        db.expenses.clear(),
        db.audit_logs.clear(),
        db.categories.clear(),
      ]);
    }
  );
}
