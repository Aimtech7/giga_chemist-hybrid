import crypto from 'crypto';

// Deterministic UUID generation using MD5
const NAMESPACE_GIGA_CHEMIST = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export function generateDeterministicUuid(namespace: string, key: string): string {
  const hash = crypto.createHash('md5').update(`${namespace}:${key}`).digest('hex');
  // Format as UUID: 8-4-4-4-12
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '4' + hash.substring(13, 16), // version 4
    ((parseInt(hash.substring(16, 18), 16) & 0x3f) | 0x80).toString(16) + hash.substring(18, 20), // variant RFC4122
    hash.substring(20, 32),
  ].join('-');
}

export interface LegacyMigrationMapRecord {
  source_system: string;
  source_table: string;
  source_id: string;
  target_table: string;
  target_id: string;
  metadata?: any;
}

export interface TransformedData {
  branchId: string;
  deviceId: string;
  settings: Record<string, any>;
  categories: Array<{
    id: string;
    name: string;
    description: string;
  }>;
  suppliers: Array<{
    id: string;
    name: string;
    contact_person: string | null;
    phone: string;
    email: string | null;
    address: string | null;
    tax_pin: string | null;
    status: string;
  }>;
  customers: Array<{
    id: string;
    branch_id: string;
    name: string;
    phone: string | null;
    email: string | null;
    address: string | null;
    notes: string | null;
  }>;
  users: Array<{
    id: string;
    branch_id: string;
    name: string;
    email: string;
    role: string;
    phone: string | null;
    active: boolean;
    password_hash: string;
    pin_hash: string;
  }>;
  medicines: Array<{
    id: string;
    branch_id: string;
    name: string;
    generic_name: string;
    brand_name: string | null;
    sku: string;
    barcode: string;
    category_id: string | null;
    medicine_type: string | null;
    dosage_strength: string;
    dosage_form: string;
    manufacturer: string | null;
    description: string | null;
    purchase_price: number;
    selling_price: number;
    current_stock: number;
    reorder_level: number;
    unit: string;
    status: string;
  }>;
  batches: Array<{
    id: string;
    branch_id: string;
    medicine_id: string;
    batch_number: string;
    supplier_id: string | null;
    quantity_received: number;
    quantity_available: number;
    purchase_price: number;
    manufacturing_date: string | null;
    expiry_date: string | null;
    received_date: string | null;
    expiry_status: string;
    notes: string | null;
    status: string;
  }>;
  purchases: Array<{
    id: string;
    branch_id: string;
    order_number: string;
    invoice_number: string;
    supplier_id: string;
    order_date: string;
    received_date: string;
    status: string;
    total_amount: number;
    payment_status: string;
    notes: string | null;
    created_by: string;
  }>;
  purchaseItems: Array<{
    id: string;
    purchase_id: string;
    medicine_id: string;
    batch_number: string;
    manufacturing_date: string | null;
    expiry_date: string | null;
    quantity: number;
    purchase_price: number;
    total: number;
  }>;
  sales: Array<{
    id: string;
    branch_id: string;
    sale_number: string;
    receipt_number: string;
    cashier_id: string;
    customer_id: string | null;
    device_id: string;
    date: string;
    time: string;
    subtotal: number;
    discount_total: number;
    tax_total: number;
    total: number;
    cost_total: number;
    gross_profit: number;
    payment_method: string;
    payment_reference: string | null;
    amount_received: number;
    change_given: number;
    status: string;
    idempotency_key: string;
    sync_status: string;
    created_at: string;
  }>;
  saleItems: Array<{
    id: string;
    sale_id: string;
    medicine_id: string;
    batch_id: string;
    batch_number: string;
    expiry_date: string | null;
    quantity: number;
    unit_price: number;
    discount: number;
    cost_price_snapshot: number;
    total: number;
  }>;
  payments: Array<{
    id: string;
    sale_id: string;
    method: string;
    amount: number;
    reference: string | null;
    created_at: string;
  }>;
  movements: Array<{
    id: string;
    branch_id: string;
    medicine_id: string;
    batch_id: string;
    previous_quantity: number;
    adjustment_quantity: number;
    new_quantity: number;
    movement_type: string;
    reference_id: string;
    notes: string;
    user_id: string;
    device_id: string;
    timestamp: number;
    created_at: string;
  }>;
  migrationMap: LegacyMigrationMapRecord[];
}

export const DEFAULT_BRANCH_ID = '00000000-0000-0000-0000-000000000001';
export const DEFAULT_DEVICE_ID = 'POS-LEGACY-MIGRATED';
