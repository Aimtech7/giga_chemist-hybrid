export type UserRole = 'ADMIN' | 'MANAGER' | 'CASHIER';

export type PermissionKey =
  | 'medicine.create'
  | 'medicine.update'
  | 'medicine.delete'
  | 'medicine.change_price'
  | 'medicine.view'
  | 'inventory.view'
  | 'inventory.adjust'
  | 'stock.receive'
  | 'sales.create'
  | 'sales.view'
  | 'sales.void'
  | 'reports.view'
  | 'users.manage'
  | 'settings.manage'
  | 'audit.view'
  | 'returns.process'
  | 'returns.request'
  | 'customers.manage'
  | 'expenses.manage';

export interface User {
  id: string;
  branch_id?: string;
  name: string;
  email: string;
  /** Optional login name (lower-case), alternative to the email at sign-in. */
  username?: string;
  role: UserRole;
  phone?: string;
  active: boolean;
  created_at: string;
  updated_at?: string;
  last_login?: string;
}

export type NetworkState =
  | 'ONLINE_SYNCED'
  | 'ONLINE_PENDING'
  | 'OFFLINE'
  | 'SYNCING'
  | 'SYNC_ERROR';

export interface DeviceInfo {
  id: string; // e.g. 'POS-KITALE-01-UUID'
  name: string;
  device_type: 'desktop' | 'tablet' | 'mobile';
  app_version: string;
  first_registered: string;
  last_seen: string;
  last_synced_at?: string;
  current_user_id?: string;
  branch_id?: string;
}

export type SyncOperation = 'CREATE' | 'UPDATE' | 'DELETE' | 'STOCK_MOVEMENT';
export type SyncEntityType = 'sale' | 'movement' | 'return' | 'expense' | 'customer';
export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'failed' | 'conflict';

export interface SyncQueueItem {
  id: string;
  local_id: string;
  server_id?: string;
  entity_type: SyncEntityType;
  operation: SyncOperation;
  payload: any;
  device_id: string;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  version: number;
  sync_status: SyncStatus;
  retry_count: number;
  last_attempt?: number;
  error_message?: string;
}

export type DosageForm =
  | 'Tablet'
  | 'Capsule'
  | 'Syrup'
  | 'Suspension'
  | 'Injection'
  | 'Cream'
  | 'Ointment'
  | 'Drops'
  | 'Inhaler'
  | 'Powder'
  | 'Suppository'
  | 'Solution'
  | 'Other';

export interface Medicine {
  id: string;
  branch_id?: string;
  name: string;
  generic_name: string;
  brand_name: string;
  sku: string;
  barcode: string;
  category: string;
  medicine_type: string;
  dosage_strength: string;
  dosage_form: DosageForm;
  manufacturer: string;
  description: string;
  purchase_price: number;
  selling_price: number;
  /** Wholesale price; null/undefined = no wholesale price set for this medicine. */
  wholesale_price?: number | null;
  min_selling_price?: number;
  current_stock: number;
  reorder_level: number;
  unit: string;
  prescription_required: boolean;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  version: number;
}

export interface MedicineBatch {
  id: string;
  branch_id?: string;
  medicine_id: string;
  medicine_name: string;
  batch_number: string;
  supplier_id: string;
  supplier_name: string;
  quantity_received: number;
  quantity_available: number;
  purchase_price: number;
  selling_price_override?: number;
  manufacturing_date: string;
  expiry_date: string;
  expiry_status?: 'KNOWN' | 'UNKNOWN' | 'EXPIRED';
  received_date: string;
  purchase_invoice: string;
  created_by: string;
  created_at: string;
  status: 'active' | 'quarantined' | 'recalled' | 'exhausted';
}

export type MovementReason =
  | 'sale'
  | 'purchase_receipt'
  | 'customer_return'
  | 'supplier_return'
  | 'stock_adjustment'
  | 'damage'
  | 'expiry'
  | 'loss'
  | 'correction'
  | 'PHYSICAL_STOCK_COUNT';

export interface InventoryMovement {
  id: string;
  branch_id?: string;
  medicine_id: string;
  medicine_name: string;
  batch_id: string;
  batch_number: string;
  previous_quantity: number;
  adjustment_quantity: number;
  new_quantity: number;
  movement_type?: string;
  reason: MovementReason;
  reference_id?: string;
  notes?: string;
  user_id: string;
  user_name: string;
  date: string;
  device_id: string;
  timestamp: number;
}

/** Which price list a sale line used. NULL on legacy (pre-wholesale) sales = retail. */
export type PriceMode = 'RETAIL' | 'WHOLESALE';

export type PaymentMethod = 'Cash' | 'M-Pesa' | 'Card' | 'Bank' | 'Mixed';

export interface SplitPayment {
  method: 'Cash' | 'M-Pesa' | 'Card' | 'Bank';
  amount: number;
  reference?: string;
}

export interface CartItem {
  medicine: Medicine;
  quantity: number;
  unit_price: number;
  /** Price list actually applied to this line. */
  price_mode: PriceMode;
  /** WHOLESALE cart but this medicine has no wholesale price: retail was explicitly confirmed. */
  retail_fallback?: boolean;
  discount_percent: number;
  allocated_batches: {
    batch_id: string;
    batch_number: string;
    expiry_date: string;
    quantity: number;
    cost_price: number;
  }[];
}

