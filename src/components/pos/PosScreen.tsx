import React, { useState, useEffect, useRef } from 'react';
import {
  Search,
  Barcode,
  ShoppingCart,
  Trash2,
  Plus,
  Minus,
  AlertTriangle,
  User,
  Clock,
  Check,
  CreditCard,
  Tag,
  ShieldAlert,
  ArrowRight,
  Filter,
  CheckCircle2,
} from 'lucide-react';
import { db, getDeviceId } from '../../db/dexie';
import { allocateFefo, executeStockMovement } from '../../services/inventoryEngine';
import { isExpired, isExpiringSoon, normalizeExpiryDate } from '../../utils/expiry';
import { searchMedicines } from '../../services/searchEngine';
import { useBarcodeScanner } from '../../hooks/useBarcodeScanner';
import { PaymentModal } from './PaymentModal';
import { HeldSalesModal } from './HeldSalesModal';
import { ReceiptModal } from './ReceiptModal';
import { runSync } from '../../services/syncEngine';
import { canViewCostData, isCashier } from '../../services/permissions';
import type {
  Medicine,
  MedicineBatch,
  CartItem,
  Customer,
  HeldSale,
  Sale,
  SaleItem,
  PharmacySettings,
  User as UserType,
  PaymentMethod,
  SplitPayment,
} from '../../types';

interface PosScreenProps {
  currentUser: UserType | null;
  settings: PharmacySettings;
}

