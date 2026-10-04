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
import { db } from '../../db/dexie';
import { allocateFefo } from '../../services/inventoryEngine';
import { isExpired } from '../../utils/expiry';
import { searchMedicines } from '../../services/searchEngine';
import { useBarcodeScanner } from '../../hooks/useBarcodeScanner';
import { PaymentModal } from './PaymentModal';
import { HeldSalesModal } from './HeldSalesModal';
import { ReceiptModal } from './ReceiptModal';
import { apiFetch, ApiError } from '../../services/http';
import { applyServerStockResult, refreshCacheAfterCommit } from '../../services/stockCache';
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
  PriceMode,
  SplitPayment,
} from '../../types';

/** Wholesale price of a medicine, or null when none is set (never substituted with retail). */
function wholesalePriceOf(med: Medicine): number | null {
  return med.wholesale_price != null && Number(med.wholesale_price) > 0 ? Number(med.wholesale_price) : null;
}

/** Price a line uses in the given mode; null = WHOLESALE requested but no wholesale price exists. */
function linePrice(med: Medicine, mode: PriceMode): number | null {
  return mode === 'WHOLESALE' ? wholesalePriceOf(med) : med.selling_price;
}

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
  const [categoryOptions, setCategoryOptions] = useState<string[]>([]);
  const [selectedResultIndex, setSelectedResultIndex] = useState<number>(0);

  // Pricing mode: RETAIL is the default; WHOLESALE must be switched on deliberately.
  const [priceMode, setPriceMode] = useState<PriceMode>('RETAIL');
  const isWholesale = priceMode === 'WHOLESALE';

  // Active Cart State
  const [cart, setCart] = useState<CartItem[]>([]);
  // One idempotency key per attempted sale: a retried checkout can never create a second sale.
  const checkoutKeyRef = useRef<string | null>(null);

  // "No wholesale price" decision dialog (replaces the browser confirm box).
  const [retailFallbackPrompt, setRetailFallbackPrompt] = useState<{
    items: { name: string; retail: number }[];
    context: 'add' | 'switch';
  } | null>(null);
  const fallbackResolverRef = useRef<((useRetail: boolean) => void) | null>(null);
  const askRetailFallback = (items: Medicine[], context: 'add' | 'switch') =>
    new Promise<boolean>((resolve) => {
      fallbackResolverRef.current = resolve;
      setRetailFallbackPrompt({ items: items.map((m) => ({ name: m.name, retail: m.selling_price })), context });
    });
  const resolveRetailFallback = (useRetail: boolean) => {
    fallbackResolverRef.current?.(useRetail);
    fallbackResolverRef.current = null;
    setRetailFallbackPrompt(null);
  };
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
      // Only ACTIVE medicines are sellable or searchable at the till (inactive ones, including the
      // automated-test fixtures, never appear here).
      const meds = await db.medicines.where('status').equals('active').toArray();
      setMedicines(meds);

      // Real categories (hydrated from PostgreSQL) that at least one active medicine uses.
      const used = new Set(meds.map((m) => (m.category || '').trim().toLowerCase()).filter(Boolean));
      const cats = await db.categories.orderBy('name').toArray();
      const seen = new Set<string>();
      const options: string[] = [];
      for (const c of cats.length > 0 ? cats.map((x) => x.name) : meds.map((m) => m.category)) {
        const key = (c || '').trim().toLowerCase();
        if (key && used.has(key) && !seen.has(key)) {
          seen.add(key);
          options.push(c.trim());
        }
      }
      options.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      setCategoryOptions(options);
      // A remembered category that no longer exists falls back to All.
      setSelectedCategory((prev) => (prev === 'All' || seen.has(prev.toLowerCase()) ? prev : 'All'));

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
      const wanted = selectedCategory.trim().toLowerCase();
      pool = pool.filter((m) => (m.category || '').trim().toLowerCase() === wanted);
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
    enabled: !isPaymentOpen && !isHeldOpen && !completedSale && !retailFallbackPrompt,
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
        if (retailFallbackPrompt) {
          resolveRetailFallback(false);
          return;
        }
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
  }, [cart, isPaymentOpen, isHeldOpen, completedSale, retailFallbackPrompt]);

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
      // Same medicine again: one line, quantity +1, price mode of that line unchanged.
      const updated = [...cart];
      updated[existingIndex] = { ...updated[existingIndex], quantity: requestedQty, allocated_batches: fefo.allocations };
      setCart(updated);
      return;
    }

    let lineMode: PriceMode = priceMode;
    let retailFallback = false;
    if (priceMode === 'WHOLESALE' && wholesalePriceOf(medicine) === null) {
      // Never price silently: selling at retail inside a wholesale sale needs explicit confirmation.
      const ok = await askRetailFallback([medicine], 'add');
      if (!ok) {
        setWarningMessage(`${medicine.name} was not added: no wholesale price is set.`);
        setTimeout(() => setWarningMessage(null), 4000);
        return;
      }
      lineMode = 'RETAIL';
      retailFallback = true;
    }

    setCart((prev) => [
      ...prev,
      {
        medicine,
        quantity: 1,
        unit_price: linePrice(medicine, lineMode)!,
        price_mode: lineMode,
        retail_fallback: retailFallback,
        discount_percent: 0,
        allocated_batches: fefo.allocations,
      },
    ]);
  };

  /**
   * Switches RETAIL <-> WHOLESALE and re-prices every cart line from the current medicine record,
   * so no line can keep a stale price from the other mode.
   */
  const switchPriceMode = async (mode: PriceMode) => {
    if (mode === priceMode) return;
    if (mode === 'RETAIL') {
      setCart((prev) =>
        prev.map((i) => ({ ...i, price_mode: 'RETAIL', retail_fallback: false, unit_price: i.medicine.selling_price }))
      );
      setPriceMode('RETAIL');
      return;
    }
    const missing = cart.filter((i) => wholesalePriceOf(i.medicine) === null);
    if (missing.length > 0) {
      const ok = await askRetailFallback(missing.map((i) => i.medicine), 'switch');
      if (!ok) return;
    }
    setCart((prev) =>
      prev.map((i) => {
        const ws = wholesalePriceOf(i.medicine);
        return ws === null
          ? { ...i, price_mode: 'RETAIL', retail_fallback: true, unit_price: i.medicine.selling_price }
          : { ...i, price_mode: 'WHOLESALE', retail_fallback: false, unit_price: ws };
      })
    );
    setPriceMode('WHOLESALE');
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
    // Every new sale starts in RETAIL; wholesale must be chosen again deliberately.
    setPriceMode('RETAIL');
    checkoutKeyRef.current = null;
    searchInputRef.current?.focus();
  };

  // Any change to what is being sold makes it a different sale (new idempotency key).
  useEffect(() => {
    checkoutKeyRef.current = null;
  }, [cart, discountPercent, priceMode, selectedCustomer]);

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

    // Held sales from before wholesale pricing carry no mode: they were retail.
    const heldMode: PriceMode = heldSale.items.some((i) => i.price_mode === 'WHOLESALE' || i.retail_fallback)
      ? 'WHOLESALE'
      : 'RETAIL';

    for (const item of heldSale.items) {
      // Re-price from the CURRENT medicine record so a resumed sale never uses a stale price.
      const fresh = (await db.medicines.get(item.medicine.id)) || item.medicine;
      const mode: PriceMode = item.price_mode === 'WHOLESALE' && wholesalePriceOf(fresh) !== null ? 'WHOLESALE' : 'RETAIL';
      const repriced = {
        ...item,
        medicine: fresh,
        price_mode: mode,
        retail_fallback: heldMode === 'WHOLESALE' && mode === 'RETAIL',
        unit_price: linePrice(fresh, mode)!,
      };
      if (repriced.unit_price !== item.unit_price) hadAdjustment = true;
      const fefo = await allocateFefo(item.medicine.id, item.quantity);
      if (fefo.possible) {
        updatedCart.push({ ...repriced, allocated_batches: fefo.allocations });
      } else if (fefo.allocatedTotal > 0) {
        hadAdjustment = true;
        updatedCart.push({ ...repriced, quantity: fefo.allocatedTotal, allocated_batches: fefo.allocations });
      } else {
        hadAdjustment = true;
      }
    }

    setPriceMode(heldMode);
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

  // Complete the sale on the server. PostgreSQL decides prices, batches (FEFO), stock and totals in
  // ONE transaction; nothing is recorded locally unless that transaction committed.
  const handleCompleteSale = async (paymentData: {
    payment_method: PaymentMethod;
    payment_reference?: string;
    amount_received: number;
    change_given: number;
    split_payments?: SplitPayment[];
  }) => {
    if (!checkoutKeyRef.current) checkoutKeyRef.current = `SALE-${crypto.randomUUID()}`;

    const payload = {
      idempotency_key: checkoutKeyRef.current,
      price_mode: priceMode,
      discount_percent: discountPercent,
      customer_id: selectedCustomer?.id || null,
      items: cart.map((i) => ({
        medicine_id: i.medicine.id,
        quantity: i.quantity,
        unit_price: i.unit_price, // what the cashier saw; the server rejects it if it no longer matches
        price_mode: i.price_mode,
        retail_fallback_confirmed: i.retail_fallback === true,
      })),
      payment: {
        method: paymentData.payment_method,
        amount_received: paymentData.amount_received,
        reference: paymentData.payment_reference,
        split: paymentData.split_payments,
      },
    };

    let result: { sale: Sale; medicines: any[]; batches: any[]; duplicate: boolean };
    try {
      result = await apiFetch('/api/sales/checkout', { body: payload });
    } catch (err: any) {
      if (err instanceof ApiError && err.data?.code === 'PRICE_CHANGED' && Array.isArray(err.data.details)) {
        // Show the current server prices in the cart; the cashier must review and tender again.
        const current = new Map<string, number>(err.data.details.map((d: any) => [d.medicine_id, Number(d.current)]));
        setCart((prev) => prev.map((i) => (current.has(i.medicine.id) ? { ...i, unit_price: current.get(i.medicine.id)! } : i)));
      }
      const msg = err?.message || 'Checkout failed.';
      setWarningMessage(`Sale NOT completed: ${msg}`);
      setTimeout(() => setWarningMessage(null), 6000);
      throw new Error(msg);
    }

    // Committed. Cache the authoritative result for fast reads; a cache error never undoes the sale.
    const cacheWarning = await refreshCacheAfterCommit(async () => {
      await db.sales.put(result.sale);
      await applyServerStockResult({ batches: result.batches });
      for (const m of result.medicines) await applyServerStockResult({ medicine: m });
    });
    await loadData();
    clearCart();
    setCompletedSale(result.sale);
    if (result.duplicate) {
      setWarningMessage('This sale was already completed earlier — showing the original receipt (no second sale was made).');
      setTimeout(() => setWarningMessage(null), 6000);
    } else if (cacheWarning) {
      setWarningMessage(cacheWarning);
      setTimeout(() => setWarningMessage(null), 8000);
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

          {/* Category filter: real PostgreSQL categories (hundreds exist, so a list, not buttons) */}
          <div className="flex items-center gap-2 text-xs">
            <label htmlFor="pos-category" className="font-semibold text-slate-600 shrink-0">
              Category:
            </label>
            <select
              id="pos-category"
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className={`flex-1 max-w-xs py-1 px-2 border rounded text-xs font-medium bg-white ${
                selectedCategory === 'All' ? 'border-slate-300 text-slate-700' : 'border-slate-900 text-slate-900 font-semibold'
              }`}
            >
              <option value="All">All categories ({categoryOptions.length})</option>
              {categoryOptions.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
            {selectedCategory !== 'All' && (
              <button
                type="button"
                onClick={() => setSelectedCategory('All')}
                className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium cursor-pointer"
              >
                Clear
              </button>
            )}
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
                        {isWholesale ? (
                          wholesalePriceOf(med) !== null ? (
                            <div className="font-bold font-mono text-amber-800" title="Wholesale price">
                              WS {settings.currency} {wholesalePriceOf(med)!.toFixed(2)}
                            </div>
                          ) : (
                            <div className="font-semibold text-[10px] text-rose-700" title={`Retail ${settings.currency} ${med.selling_price.toFixed(2)}`}>
                              No wholesale price
                            </div>
                          )
                        ) : (
                          <div className="font-bold font-mono text-slate-900">
                            {settings.currency} {med.selling_price.toFixed(2)}
                          </div>
                        )}

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
        {/* Pricing mode: large, explicit switch. WHOLESALE recolours the whole cart. */}
        <div className={`p-2 border-b ${isWholesale ? 'bg-amber-100 border-amber-300' : 'bg-slate-100 border-slate-200'}`}>
          <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Pricing mode">
            <button
              type="button"
              role="radio"
              aria-checked={!isWholesale}
              onClick={() => switchPriceMode('RETAIL')}
              className={`py-2 rounded text-sm font-black tracking-wider transition cursor-pointer border-2 ${
                !isWholesale ? 'bg-teal-700 border-teal-800 text-white shadow-xs' : 'bg-white border-slate-300 text-slate-500 hover:bg-slate-50'
              }`}
            >
              RETAIL
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={isWholesale}
              onClick={() => switchPriceMode('WHOLESALE')}
              className={`py-2 rounded text-sm font-black tracking-wider transition cursor-pointer border-2 ${
                isWholesale ? 'bg-amber-600 border-amber-700 text-white shadow-xs' : 'bg-white border-slate-300 text-slate-500 hover:bg-slate-50'
              }`}
            >
              WHOLESALE
            </button>
          </div>
          {isWholesale && (
            <div className="mt-1.5 px-2 py-1 rounded bg-amber-600 text-white text-[11px] font-bold text-center uppercase tracking-wide">
              Wholesale sale — wholesale prices are being charged
            </div>
          )}
        </div>

        {/* Cart Header */}
        <div className={`p-3 text-white flex items-center justify-between ${isWholesale ? 'bg-amber-800' : 'bg-slate-900'}`}>
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
                    <div className="mt-0.5">
                      {item.price_mode === 'WHOLESALE' ? (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-600 text-white font-bold uppercase tracking-wider">
                          Wholesale
                        </span>
                      ) : item.retail_fallback ? (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-rose-100 border border-rose-300 text-rose-800 font-bold uppercase tracking-wider">
                          Retail — no wholesale price
                        </span>
                      ) : (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-teal-50 border border-teal-200 text-teal-800 font-bold uppercase tracking-wider">
                          Retail
                        </span>
                      )}
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
                      {settings.currency} {(item.quantity * item.unit_price).toFixed(2)}
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono">
                      {item.quantity} × {settings.currency} {item.unit_price.toFixed(2)}
                    </div>
                  </div>
                </div>
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
              <span>{isWholesale ? 'TOTAL PAYABLE (WHOLESALE):' : 'TOTAL PAYABLE:'}</span>
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
      {retailFallbackPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" role="dialog" aria-modal="true" aria-labelledby="no-ws-title">
          <div className="w-full max-w-md bg-white rounded border border-amber-300 shadow-lg overflow-hidden text-slate-800">
            <div className="bg-amber-600 px-4 py-3 text-white flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              <span id="no-ws-title" className="font-bold text-xs uppercase tracking-wider">No wholesale price</span>
            </div>
            <div className="p-4 space-y-3 text-sm">
              {retailFallbackPrompt.items.length === 1 ? (
                <p>
                  <strong>{retailFallbackPrompt.items[0].name}</strong> has no wholesale price.
                </p>
              ) : (
                <p>These medicines have no wholesale price:</p>
              )}
              <ul className="rounded border border-slate-200 divide-y divide-slate-100 max-h-48 overflow-y-auto">
                {retailFallbackPrompt.items.map((it) => (
                  <li key={it.name} className="px-3 py-1.5 flex justify-between gap-3 text-xs">
                    <span className="font-semibold text-slate-900">{it.name}</span>
                    <span className="font-mono text-slate-600 shrink-0">Retail {settings.currency} {it.retail.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-slate-600">
                {retailFallbackPrompt.context === 'add'
                  ? 'Use Retail Price adds it to this wholesale sale at its RETAIL price. Cancel leaves it out.'
                  : 'Use Retail Price switches to WHOLESALE and keeps these at their RETAIL price. Cancel stays in RETAIL mode.'}
              </p>
            </div>
            <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
              <button
                type="button"
                autoFocus
                onClick={() => resolveRetailFallback(false)}
                className="px-4 py-2 rounded border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 text-xs font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => resolveRetailFallback(true)}
                className="px-4 py-2 rounded bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold cursor-pointer"
              >
                Use Retail Price
              </button>
            </div>
          </div>
        </div>
      )}

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
