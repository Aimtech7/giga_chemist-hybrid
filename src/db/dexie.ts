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

// Seed initial realistic data if DB is empty
export async function seedInitialData(force = false): Promise<void> {
  const count = await db.medicines.count();
  if (count > 0 && !force) {
    return;
  }

  const todayStr = new Date().toISOString().split('T')[0];
  const datePlusDays = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  };

  const initialSuppliers: Supplier[] = [
    {
      id: 'sup-001',
      name: 'Harleys Pharmaceuticals Ltd',
      contact_person: 'David Kamau',
      phone: '+254 722 100 200',
      email: 'orders@harleys.co.ke',
      address: 'Industrial Area, Commercial Street, Nairobi',
      tax_pin: 'P051234567A',
      balance: 0,
      status: 'active',
      created_at: todayStr,
    },
    {
      id: 'sup-002',
      name: 'Cosmos Limited',
      contact_person: 'Sarah Njoroge',
      phone: '+254 733 300 400',
      email: 'sales@cosmos-pharm.com',
      address: 'Rangwe Road, Off Lunga Lunga, Nairobi',
      tax_pin: 'P051987654B',
      balance: 0,
      status: 'active',
      created_at: todayStr,
    },
    {
      id: 'sup-003',
      name: 'Laboratory & Allied Ltd',
      contact_person: 'Michael Ochieng',
      phone: '+254 711 500 600',
      email: 'supply@laballied.com',
      address: 'Mombasa Road, Nairobi',
      tax_pin: 'P051654321C',
      balance: 0,
      status: 'active',
      created_at: todayStr,
    },
  ];

  const initialMedicines: Medicine[] = [
    {
      id: 'med-001',
      name: 'Paracetamol 500mg',
      generic_name: 'Paracetamol (Acetaminophen)',
      brand_name: 'Panadol',
      sku: 'MED-PCM-500',
      barcode: '616400010012',
      category: 'Analgesics & Antipyretics',
      medicine_type: 'Pain Relief & Fever',
      dosage_strength: '500mg',
      dosage_form: 'Tablet',
      manufacturer: 'GlaxoSmithKline',
      description: 'Effective relief from headache, fever, muscle aches, and pain.',
      purchase_price: 3.5,
      selling_price: 10.0,
      wholesale_price: 8.0,
      min_selling_price: 7.0,
      current_stock: 350,
      reorder_level: 50,
      unit: 'Strips (10 tabs)',
      prescription_required: false,
      status: 'active',
      created_at: todayStr,
      updated_at: todayStr,
      created_by: 'Admin',
      updated_by: 'Admin',
      version: 1,
    },
    {
      id: 'med-002',
      name: 'Amoxicillin 500mg Capsules',
      generic_name: 'Amoxicillin Trihydrate',
      brand_name: 'Amoxil',
      sku: 'MED-AMX-500',
      barcode: '616400010029',
      category: 'Antibiotics',
      medicine_type: 'Penicillin Antibiotic',
      dosage_strength: '500mg',
      dosage_form: 'Capsule',
      manufacturer: 'Cosmos Limited',
      description: 'Broad-spectrum antibiotic for bacterial infections.',
      purchase_price: 7.0,
      selling_price: 15.0,
      wholesale_price: 12.0,
      min_selling_price: 10.0,
      current_stock: 180,
      reorder_level: 40,
      unit: 'Strips (10 caps)',
      prescription_required: true,
      status: 'active',
      created_at: todayStr,
      updated_at: todayStr,
      created_by: 'Admin',
      updated_by: 'Admin',
      version: 1,
    },
    {
      id: 'med-003',
      name: 'Cetirizine 10mg Tablets',
      generic_name: 'Cetirizine Hydrochloride',
      brand_name: 'Zyrtec',
      sku: 'MED-CTZ-010',
      barcode: '616400010036',
      category: 'Antihistamines',
      medicine_type: 'Allergy Relief',
      dosage_strength: '10mg',
      dosage_form: 'Tablet',
      manufacturer: 'Harleys Pharmaceuticals Ltd',
      description: 'Second-generation antihistamine for seasonal allergies.',
      purchase_price: 5.0,
      selling_price: 15.0,
      wholesale_price: 11.0,
      min_selling_price: 10.0,
      current_stock: 120,
      reorder_level: 30,
      unit: 'Strips (10 tabs)',
      prescription_required: false,
      status: 'active',
      created_at: todayStr,
      updated_at: todayStr,
      created_by: 'Admin',
      updated_by: 'Admin',
      version: 1,
    },
  ];

  const initialBatches: MedicineBatch[] = [
    {
      id: 'bat-001',
      medicine_id: 'med-001',
      medicine_name: 'Paracetamol 500mg',
      batch_number: 'PCM-2601-A',
      supplier_id: 'sup-001',
      supplier_name: 'Harleys Pharmaceuticals Ltd',
      quantity_received: 200,
      quantity_available: 150,
      purchase_price: 3.5,
      manufacturing_date: '2025-06-01',
      expiry_date: datePlusDays(180),
      received_date: '2025-07-10',
      purchase_invoice: 'INV-HRL-8901',
      created_by: 'Admin',
      created_at: todayStr,
      status: 'active',
    },
    {
      id: 'bat-002',
      medicine_id: 'med-001',
      medicine_name: 'Paracetamol 500mg',
      batch_number: 'PCM-2602-B',
      supplier_id: 'sup-001',
      supplier_name: 'Harleys Pharmaceuticals Ltd',
      quantity_received: 200,
      quantity_available: 200,
      purchase_price: 3.5,
      manufacturing_date: '2026-01-15',
      expiry_date: datePlusDays(540),
      received_date: '2026-02-01',
      purchase_invoice: 'INV-HRL-9420',
      created_by: 'Admin',
      created_at: todayStr,
      status: 'active',
    },
    {
      id: 'bat-003',
      medicine_id: 'med-002',
      medicine_name: 'Amoxicillin 500mg Capsules',
      batch_number: 'AMX-2509-EXP',
      supplier_id: 'sup-002',
      supplier_name: 'Cosmos Limited',
      quantity_received: 50,
      quantity_available: 30,
      purchase_price: 7.0,
      manufacturing_date: '2024-04-01',
      expiry_date: datePlusDays(22),
      received_date: '2024-05-10',
      purchase_invoice: 'INV-CSM-4412',
      created_by: 'Admin',
      created_at: todayStr,
      status: 'active',
    },
  ];

  const initialCustomers: Customer[] = [
    {
      id: 'cus-001',
      name: 'Walk-in Customer',
      phone: '0700000000',
      email: '',
      address: 'Kitale Town',
      credit_balance: 0,
      total_spent: 0,
      created_at: todayStr,
    },
  ];

  await db.transaction('rw', [
    db.suppliers,
    db.medicines,
    db.medicine_batches,
    db.customers,
    db.settings,
    db.audit_logs,
  ], async () => {
    if (force) {
      await db.suppliers.clear();
      await db.medicines.clear();
      await db.medicine_batches.clear();
      await db.customers.clear();
      await db.audit_logs.clear();
    }
    await db.suppliers.bulkPut(initialSuppliers);
    await db.medicines.bulkPut(initialMedicines);
    await db.medicine_batches.bulkPut(initialBatches);
    await db.customers.bulkPut(initialCustomers);
    await db.settings.put({ key: 'pharmacy_settings', value: DEFAULT_SETTINGS });
  });
}