export const PosScreen: React.FC<PosScreenProps> = ({ currentUser, settings }) => {
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [batches, setBatches] = useState<MedicineBatch[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [heldSales, setHeldSales] = useState<HeldSale[]>([]);

  // Search & Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [selectedResultIndex, setSelectedResultIndex] = useState<number>(0);

  // Active Cart State
  const [cart, setCart] = useState<CartItem[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [discountPercent, setDiscountPercent] = useState<number>(0);
  const [discountError, setDiscountError] = useState<string | null>(null);
  const [cartNote, setCartNote] = useState<string>('');

  // Modals
  const [isPaymentOpen, setIsPaymentOpen] = useState(false);
  const [isHeldOpen, setIsHeldOpen] = useState(false);
  const [completedSale, setCompletedSale] = useState<Sale | null>(null);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);

  // References
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Load active data from Dexie
  const loadData = async () => {
    try {
      const meds = await db.medicines.where('status').equals('active').toArray();
      setMedicines(meds);

      const allBatches = await db.medicine_batches.toArray();
      setBatches(allBatches);

      const custs = await db.customers.toArray();
      setCustomers(custs);
      if (!selectedCustomer && custs.length > 0) {
        setSelectedCustomer(custs[0]); // default to Walk-in
      }

      const held = await db.held_sales.toArray();
      setHeldSales(held);
    } catch (e) {
      console.error('Error loading POS data:', e);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Universal Search Integration with Category Filter
  const searchedMedicines = React.useMemo(() => {
    let pool = medicines;
    if (selectedCategory !== 'All') {
      pool = pool.filter((m) => m.category === selectedCategory);
    }
    return searchMedicines(searchQuery, pool);
  }, [medicines, selectedCategory, searchQuery]);

  // Reset selected result index when search query changes
  useEffect(() => {
    setSelectedResultIndex(0);
  }, [searchQuery, selectedCategory]);

  // Barcode scanner integration (both hardware keyboard emulation and search bar)
  const handleBarcodeScan = async (scannedBarcode: string) => {
    const cleanCode = scannedBarcode.trim();
    if (!cleanCode) return;

    // Search exact barcode first using universal search
    const results = searchMedicines(cleanCode, medicines);
    const exactBarcodeMatch = results.find(
      (m) => m.barcode.toLowerCase() === cleanCode.toLowerCase()
    );

    const target = exactBarcodeMatch || (results.length === 1 ? results[0] : null);

    if (target) {
      if (target.current_stock <= 0) {
        setWarningMessage(`Item "${target.name}" is out of stock / has no sellable batches.`);
        setTimeout(() => setWarningMessage(null), 3000);
      } else {
        await addToCart(target);
        setSearchQuery('');
        searchInputRef.current?.focus();
      }
    } else if (results.length > 1) {
      setSearchQuery(cleanCode);
      searchInputRef.current?.focus();
    } else {
      setWarningMessage(`Barcode / SKU "${cleanCode}" not found in active inventory.`);
      setTimeout(() => setWarningMessage(null), 3000);
    }
  };

  useBarcodeScanner({
    onScan: handleBarcodeScan,
    enabled: !isPaymentOpen && !isHeldOpen && !completedSale,
  });

  // Global Keyboard Shortcuts (F2 search, F4 pay, F8 hold, Escape, Arrow navigation)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (e.key === 'F4') {
        e.preventDefault();
        if (cart.length > 0) setIsPaymentOpen(true);
      } else if (e.key === 'F8') {
        e.preventDefault();
        if (cart.length > 0) handleHoldSale();
      } else if (e.key === 'Escape') {
        if (isPaymentOpen) setIsPaymentOpen(false);
        if (isHeldOpen) setIsHeldOpen(false);
        if (completedSale) {
          setCompletedSale(null);
          searchInputRef.current?.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [cart, isPaymentOpen, isHeldOpen, completedSale]);

  // Add medicine to cart with strict FEFO allocation & expired stock blocking
  const addToCart = async (medicine: Medicine) => {
    const existingIndex = cart.findIndex((i) => i.medicine.id === medicine.id);
    const currentQtyInCart = existingIndex >= 0 ? cart[existingIndex].quantity : 0;
    const requestedQty = currentQtyInCart + 1;

    // Check FEFO availability (strictly active, non-expired batches)
    const fefo = await allocateFefo(medicine.id, requestedQty);

    if (!fefo.possible || fefo.allocations.length === 0) {
      setWarningMessage(
        `Cannot sell ${medicine.name}. Only ${fefo.allocatedTotal} active, non-expired units available.`
      );
      setTimeout(() => setWarningMessage(null), 3500);
      return;
    }

    if (fefo.batchesExpiringSoon.length > 0) {
      setWarningMessage(
        `Notice: ${medicine.name} batch ${fefo.batchesExpiringSoon.join(', ')} expires within 30 days!`
      );
      setTimeout(() => setWarningMessage(null), 4000);
    }

    if (existingIndex >= 0) {
      const updated = [...cart];
      updated[existingIndex].quantity = requestedQty;
      updated[existingIndex].allocated_batches = fefo.allocations;
      setCart(updated);
    } else {
      setCart([
        ...cart,
        {
          medicine,
          quantity: 1,
          unit_price: medicine.selling_price,
          discount_percent: 0,
          allocated_batches: fefo.allocations,
        },
      ]);
    }
  };

  const updateCartQuantity = async (medicineId: string, newQty: number) => {
    if (newQty <= 0) {
      removeFromCart(medicineId);
      return;
    }

    const fefo = await allocateFefo(medicineId, newQty);
    if (!fefo.possible) {
      setWarningMessage(`Maximum available non-expired stock for this item is ${fefo.allocatedTotal}.`);
      setTimeout(() => setWarningMessage(null), 3500);
      newQty = fefo.allocatedTotal;
      if (newQty <= 0) {
        removeFromCart(medicineId);
        return;
      }
    }

    setCart((prev) =>
      prev.map((item) =>
        item.medicine.id === medicineId
          ? { ...item, quantity: newQty, allocated_batches: fefo.allocations }
          : item
      )
    );
  };

  const updateItemDiscount = (medicineId: string, percent: number) => {
    // Role-governed discounts
    const maxDiscount = currentUser?.role === 'ADMIN' ? 100 : currentUser?.role === 'MANAGER' ? 25 : 10;
    const clamped = Math.max(0, Math.min(maxDiscount, percent || 0));

    setCart((prev) =>
      prev.map((item) =>
        item.medicine.id === medicineId ? { ...item, discount_percent: clamped } : item
      )
    );
  };

  const removeFromCart = (medicineId: string) => {
    setCart((prev) => prev.filter((i) => i.medicine.id !== medicineId));
  };

  const handleDiscountChange = (valStr: string) => {
    if (valStr === '') {
      setDiscountPercent(0);
      setDiscountError(null);
      return;
    }
    const val = parseFloat(valStr);
    if (isNaN(val) || val < 0) {
      setDiscountPercent(0);
      setDiscountError(null);
      return;
    }

    const isCashierRole = (currentUser?.role as string) === 'CASHIER' || (currentUser?.role as string) === 'ATTENDANT';
    const maxAllowed = isCashierRole ? 10 : 100;

    if (val > maxAllowed) {
      setDiscountError(isCashierRole ? 'Cashier discount cannot exceed 10%.' : 'Discount cannot exceed 100%.');
      setDiscountPercent(maxAllowed);
    } else {
      setDiscountError(null);
      setDiscountPercent(Math.round(val * 100) / 100);
    }
  };

  const clearCart = () => {
    setCart([]);
    setDiscountPercent(0);
    setDiscountError(null);
    setCartNote('');
    searchInputRef.current?.focus();
  };

  // Financial Calculations avoiding floating point issues
  const subtotal = Math.round(cart.reduce((sum, item) => sum + item.quantity * item.unit_price, 0) * 100) / 100;
  const discountAmount = Math.round(((subtotal * discountPercent) / 100) * 100) / 100;
  const taxableAmount = Math.max(0, Math.round((subtotal - discountAmount) * 100) / 100);
  const taxTotal = settings.tax_enabled ? Math.round(((taxableAmount * settings.tax_rate) / 100) * 100) / 100 : 0;
  const total = Math.round((taxableAmount + taxTotal) * 100) / 100;

  // Hold Sale
  const handleHoldSale = async () => {
    if (cart.length === 0) return;
    const held: HeldSale = {
      id: `hld-${Date.now()}`,
      held_at: Date.now(),
      customer_name: selectedCustomer?.name || 'Walk-in Customer',
      cashier_name: currentUser?.name || 'Cashier',
      items: cart,
      subtotal: total,
      note: cartNote,
    };
    await db.held_sales.put(held);
    setHeldSales(await db.held_sales.toArray());
    clearCart();
    setWarningMessage('Sale placed on hold safely.');
    setTimeout(() => setWarningMessage(null), 2500);
  };

  // Resume Held Sale with FEFO Revalidation
  const handleResumeSale = async (heldSale: HeldSale) => {
    const updatedCart: CartItem[] = [];
    let hadAdjustment = false;

    for (const item of heldSale.items) {
      const fefo = await allocateFefo(item.medicine.id, item.quantity);
      if (fefo.possible) {
        updatedCart.push({
          ...item,
          allocated_batches: fefo.allocations,
        });
      } else if (fefo.allocatedTotal > 0) {
        hadAdjustment = true;
        updatedCart.push({
          ...item,
          quantity: fefo.allocatedTotal,
          allocated_batches: fefo.allocations,
        });
      } else {
        hadAdjustment = true;
      }
    }

    setCart(updatedCart);
    setCartNote(heldSale.note || '');
    await db.held_sales.delete(heldSale.id);
    setHeldSales(await db.held_sales.toArray());
    setIsHeldOpen(false);

    if (hadAdjustment) {
      setWarningMessage('Note: Some held batches were depleted or expired. Cart has been reallocated with available stock.');
      setTimeout(() => setWarningMessage(null), 4000);
    }
  };

  const handleDeleteHeldSale = async (heldId: string) => {
    await db.held_sales.delete(heldId);
    setHeldSales(await db.held_sales.toArray());
  };

  // Complete Sale & Controlled Stock Deduction within an Atomic Dexie Transaction
  const handleCompleteSale = async (paymentData: {
    payment_method: PaymentMethod;
    payment_reference?: string;
    amount_received: number;
    change_given: number;
    split_payments?: SplitPayment[];
  }) => {
    const deviceId = await getDeviceId();
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].substring(0, 5);

    const saleNumber = `GIGA-${now.getFullYear()}${(now.getMonth() + 1)
      .toString()
      .padStart(2, '0')}-${Math.floor(1000 + Math.random() * 9000)}`;
    const receiptNumber = `REC-${Math.floor(100000 + Math.random() * 900000)}`;

    const saleItems: SaleItem[] = [];
    let costTotal = 0;

    // Line items prorated for overall cart discount
    const discountRatio = subtotal > 0 ? (subtotal - discountAmount) / subtotal : 1;

    for (const cartItem of cart) {
      for (const alloc of cartItem.allocated_batches) {
        const itemSubtotal = alloc.quantity * cartItem.unit_price;
        const itemProratedDiscount = Math.round((itemSubtotal * (discountPercent / 100)) * 100) / 100;
        const itemLineTotal = Math.round((itemSubtotal - itemProratedDiscount) * 100) / 100;

        saleItems.push({
          medicine_id: cartItem.medicine.id,
          medicine_name: cartItem.medicine.name,
          generic_name: cartItem.medicine.generic_name,
          batch_id: alloc.batch_id,
          batch_number: alloc.batch_number,
          expiry_date: alloc.expiry_date,
          quantity: alloc.quantity,
          unit_price: cartItem.unit_price,
          discount: itemProratedDiscount,
          cost_price_snapshot: alloc.cost_price,
          total: itemLineTotal,
        });

        costTotal += alloc.quantity * alloc.cost_price;
      }
    }

    const newSale: Sale = {
      id: `sal-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      sale_number: saleNumber,
      receipt_number: receiptNumber,
      date: todayStr,
      time: timeStr,
      timestamp: Date.now(),
      cashier_id: currentUser?.id || 'usr-cashier',
      cashier_name: currentUser?.name || 'Cashier',
      customer_id: selectedCustomer?.id,
      customer_name: selectedCustomer?.name,
      customer_phone: selectedCustomer?.phone,
      device_id: deviceId,
      items: saleItems,
      subtotal,
      discount_percent: discountPercent,
      discount_total: discountAmount,
      tax_total: taxTotal,
      total,
      cost_total: costTotal,
      gross_profit: total - costTotal,
      payment_method: paymentData.payment_method,
      payment_reference: paymentData.payment_reference,
      amount_received: paymentData.amount_received,
      change_given: paymentData.change_given,
      split_payments: paymentData.split_payments,
      status: 'completed',
      sync_status: 'pending',
      retry_count: 0,
      idempotency_key: `IDEMP-${deviceId}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
    };

    try {
      // Atomic Dexie Transaction Covering All Tables
      await db.transaction(
        'rw',
        [
          db.medicines,
          db.medicine_batches,
          db.inventory_movements,
          db.sales,
          db.audit_logs,
          db.customers,
          db.pending_sync,
        ],
        async () => {
          // 1. Revalidate & Deduct Batches
          for (const cartItem of cart) {
            for (const alloc of cartItem.allocated_batches) {
              const batch = await db.medicine_batches.get(alloc.batch_id);
              if (!batch) {
                throw new Error(`Batch ${alloc.batch_number} not found.`);
              }

              if (isExpired(batch.expiry_date, now)) {
                throw new Error(`Batch ${alloc.batch_number} has expired and cannot be dispensed.`);
              }

              const prevBatchQty = batch.quantity_available;
              const newBatchQty = prevBatchQty - alloc.quantity;

              if (newBatchQty < 0) {
                throw new Error(`Insufficient stock in batch ${alloc.batch_number} (requested: ${alloc.quantity}, available: ${prevBatchQty})`);
              }

              batch.quantity_available = newBatchQty;
              if (newBatchQty === 0) {
                batch.status = 'exhausted';
              }
              await db.medicine_batches.put(batch);

              // Record inventory movement
              await db.inventory_movements.put({
                id: `mov-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
                medicine_id: cartItem.medicine.id,
                medicine_name: cartItem.medicine.name,
                batch_id: batch.id,
                batch_number: batch.batch_number,
                previous_quantity: prevBatchQty,
                adjustment_quantity: -alloc.quantity,
                new_quantity: newBatchQty,
                reason: 'sale',
                reference_id: saleNumber,
                notes: `Dispensed at register receipt ${receiptNumber}`,
                user_id: currentUser?.id || 'usr-cashier',
                user_name: currentUser?.name || 'Cashier',
                date: todayStr,
                device_id: deviceId,
                timestamp: Date.now(),
              });
            }

            // Recalculate medicine current_stock
            const medBatches = await db.medicine_batches
              .where('medicine_id')
              .equals(cartItem.medicine.id)
              .toArray();

            const totalAvailable = medBatches
              .filter((b) => b.status === 'active' && !isExpired(b.expiry_date, now))
              .reduce((sum, b) => sum + b.quantity_available, 0);

            const med = await db.medicines.get(cartItem.medicine.id);
            if (med) {
              med.current_stock = totalAvailable;
              med.updated_at = todayStr;
              med.updated_by = currentUser?.name || 'Cashier';
              med.version = (med.version || 1) + 1;
              await db.medicines.put(med);
            }
          }

          // 2. Save sale locally
          await db.sales.put(newSale);

          // 3. Enqueue Canonical Sync Item
          await db.pending_sync.put({
            id: `sync_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            local_id: newSale.id,
            entity_type: 'sale',
            operation: 'CREATE',
            payload: newSale,
            device_id: deviceId,
            idempotency_key: newSale.idempotency_key,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            version: 1,
            sync_status: 'pending',
            retry_count: 0,
          });

          // 4. Update customer total spend if applicable
          if (selectedCustomer && selectedCustomer.id !== 'cus-001') {
            const cust = await db.customers.get(selectedCustomer.id);
            if (cust) {
              cust.total_spent = (cust.total_spent || 0) + total;
              cust.last_visit = todayStr;
              await db.customers.put(cust);
            }
          }
        }
      );

      // Refresh local medicines list & batches
      await loadData();

      // Trigger background sync
      runSync().catch(() => {});

      // Clear cart & trigger receipt view
      clearCart();
      setCompletedSale(newSale);
    } catch (err: any) {
      console.error('Checkout failed, transaction rolled back:', err);
      setWarningMessage(`Checkout failed: ${err?.message || 'Transaction aborted'}. No stock was deducted.`);
      setTimeout(() => setWarningMessage(null), 5000);
    }
  };

  // Helper to determine operational stock status
  const getStockStatus = (med: Medicine) => {
    const now = new Date();
    const medBatches = batches.filter((b) => b.medicine_id === med.id);
    const validBatches = medBatches.filter((b) => b.status === 'active' && !isExpired(b.expiry_date, now) && b.quantity_available > 0);
    const expiredBatches = medBatches.filter((b) => isExpired(b.expiry_date, now) && b.quantity_available > 0);

    if (validBatches.length > 0) {
      if (med.current_stock <= med.reorder_level) {
        return { label: 'Low Stock', className: 'text-amber-700 bg-amber-50 border-amber-200', sellable: true };
      }
      return { label: 'In Stock', className: 'text-emerald-700 bg-emerald-50 border-emerald-200', sellable: true };
    }

    if (expiredBatches.length > 0 && validBatches.length === 0) {
      return { label: 'Expired — Cannot Sell', className: 'text-rose-700 bg-rose-50 border-rose-200', sellable: false };
    }

    return { label: 'Out of Stock', className: 'text-slate-600 bg-slate-100 border-slate-200', sellable: false };
  };

  // Filter categories
  const categories = [
    'All',
    'Analgesics & Antipyretics',
    'Antibiotics',
    'Antihistamines',
    'Antidiabetics',
    'Gastrointestinal',
    'Respiratory',
  ];

  return (
    <div className="flex-1 flex overflow-hidden bg-slate-100">
      {/* LEFT COLUMN: Medicine Catalog & Universal Search */}
      <div className="flex-1 flex flex-col min-w-0 border-r border-slate-200 bg-white">
        {/* Universal Search Bar & Scanner Status */}
        <div className="p-3 bg-white border-b border-slate-200 space-y-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setSelectedResultIndex((prev) => Math.min(searchedMedicines.length - 1, prev + 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setSelectedResultIndex((prev) => Math.max(0, prev - 1));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (searchedMedicines.length > 0) {
                      const target = searchedMedicines[selectedResultIndex] || searchedMedicines[0];
                      const status = getStockStatus(target);
                      if (status.sellable) {
                        addToCart(target);
                        setSearchQuery('');
                      } else {
                        setWarningMessage(`Item "${target.name}" cannot be added (${status.label}).`);
                        setTimeout(() => setWarningMessage(null), 3000);
                      }
                    }
                  }
                }}
                placeholder="Universal Search: scan barcode or type medicine, generic, brand, SKU, strength (e.g. PCM, 500mg, amox)..."
                className="w-full pl-9 pr-12 py-2 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                autoFocus
              />
              <span className="absolute right-2.5 top-2 px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 text-[10px] font-mono font-medium border border-slate-200">
                F2
              </span>
            </div>

            <div
              className="flex items-center gap-1.5 px-3 py-2 rounded bg-slate-50 border border-slate-200 text-slate-700 text-xs shrink-0"
              title="USB Barcode scanner is active and ready"
            >
              <Barcode className="w-4 h-4 text-teal-700" />
              <span className="hidden md:inline font-semibold">Scanner Ready</span>
            </div>
          </div>

          {/* Category Filter Toolbar */}
          <div className="flex items-center gap-1 overflow-x-auto pb-0.5 text-xs">
            {categories.map((cat) => {
              const active = selectedCategory === cat;
              return (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={`px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap transition cursor-pointer ${
                    active
                      ? 'bg-slate-900 text-white font-semibold'
                      : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                  }`}
                >
                  {cat}
                </button>
              );
            })}
          </div>

          {warningMessage && (
            <div className="p-2 rounded bg-amber-50 border border-amber-200 text-amber-900 text-xs flex items-center gap-2 animate-fadeIn">
              <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
              <span>{warningMessage}</span>
            </div>
          )}
        </div>

        {/* Medicines Catalog Grid with Operational Badges */}
        <div className="flex-1 overflow-y-auto p-3">
          {searchedMedicines.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-500 text-center p-6">
              <Search className="w-8 h-8 text-slate-300 mb-2" />
              <p className="text-xs font-semibold text-slate-700">No matching medicines found</p>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Try typing a generic name (e.g. Paracetamol), strength (500mg), or scan a barcode.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              {searchedMedicines.map((med, idx) => {
                const stockStatus = getStockStatus(med);
                const isSelected = idx === selectedResultIndex && searchQuery.trim().length > 0;

                return (
                  <div
                    key={med.id}
                    onClick={() => stockStatus.sellable && addToCart(med)}
                    className={`p-2.5 rounded border text-left flex flex-col justify-between transition select-none ${
                      !stockStatus.sellable
                        ? 'border-slate-200 bg-slate-50 opacity-60 cursor-not-allowed'
                        : isSelected
                        ? 'border-teal-700 ring-1 ring-teal-700 bg-teal-50/20 cursor-pointer shadow-xs'
                        : 'border-slate-200 bg-white hover:border-teal-700 hover:shadow-xs cursor-pointer'
                    }`}
                  >
                    <div>
                      <div className="flex items-start justify-between gap-1 mb-1 text-[10px] text-slate-500">
                        <span className="uppercase font-medium truncate">{med.dosage_form}</span>
                        {med.prescription_required && (
                          <span className="font-bold text-rose-700 bg-rose-50 px-1 rounded border border-rose-200">
                            Rx
                          </span>
                        )}
                      </div>

                      <div className="font-semibold text-xs text-slate-900 line-clamp-1 leading-snug">
                        {med.name}
                      </div>
                      <div className="text-[11px] text-slate-500 truncate">
                        {med.generic_name} {med.dosage_strength && `· ${med.dosage_strength}`}
                      </div>
                      <div className="text-[10px] text-slate-400 font-mono mt-0.5 truncate">
                        {med.barcode || med.sku}
                      </div>
                    </div>

                    <div className="mt-2.5 pt-1.5 border-t border-slate-100 space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <div className="font-bold font-mono text-slate-900">
                          {settings.currency} {med.selling_price.toFixed(2)}
                        </div>

                        <div className="font-mono text-[11px] font-semibold text-slate-700">
                          {med.current_stock} <span className="text-[10px] font-normal text-slate-400">{med.unit}</span>
                        </div>
                      </div>

                      <div className="flex items-center justify-between">
                        <span
                          className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold uppercase tracking-wider ${stockStatus.className}`}
                        >
                          {stockStatus.label}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* RIGHT COLUMN: POS Register Cart & Checkout Tender */}
      <div className="w-96 flex flex-col bg-white border-l border-slate-200 shrink-0">
        {/* Cart Header */}
        <div className="p-3 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShoppingCart className="w-4 h-4 text-teal-400" />
            <span className="font-semibold text-xs tracking-tight">Dispensing Cart</span>
            <span className="text-xs font-mono text-slate-400">({cart.length})</span>
          </div>

          <div className="flex items-center gap-2">
            {heldSales.length > 0 && (
              <button
                onClick={() => setIsHeldOpen(true)}
                className="px-2 py-0.5 rounded bg-amber-700 hover:bg-amber-600 text-white text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                title="View Held Transactions"
              >
                <Clock className="w-3 h-3" />
                <span>Held ({heldSales.length})</span>
              </button>
            )}

            {cart.length > 0 && (
              <button
                onClick={clearCart}
                className="text-slate-400 hover:text-rose-400 transition cursor-pointer p-0.5"
                title="Clear Cart"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Customer Selector */}
        <div className="p-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5 text-slate-600">
            <User className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-xs font-medium">Customer:</span>
          </div>
          <select
            value={selectedCustomer?.id || ''}
            onChange={(e) => {
              const c = customers.find((cust) => cust.id === e.target.value);
              setSelectedCustomer(c || null);
            }}
            className="text-xs font-medium py-1 px-2 border border-slate-300 rounded bg-white max-w-[190px] truncate"
          >
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} {c.phone ? `(${c.phone})` : ''}
              </option>
            ))}
          </select>
        </div>

        {/* Cart Items List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {cart.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 text-center p-4">
              <ShoppingCart className="w-8 h-8 text-slate-300 mb-1.5" />
              <p className="text-xs font-semibold text-slate-600">Cart is empty</p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Scan barcode or search items from formulary.
              </p>
            </div>
          ) : (
            cart.map((item) => (
              <div
                key={item.medicine.id}
                className="p-2 bg-slate-50 rounded border border-slate-200 space-y-1"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold text-xs text-slate-900 leading-snug">
                      {item.medicine.name}
                    </div>
                    {/* FEFO Batches preview */}
                    <div className="text-[10px] text-slate-500 font-mono">
                      {item.allocated_batches.map((b) => (
                        <span key={b.batch_id} className="text-teal-800 font-medium mr-1.5">
                          {b.batch_number} ({b.quantity}x, exp: {b.expiry_date})
                        </span>
                      ))}
                    </div>
                  </div>

                  <button
                    onClick={() => removeFromCart(item.medicine.id)}
                    className="text-slate-400 hover:text-rose-600 p-0.5 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Controls: Qty, Unit Price, Total */}
                <div className="flex items-center justify-between pt-1">
                  <div className="flex items-center border border-slate-300 rounded bg-white">
                    <button
                      onClick={() => updateCartQuantity(item.medicine.id, item.quantity - 1)}
                      className="px-2 py-0.5 text-slate-600 hover:bg-slate-100 cursor-pointer"
                    >
                      <Minus className="w-3 h-3" />
                    </button>
                    <input
                      type="number"
                      min="1"
                      value={item.quantity}
                      onChange={(e) =>
                        updateCartQuantity(item.medicine.id, parseInt(e.target.value) || 1)
                      }
                      className="w-10 text-center text-xs font-semibold font-mono focus:outline-hidden"
                    />
                    <button
                      onClick={() => updateCartQuantity(item.medicine.id, item.quantity + 1)}
                      className="px-2 py-0.5 text-slate-600 hover:bg-slate-100 cursor-pointer"
                    >
                      <Plus className="w-3 h-3" />
                    </button>
                  </div>

                  <div className="text-right">
                    <div className="text-xs font-bold font-mono text-slate-900">
                      {settings.currency}{' '}
                      {(item.quantity * item.unit_price * (1 - (item.discount_percent || 0) / 100)).toFixed(2)}
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono">
                      {item.quantity} × {settings.currency} {item.unit_price.toFixed(2)}
                    </div>
                  </div>
                </div>

                {/* Optional Item Discount */}
                {currentUser?.role !== 'CASHIER' && (
                  <div className="flex items-center justify-end gap-1 text-[10px] pt-1 border-t border-slate-200">
                    <span className="text-slate-500">Disc %:</span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={item.discount_percent || 0}
                      onChange={(e) =>
                        updateItemDiscount(item.medicine.id, parseFloat(e.target.value) || 0)
                      }
                      className="w-12 px-1 py-0.5 border border-slate-300 rounded text-right font-mono"
                    />
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Cart Summary & Tender Buttons */}
        <div className="p-3 bg-slate-50 border-t border-slate-200 space-y-2 shrink-0">
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between text-slate-600">
              <span>Subtotal:</span>
              <span className="font-mono">{settings.currency} {subtotal.toFixed(2)}</span>
            </div>

            {/* Discount (%) Field */}
            <div className="pt-1 border-t border-dashed border-slate-200">
              <div className="flex items-center justify-between gap-2">
                <label className="text-slate-700 font-semibold flex items-center gap-1">
                  <Tag className="w-3 h-3 text-teal-600" />
                  <span>Discount (%):</span>
                </label>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    max={(currentUser?.role as string) === 'CASHIER' || (currentUser?.role as string) === 'ATTENDANT' ? 10 : 100}
                    value={discountPercent === 0 ? '' : discountPercent}
                    onChange={(e) => handleDiscountChange(e.target.value)}
                    placeholder="0"
                    className="w-16 px-2 py-1 border border-slate-300 rounded bg-white text-right font-mono font-semibold text-xs focus:ring-1 focus:ring-teal-700 focus:outline-hidden"
                  />
                  <span className="text-xs font-mono text-slate-500 font-semibold">%</span>
                </div>
              </div>

              {discountError && (
                <div className="mt-1 p-1 rounded bg-rose-50 border border-rose-200 text-rose-700 text-[10px] font-semibold flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3 text-rose-600 shrink-0" />
                  <span>{discountError}</span>
                </div>
              )}
            </div>

            {discountAmount > 0 && (
              <div className="flex justify-between text-emerald-700 font-semibold">
                <span>Discount ({discountPercent}%):</span>
                <span className="font-mono">-{settings.currency} {discountAmount.toFixed(2)}</span>
              </div>
            )}

            {settings.tax_enabled && (
              <div className="flex justify-between text-slate-600">
                <span>Tax ({settings.tax_rate}%):</span>
                <span className="font-mono">{settings.currency} {taxTotal.toFixed(2)}</span>
              </div>
            )}

            <div className="flex justify-between text-base font-bold text-slate-900 pt-1.5 border-t border-slate-200">
              <span>TOTAL PAYABLE:</span>
              <span className="font-mono text-teal-800">{settings.currency} {total.toFixed(2)}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              onClick={handleHoldSale}
              disabled={cart.length === 0}
              className="py-2 rounded border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 text-xs font-semibold transition flex items-center justify-center gap-1 disabled:opacity-40 cursor-pointer"
            >
              <Clock className="w-3.5 h-3.5" />
              <span>Hold (F8)</span>
            </button>

            <button
              onClick={() => setIsPaymentOpen(true)}
              disabled={cart.length === 0}
              className="py-2.5 rounded bg-teal-700 hover:bg-teal-800 text-white text-xs font-bold transition flex items-center justify-center gap-1.5 disabled:opacity-40 cursor-pointer"
            >
              <CreditCard className="w-4 h-4" />
              <span>Tender (F4)</span>
            </button>
          </div>
        </div>
      </div>

      {/* MODALS */}
      <PaymentModal
        isOpen={isPaymentOpen}
        onClose={() => setIsPaymentOpen(false)}
        cart={cart}
        subtotal={subtotal}
        discountPercent={discountPercent}
        discountTotal={discountAmount}
        taxTotal={taxTotal}
        total={total}
        selectedCustomer={selectedCustomer}
        settings={settings}
        onCompleteSale={handleCompleteSale}
      />

      <HeldSalesModal
        isOpen={isHeldOpen}
        onClose={() => setIsHeldOpen(false)}
        heldSales={heldSales}
        settings={settings}
        onResumeSale={handleResumeSale}
        onDeleteHeldSale={handleDeleteHeldSale}
      />

      <ReceiptModal
        isOpen={!!completedSale}
        onClose={() => {
          setCompletedSale(null);
          searchInputRef.current?.focus();
        }}
        sale={completedSale}
        settings={settings}
      />
    </div>
  );
};