export interface SaleItem {
  /** sale_items.id (server) */
  id?: string;
  medicine_id: string;
  medicine_name: string;
  generic_name: string;
  batch_id: string;
  batch_number: string;
  expiry_date: string;
  quantity: number;
  unit_price: number;
  discount: number;
  cost_price_snapshot: number;
  total: number;
  price_mode?: PriceMode | null;
}

export type SaleStatus = 'completed' | 'held' | 'returned' | 'partially_returned' | 'voided';

export interface Sale {
  id: string;
  server_id?: string;
  branch_id?: string;
  sale_number: string;
  receipt_number: string;
  date: string;
  time: string;
  timestamp: number;
  cashier_id: string;
  cashier_name: string;
  customer_id?: string;
  customer_name?: string;
  customer_phone?: string;
  device_id: string;
  items: SaleItem[];
  /** Sale-level pricing mode selected at the till (null on legacy sales). */
  price_mode?: PriceMode | null;
  subtotal: number;
  discount_percent?: number;
  discount_total: number;
  tax_total: number;
  total: number;
  cost_total: number;
  gross_profit: number;
  payment_method: PaymentMethod;
  payment_reference?: string;
  amount_received: number;
  change_given: number;
  split_payments?: SplitPayment[];
  status: SaleStatus;
  void_reason?: string;
  voided_by?: string;
  sync_status: SyncStatus;
  retry_count: number;
  last_sync_attempt?: number;
  idempotency_key: string;
  /** Quantities/amounts already returned per medicine+batch (server). */
  returned_items?: { medicine_id: string; batch_id: string; quantity: number; refunded: number }[];
}

export type ReturnAction = 'return_to_stock' | 'damaged' | 'quarantine' | 'dispose';

export interface PurchaseItem {
  medicine_id: string;
  medicine_name: string;
  batch_number: string;
  manufacturing_date: string;
  expiry_date: string;
  quantity: number;
  purchase_price: number;
  selling_price_override?: number;
  total: number;
}

export interface Purchase {
  id: string;
  branch_id?: string;
  order_number: string;
  invoice_number: string;
  supplier_id: string;
  supplier_name: string;
  order_date: string;
  received_date?: string;
  status: 'pending' | 'received' | 'cancelled';
  items: PurchaseItem[];
  total_amount: number;
  payment_status: 'paid' | 'partial' | 'unpaid';
  notes?: string;
  created_by: string;
  created_at: string;
  sync_status: SyncStatus;
}

export interface HeldSale {
  id: string;
  held_at: number;
  customer_name?: string;
  cashier_name: string;
  items: CartItem[];
  subtotal: number;
  note?: string;
}

export interface SyncPayload {
  device_id: string;
  sales: Sale[];
  movements: InventoryMovement[];
  returns: CustomerReturn[];
  expenses: Expense[];
}

export interface SyncResponse {
  success: boolean;
  synced_sale_ids: string[];
  synced_movement_ids: string[];
  synced_return_ids: string[];
  synced_expense_ids: string[];
  authoritative_medicines: Medicine[];
  authoritative_batches: MedicineBatch[];
  authoritative_settings: PharmacySettings;
  server_timestamp: number;
}

export interface CustomerReturn {
  id: string;
  branch_id?: string;
  sale_id: string;
  receipt_number: string;
  medicine_id: string;
  medicine_name: string;
  batch_id: string;
  batch_number: string;
  quantity: number;
  unit_price: number;
  discount_amount?: number;
  effective_unit_price?: number;
  refund_amount: number;
  cost_price_snapshot?: number;
  payment_method?: PaymentMethod | string;
  reason: string;
  action: 'return_to_stock' | 'damaged' | 'quarantine' | 'dispose';
  user_id: string;
  user_name: string;
  device_id: string;
  date: string;
  timestamp: number;
  sync_status: SyncStatus;
  idempotency_key?: string;
}

export interface Supplier {
  id: string;
  name: string;
  contact_person: string;
  phone: string;
  email: string;
  address: string;
  tax_pin?: string;
  balance: number;
  status: 'active' | 'inactive';
  created_at: string;
}

export interface Customer {
  id: string;
  branch_id?: string;
  name: string;
  phone: string;
  email?: string;
  address?: string;
  notes?: string;
  credit_balance: number;
  total_spent: number;
  last_visit?: string;
  created_at: string;
}

export interface Expense {
  id: string;
  branch_id?: string;
  category: 'Rent' | 'Electricity' | 'Internet' | 'Salaries' | 'Transport' | 'Maintenance' | 'Supplies' | 'Miscellaneous';
  description: string;
  amount: number;
  payment_method: string;
  reference?: string;
  date: string;
  user_id: string;
  user_name: string;
  created_at: string;
  sync_status: SyncStatus;
}

export interface AuditLog {
  id: string;
  branch_id?: string;
  user_id: string;
  user_name: string;
  role: UserRole;
  action: string;
  entity: string;
  entity_id: string;
  previous_value?: string;
  new_value?: string;
  device_id: string;
  timestamp: number;
  date: string;
}

export interface Category {
  id: string;
  name: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
}

export interface PaginatedSalesResponse {
  sales: Sale[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface PharmacySettings {
  pharmacy_name: string;
  tagline: string;
  address: string;
  phone: string;
  email: string;
  currency: string;
  currency_symbol?: string;
  tax_rate: number;
  tax_enabled: boolean;
  receipt_header: string;
  receipt_footer: string;
  printer_type: '58mm' | '80mm';
  auto_print_receipt: boolean;
  low_stock_threshold: number;
  expiry_warning_days: number;
  require_prescription_warning: boolean;
  allow_walk_in: boolean;
  version: string;
  updated_at: string;
}
