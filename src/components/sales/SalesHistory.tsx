import React, { useState, useEffect } from 'react';
import {
  RotateCcw,
  Search,
  Printer,
  FileSpreadsheet,
  AlertTriangle,
  CheckCircle,
  Ban,
  Clock,
  Eye,
  ShieldCheck,
  Lock,
  UserCheck,
} from 'lucide-react';
import { db, getDeviceId } from '../../db/dexie';
import { executeStockMovement } from '../../services/inventoryEngine';
import { isExpired, normalizeExpiryDate } from '../../utils/expiry';
import { downloadCSV } from '../../services/exportUtils';
import { ReceiptModal } from '../pos/ReceiptModal';
import { canViewCostData, isCashier, isAdmin, isManager } from '../../services/permissions';
import { INITIAL_USERS } from '../../services/auth';
import { enqueueSyncItem, runSync } from '../../services/syncEngine';
import { apiUrl } from '../../services/api';
import type { Sale, CustomerReturn, ReturnAction, PharmacySettings, User, SaleItem } from '../../types';

interface SalesHistoryProps {
  currentUser: User | null;
  settings: PharmacySettings;
}

export const SalesHistory: React.FC<SalesHistoryProps> = ({ currentUser, settings }) => {
  const [sales, setSales] = useState<Sale[]>([]);
  const [search, setSearch] = useState('');
  const [selectedSaleForReceipt, setSelectedSaleForReceipt] = useState<Sale | null>(null);

  // Today Sales Summary state
  const [todaySummary, setTodaySummary] = useState<{
    totalSales: number;
    cashTotal: number;
    mpesaTotal: number;
    transactionCount: number;
    refundsTotal: number;
  }>({
    totalSales: 0,
    cashTotal: 0,
    mpesaTotal: 0,
    transactionCount: 0,
    refundsTotal: 0,
  });

  // Cashier filter mode: 'today' or 'all_mine' or 'all'
  const isCashierUser = isCashier(currentUser);
  const showCost = canViewCostData(currentUser);
  const [cashierFilterMode, setCashierFilterMode] = useState<'today' | 'all_mine'>(
    'today'
  );

  // Return modal state
  const [returnSale, setReturnSale] = useState<Sale | null>(null);
  const [selectedItemToReturn, setSelectedItemToReturn] = useState<SaleItem | null>(null);
  const [itemReturnedQtyMap, setItemReturnedQtyMap] = useState<Record<string, number>>({});
  const [isCurrentBatchExpired, setIsCurrentBatchExpired] = useState(false);
  const [returnQty, setReturnQty] = useState<number>(1);
  const [returnReason, setReturnReason] = useState<string>('');
  const [returnAction, setReturnAction] = useState<ReturnAction>('return_to_stock');
  const [isProcessingReturn, setIsProcessingReturn] = useState(false);
  const [returnSuccess, setReturnSuccess] = useState<string | null>(null);

  // Void modal state with Supervisor Authorization
  const [voidingSale, setVoidingSale] = useState<Sale | null>(null);
  const [voidReason, setVoidReason] = useState<string>('');
  const [supervisorPin, setSupervisorPin] = useState<string>('');
  const [supervisorError, setSupervisorError] = useState<string | null>(null);

  const loadSummary = async () => {
    try {
      const res = await fetch(apiUrl('/api/sales/today-summary'), {
        headers: {
          'x-user-id': currentUser?.id || '',
          'x-user-role': currentUser?.role || 'CASHIER',
          'x-user-name': currentUser?.name || 'Cashier',
        },
      });
      if (res.ok) {
        const data = await res.json();
        setTodaySummary({
          totalSales: Number(data.totalSales) || 0,
          cashTotal: Number(data.cashTotal) || 0,
          mpesaTotal: Number(data.mpesaTotal) || 0,
          transactionCount: Number(data.transactionCount) || 0,
          refundsTotal: Number(data.refundsTotal) || 0,
        });
        return;
      }
    } catch (e) {
      // Offline fallback
    }

    // Fallback: calculate directly from Dexie local sales
    const todayStr = new Date().toISOString().split('T')[0];
    const todaySales = await db.sales
      .filter((s) => {
        const isToday = s.date === todayStr;
        const isCompleted = s.status === 'completed' || s.status === 'partially_returned';
        if (!isToday || !isCompleted) return false;
        if (isCashierUser) {
          return !s.cashier_id || s.cashier_id === currentUser?.id;
        }
        return true;
      })
      .toArray();

    let totalSales = 0;
    let cashTotal = 0;
    let mpesaTotal = 0;

    for (const s of todaySales) {
      const saleAmt = Number(s.total) || 0;
      totalSales += saleAmt;

      if (s.split_payments && s.split_payments.length > 0) {
        for (const sp of s.split_payments) {
          const m = sp.method.toLowerCase();
          if (m.includes('cash')) cashTotal += Number(sp.amount) || 0;
          else if (m.includes('mpesa') || m.includes('m-pesa') || m.includes('m_pesa')) mpesaTotal += Number(sp.amount) || 0;
        }
      } else {
        const m = (s.payment_method || '').toLowerCase();
        if (m.includes('cash')) cashTotal += saleAmt;
        else if (m.includes('mpesa') || m.includes('m-pesa') || m.includes('m_pesa')) mpesaTotal += saleAmt;
      }
    }

    setTodaySummary({
      totalSales: Math.round(totalSales * 100) / 100,
      cashTotal: Math.round(cashTotal * 100) / 100,
      mpesaTotal: Math.round(mpesaTotal * 100) / 100,
      transactionCount: todaySales.length,
      refundsTotal: 0,
    });
  };

  const loadSales = async () => {
    const list = await db.sales.reverse().sortBy('timestamp');
    setSales(list);
    await loadSummary();
  };

  useEffect(() => {
    loadSales();
  }, [currentUser]);

  const handleOpenReturn = async (s: Sale) => {
    setReturnSale(s);
    
    // Query existing returns for this sale to enforce over-return protection
    const existingReturns = await db.customer_returns.where('sale_id').equals(s.id).toArray();
    const qtyMap: Record<string, number> = {};
    for (const ret of existingReturns) {
      const key = `${ret.medicine_id}_${ret.batch_id}`;
      qtyMap[key] = (qtyMap[key] || 0) + ret.quantity;
    }
    setItemReturnedQtyMap(qtyMap);

    if (s.items.length > 0) {
      const firstItem = s.items[0];
      setSelectedItemToReturn(firstItem);
      
      const key = `${firstItem.medicine_id}_${firstItem.batch_id}`;
      const alreadyReturned = qtyMap[key] || 0;
      const maxAvailable = Math.max(1, firstItem.quantity - alreadyReturned);
      setReturnQty(Math.min(1, maxAvailable));

      const batch = await db.medicine_batches.get(firstItem.batch_id);
      const expired = batch ? isExpired(batch.expiry_date) : isExpired(firstItem.expiry_date);
      setIsCurrentBatchExpired(expired);
      setReturnAction(expired ? 'quarantine' : 'return_to_stock');
    }
    setReturnReason('');
  };

  const handleItemSelect = async (item: SaleItem) => {
    setSelectedItemToReturn(item);
    const key = `${item.medicine_id}_${item.batch_id}`;
    const alreadyReturned = itemReturnedQtyMap[key] || 0;
    const maxAvailable = Math.max(0, item.quantity - alreadyReturned);
    setReturnQty(maxAvailable > 0 ? 1 : 0);

    const batch = await db.medicine_batches.get(item.batch_id);
    const expired = batch ? isExpired(batch.expiry_date) : isExpired(item.expiry_date);
    setIsCurrentBatchExpired(expired);
    setReturnAction(expired ? 'quarantine' : 'return_to_stock');
  };

  const handleProcessReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!returnSale || !selectedItemToReturn || !currentUser) return;

    const key = `${selectedItemToReturn.medicine_id}_${selectedItemToReturn.batch_id}`;
    const alreadyReturned = itemReturnedQtyMap[key] || 0;
    const maxReturnable = selectedItemToReturn.quantity - alreadyReturned;

    if (returnQty <= 0 || returnQty > maxReturnable) {
      alert(`Invalid return quantity. Max returnable remaining for this item is ${maxReturnable}.`);
      return;
    }

    if (!returnReason.trim()) {
      alert('Return reason required.');
      return;
    }

    setIsProcessingReturn(true);
    try {
      const deviceId = await getDeviceId();
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];

      // Accurate refund accounting for discounts:
      // net unit price = total charged for line item / original quantity
      const effectiveUnitPrice = selectedItemToReturn.total / selectedItemToReturn.quantity;
      const refundAmount = returnQty * effectiveUnitPrice;
      const discountProrated = (selectedItemToReturn.discount || 0) * (returnQty / selectedItemToReturn.quantity);

      // Verify batch expiry state for return action safety
      const targetBatch = await db.medicine_batches.get(selectedItemToReturn.batch_id);
      const isBatchExpired = targetBatch ? isExpired(targetBatch.expiry_date, now) : isExpired(selectedItemToReturn.expiry_date, now);
      
      let finalAction: ReturnAction = returnAction;
      if (returnAction === 'return_to_stock' && isBatchExpired) {
        finalAction = 'quarantine';
      }

      const idempotencyKey = `RET-${deviceId}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const customerReturn: CustomerReturn = {
        id: `ret-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        sale_id: returnSale.id,
        receipt_number: returnSale.receipt_number,
        medicine_id: selectedItemToReturn.medicine_id,
        medicine_name: selectedItemToReturn.medicine_name,
        batch_id: selectedItemToReturn.batch_id,
        batch_number: selectedItemToReturn.batch_number,
        quantity: returnQty,
        unit_price: selectedItemToReturn.unit_price,
        discount_amount: discountProrated,
        effective_unit_price: effectiveUnitPrice,
        refund_amount: refundAmount,
        cost_price_snapshot: selectedItemToReturn.cost_price_snapshot,
        payment_method: returnSale.payment_method,
        reason: returnReason.trim(),
        action: finalAction,
        user_id: currentUser.id,
        user_name: currentUser.name,
        device_id: deviceId,
        date: todayStr,
        timestamp: Date.now(),
        sync_status: 'pending',
        idempotency_key: idempotencyKey,
      };

      // Atomic Dexie Transaction for Return Processing
      await db.transaction(
        'rw',
        [
          db.customer_returns,
          db.sales,
          db.customers,
          db.medicines,
          db.medicine_batches,
          db.inventory_movements,
          db.audit_logs,
          db.pending_sync,
        ],
        async () => {
          // 1. Record Return Entry
          await db.customer_returns.put(customerReturn);

          // 2. Enqueue Canonical Sync Item
          await db.pending_sync.put({
            id: `sync_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            local_id: customerReturn.id,
            entity_type: 'return',
            operation: 'CREATE',
            payload: customerReturn,
            device_id: deviceId,
            idempotency_key: idempotencyKey,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            version: 1,
            sync_status: 'pending',
            retry_count: 0,
          });

          // 3. Apply Inventory Restock or Quarantine Movement
          if (finalAction === 'return_to_stock' && !isBatchExpired) {
            if (targetBatch) {
              const prevBatchQty = targetBatch.quantity_available;
              const newBatchQty = prevBatchQty + returnQty;
              targetBatch.quantity_available = newBatchQty;
              if (targetBatch.status === 'exhausted' && newBatchQty > 0) {
                targetBatch.status = 'active';
              }
              await db.medicine_batches.put(targetBatch);

              const medBatches = await db.medicine_batches
                .where('medicine_id')
                .equals(selectedItemToReturn.medicine_id)
                .toArray();
              const totalAvailable = medBatches
                .filter((b) => b.status === 'active' && !isExpired(b.expiry_date, now))
                .reduce((sum, b) => sum + b.quantity_available, 0);

              const med = await db.medicines.get(selectedItemToReturn.medicine_id);
              if (med) {
                med.current_stock = totalAvailable;
                med.updated_at = todayStr;
                med.updated_by = currentUser.name;
                med.version = (med.version || 1) + 1;
                await db.medicines.put(med);
              }
            }

            await db.inventory_movements.put({
              id: `mov-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
              medicine_id: selectedItemToReturn.medicine_id,
              medicine_name: selectedItemToReturn.medicine_name,
              batch_id: selectedItemToReturn.batch_id,
              batch_number: selectedItemToReturn.batch_number,
              previous_quantity: targetBatch ? targetBatch.quantity_available - returnQty : 0,
              adjustment_quantity: returnQty,
              new_quantity: targetBatch ? targetBatch.quantity_available : returnQty,
              reason: 'customer_return',
              reference_id: returnSale.sale_number,
              notes: `Customer return from receipt ${returnSale.receipt_number}: ${returnReason.trim()}`,
              user_id: currentUser.id,
              user_name: currentUser.name,
              date: todayStr,
              device_id: deviceId,
              timestamp: Date.now(),
            });
          } else {
            // Expired or Damaged Return -> Quarantined Movement (Stock is not sellable)
            await db.inventory_movements.put({
              id: `mov-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
              medicine_id: selectedItemToReturn.medicine_id,
              medicine_name: selectedItemToReturn.medicine_name,
              batch_id: selectedItemToReturn.batch_id,
              batch_number: selectedItemToReturn.batch_number,
              previous_quantity: targetBatch ? targetBatch.quantity_available : 0,
              adjustment_quantity: 0,
              new_quantity: targetBatch ? targetBatch.quantity_available : 0,
              reason: 'expiry',
              reference_id: returnSale.sale_number,
              notes: `Customer return quarantined (${finalAction}) from receipt ${returnSale.receipt_number}: ${returnReason.trim()}`,
              user_id: currentUser.id,
              user_name: currentUser.name,
              date: todayStr,
              device_id: deviceId,
              timestamp: Date.now(),
            });
          }

          // 4. Update Customer Total Spend (Subtract refunded net amount)
          if (returnSale.customer_id && returnSale.customer_id !== 'cus-001') {
            const cust = await db.customers.get(returnSale.customer_id);
            if (cust) {
              cust.total_spent = Math.max(0, (cust.total_spent || 0) - refundAmount);
              await db.customers.put(cust);
            }
          }

          // 5. Update Sale Status
          const allSaleReturns = await db.customer_returns.where('sale_id').equals(returnSale.id).toArray();
          const totalReturnedQty = allSaleReturns.reduce((sum, r) => sum + r.quantity, 0) + returnQty;
          const totalSoldQty = returnSale.items.reduce((sum, it) => sum + it.quantity, 0);

          returnSale.status = totalReturnedQty >= totalSoldQty ? 'returned' : 'partially_returned';
          await db.sales.put(returnSale);

          // 6. Audit Log
          await db.audit_logs.put({
            id: `aud-ret-${Date.now()}`,
            user_id: currentUser.id,
            user_name: currentUser.name,
            role: currentUser.role,
            action: 'CUSTOMER_RETURN_PROCESSED',
            entity: 'customer_return',
            entity_id: customerReturn.id,
            previous_value: `Sale ${returnSale.receipt_number}, Qty: ${selectedItemToReturn.quantity}`,
            new_value: `Returned: ${returnQty}, Refund: ${refundAmount}, Action: ${finalAction}`,
            device_id: deviceId,
            timestamp: Date.now(),
            date: todayStr,
          });
        }
      );

      setReturnSale(null);
      const actionNotice = finalAction === 'quarantine' && isBatchExpired ? ' (Quarantined due to batch expiration)' : '';
      setReturnSuccess(`Return of ${returnQty}x ${selectedItemToReturn.medicine_name} processed. Refund: ${settings.currency} ${refundAmount.toFixed(2)}${actionNotice}`);
      setTimeout(() => setReturnSuccess(null), 4500);
      runSync().catch(() => {});
      await loadSales();
    } catch (err: any) {
      console.error('Return processing failed:', err);
      alert(err?.message || 'Failed to process return.');
    } finally {
      setIsProcessingReturn(false);
    }
  };

  const handleOpenVoidModal = (s: Sale) => {
    setVoidingSale(s);
    setVoidReason('');
    setSupervisorPin('');
    setSupervisorError(null);
  };

  const handleAuthorizeAndVoid = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!voidingSale || !currentUser) return;

    if (!voidReason.trim()) {
      setSupervisorError('Void justification reason is mandatory.');
      return;
    }

    let authorizingUser: User | null = null;

    if (currentUser.role === 'ADMIN') {
      authorizingUser = currentUser;
    } else {
      // Find manager or admin with matching PIN
      const supervisor = INITIAL_USERS.find(
        (u) => (u.role === 'ADMIN' || u.role === 'MANAGER') && u.pin === supervisorPin
      );

      if (!supervisor) {
        setSupervisorError('Manager or Administrator authorization required. Invalid PIN.');
        return;
      }
      authorizingUser = supervisor;
    }

    const deviceId = await getDeviceId();
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    try {
      // Atomic Dexie Transaction for Sale Voiding
      await db.transaction(
        'rw',
        [
          db.sales,
          db.customers,
          db.medicines,
          db.medicine_batches,
          db.inventory_movements,
          db.audit_logs,
          db.pending_sync,
        ],
        async () => {
          // 1. Revert inventory for each line item (if unexpired, restore sellable stock; if expired, quarantine)
          for (const item of voidingSale.items) {
            const batch = await db.medicine_batches.get(item.batch_id);
            const expired = batch ? isExpired(batch.expiry_date, now) : isExpired(item.expiry_date, now);

            if (batch && !expired) {
              const prevBatchQty = batch.quantity_available;
              batch.quantity_available = prevBatchQty + item.quantity;
              if (batch.status === 'exhausted') batch.status = 'active';
              await db.medicine_batches.put(batch);

              const medBatches = await db.medicine_batches
                .where('medicine_id')
                .equals(item.medicine_id)
                .toArray();
              const totalAvailable = medBatches
                .filter((b) => b.status === 'active' && !isExpired(b.expiry_date, now))
                .reduce((sum, b) => sum + b.quantity_available, 0);

              const med = await db.medicines.get(item.medicine_id);
              if (med) {
                med.current_stock = totalAvailable;
                med.updated_at = todayStr;
                med.updated_by = authorizingUser.name;
                med.version = (med.version || 1) + 1;
                await db.medicines.put(med);
              }
            }

            await db.inventory_movements.put({
              id: `mov-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
              medicine_id: item.medicine_id,
              medicine_name: item.medicine_name,
              batch_id: item.batch_id,
              batch_number: item.batch_number,
              previous_quantity: batch ? batch.quantity_available - item.quantity : 0,
              adjustment_quantity: expired ? 0 : item.quantity,
              new_quantity: batch ? batch.quantity_available : 0,
              reason: expired ? 'expiry' : 'correction',
              reference_id: voidingSale.sale_number,
              notes: `Reversal from voided sale authorized by ${authorizingUser.name}: ${voidReason.trim()}${expired ? ' (Quarantined - Expired)' : ''}`,
              user_id: authorizingUser.id,
              user_name: authorizingUser.name,
              date: todayStr,
              device_id: deviceId,
              timestamp: Date.now(),
            });
          }

          // 2. Mark sale voided with audit details
          voidingSale.status = 'voided';
          voidingSale.void_reason = `${voidReason.trim()} (Authorized by ${authorizingUser.name} - ${authorizingUser.role})`;
          voidingSale.voided_by = authorizingUser.name;
          voidingSale.sync_status = 'pending';
          await db.sales.put(voidingSale);

          // 3. Enqueue Canonical Void Sync Item
          await db.pending_sync.put({
            id: `sync_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            local_id: voidingSale.id,
            entity_type: 'sale',
            operation: 'UPDATE',
            payload: voidingSale,
            device_id: deviceId,
            idempotency_key: `VOID-${deviceId}-${voidingSale.id}`,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            version: 1,
            sync_status: 'pending',
            retry_count: 0,
          });

          // 4. Reverse Customer Spend
          if (voidingSale.customer_id && voidingSale.customer_id !== 'cus-001') {
            const cust = await db.customers.get(voidingSale.customer_id);
            if (cust) {
              cust.total_spent = Math.max(0, (cust.total_spent || 0) - voidingSale.total);
              await db.customers.put(cust);
            }
          }

          // 5. Audit Log
          await db.audit_logs.put({
            id: `aud-void-${Date.now()}`,
            user_id: authorizingUser.id,
            user_name: authorizingUser.name,
            role: authorizingUser.role,
            action: 'SALE_TRANSACTION_VOIDED',
            entity: 'sale',
            entity_id: voidingSale.id,
            previous_value: `Total: ${voidingSale.total}, Status: completed`,
            new_value: `Status: voided, Reason: ${voidReason}, Initiated by: ${currentUser.name}`,
            device_id: deviceId,
            timestamp: Date.now(),
            date: todayStr,
          });
        }
      );

      setVoidingSale(null);
      setVoidReason('');
      setSupervisorPin('');
      setSupervisorError(null);
      setReturnSuccess(`Transaction ${voidingSale.receipt_number} voided and financial aggregates reversed.`);
      setTimeout(() => setReturnSuccess(null), 3500);
      runSync().catch(() => {});
      await loadSales();
    } catch (err: any) {
      console.error('Void transaction failed:', err);
      alert(err?.message || 'Failed to void transaction.');
    }
  };

  const handleExportCSV = () => {
    const headers = [
      'Sale #',
      'Receipt #',
      'Date',
      'Time',
      'Cashier',
      'Customer',
      'Total Amount',
      'Tender Method',
      'Status',
    ];
    const rows = filteredSales.map((s) => [
      s.sale_number,
      s.receipt_number,
      s.date,
      s.time,
      s.cashier_name,
      s.customer_name || 'Walk-in',
      s.total.toFixed(2),
      s.payment_method,
      s.status.toUpperCase(),
    ]);
    downloadCSV(`giga-chemist-sales-${new Date().toISOString().split('T')[0]}.csv`, headers, rows);
  };

  // Filter sales based on role and cashier filter modes
  const todayStr = new Date().toISOString().split('T')[0];

  const filteredSales = sales.filter((s) => {
    if (isCashierUser) {
      if (cashierFilterMode === 'today') {
        const isToday = s.date === todayStr;
        const isMine = !s.cashier_id || s.cashier_id === currentUser?.id;
        if (!isToday || !isMine) return false;
      } else if (cashierFilterMode === 'all_mine') {
        const isMine = !s.cashier_id || s.cashier_id === currentUser?.id;
        if (!isMine) return false;
      }
    }

    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      s.sale_number.toLowerCase().includes(q) ||
      s.receipt_number.toLowerCase().includes(q) ||
      s.cashier_name.toLowerCase().includes(q) ||
      (s.customer_name && s.customer_name.toLowerCase().includes(q)) ||
      (s.payment_reference && s.payment_reference.toLowerCase().includes(q))
    );
  });

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      <div className="p-4 bg-white border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3 shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold text-slate-900 tracking-tight">
              {isCashierUser ? 'Sales History & Receipts' : 'Sales Management'}
            </h1>
            {isCashierUser && (
              <span className="px-2 py-0.5 rounded bg-teal-50 border border-teal-200 text-teal-800 text-[10px] font-semibold">
                Cashier View
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            {isCashierUser
              ? 'View completed sales tickets, reprint customer thermal receipts, and initiate returns.'
              : 'Transaction log, receipt reprinting, customer returns, and administrative voids.'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isCashierUser && (
            <div className="flex border border-slate-300 rounded overflow-hidden text-xs">
              <button
                onClick={() => setCashierFilterMode('today')}
                className={`px-2.5 py-1 font-semibold ${
                  cashierFilterMode === 'today' ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-100'
                }`}
              >
                Today's Shift
              </button>
              <button
                onClick={() => setCashierFilterMode('all_mine')}
                className={`px-2.5 py-1 font-semibold ${
                  cashierFilterMode === 'all_mine' ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-100'
                }`}
              >
                My All Sales
              </button>
            </div>
          )}

          <button
            onClick={handleExportCSV}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-medium transition cursor-pointer"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-slate-600" />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* TODAY'S SALES SUMMARY CARDS */}
      <div className="p-4 bg-white border-b border-slate-200">
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-1.5 text-xs font-bold text-slate-800 uppercase tracking-wider">
            <Clock className="w-3.5 h-3.5 text-teal-600" />
            <span>{isCashierUser ? "Today's Shift Summary" : "Today's Pharmacy Sales Summary"}</span>
          </div>
          <span className="text-[11px] font-mono text-slate-500">
            {new Date().toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
          </span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Card 1: Today's Total Sales */}
          <div className="p-3.5 rounded border border-teal-200 bg-teal-50/60 flex flex-col justify-between shadow-2xs">
            <span className="text-[10px] font-bold uppercase tracking-wider text-teal-800">
              Today's Sales
            </span>
            <div className="text-xl font-black font-mono text-teal-950 mt-1">
              {settings.currency} {todaySummary.totalSales.toFixed(2)}
            </div>
            <span className="text-[10px] text-teal-700 mt-0.5">Net completed revenue</span>
          </div>

          {/* Card 2: Cash Total */}
          <div className="p-3.5 rounded border border-emerald-200 bg-emerald-50/60 flex flex-col justify-between shadow-2xs">
            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-800">
              Cash
            </span>
            <div className="text-xl font-black font-mono text-emerald-950 mt-1">
              {settings.currency} {todaySummary.cashTotal.toFixed(2)}
            </div>
            <span className="text-[10px] text-emerald-700 mt-0.5">Physical cash drawer</span>
          </div>

          {/* Card 3: M-Pesa Total */}
          <div className="p-3.5 rounded border border-sky-200 bg-sky-50/60 flex flex-col justify-between shadow-2xs">
            <span className="text-[10px] font-bold uppercase tracking-wider text-sky-800">
              M-Pesa
            </span>
            <div className="text-xl font-black font-mono text-sky-950 mt-1">
              {settings.currency} {todaySummary.mpesaTotal.toFixed(2)}
            </div>
            <span className="text-[10px] text-sky-700 mt-0.5">Mobile money till</span>
          </div>

          {/* Card 4: Transactions */}
          <div className="p-3.5 rounded border border-slate-200 bg-slate-50 flex flex-col justify-between shadow-2xs">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-700">
              Transactions
            </span>
            <div className="text-xl font-black font-mono text-slate-900 mt-1">
              {todaySummary.transactionCount}
            </div>
            <span className="text-[10px] text-slate-500 mt-0.5">Completed tickets</span>
          </div>
        </div>
      </div>

      {returnSuccess && (
        <div className="mx-4 mt-3 p-3 bg-emerald-50 border border-emerald-300 text-emerald-800 rounded text-xs flex items-center gap-2 animate-fadeIn">
          <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{returnSuccess}</span>
        </div>
      )}

      {/* Search Bar */}
      <div className="p-3 bg-white border-b border-slate-200 flex items-center justify-between gap-2 text-xs shrink-0">
        <div className="relative w-full max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search receipt #, customer, M-Pesa ref..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 border border-slate-300 rounded text-xs focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
          />
        </div>
        <div className="text-slate-500 font-medium">{filteredSales.length} transactions</div>
      </div>

      {/* Sales Table */}
      <div className="flex-1 overflow-auto p-4">
        <div className="bg-white rounded border border-slate-200 overflow-hidden">
          <table className="w-full text-left text-xs text-slate-700">
            <thead className="bg-slate-50 text-slate-600 uppercase font-semibold text-[10px] tracking-wider border-b border-slate-200">
              <tr>
                <th className="py-2.5 px-3 font-mono">Receipt #</th>
                <th className="py-2.5 px-3">Date / Time</th>
                {!isCashierUser && <th className="py-2.5 px-3">Cashier</th>}
                <th className="py-2.5 px-3">Customer</th>
                <th className="py-2.5 px-3">Items Dispensed</th>
                <th className="py-2.5 px-3 text-right">Subtotal</th>
                <th className="py-2.5 px-3 text-right">Discount</th>
                <th className="py-2.5 px-3 text-right">Total Amount</th>
                <th className="py-2.5 px-3">Tender Method</th>
                <th className="py-2.5 px-3 text-center">Status</th>
                <th className="py-2.5 px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredSales.length === 0 ? (
                <tr>
                  <td colSpan={isCashierUser ? 10 : 11} className="py-12 text-center text-slate-400">
                    No sales records match your criteria.
                  </td>
                </tr>
              ) : (
                filteredSales.map((s) => {
                  const saleSubtotal = s.subtotal || s.total;
                  const discountAmt = s.discount_total || 0;
                  const discountPct = s.discount_percent || 0;

                  return (
                    <tr key={s.id} className="hover:bg-slate-50 transition">
                      <td className="py-2 px-3 font-mono font-bold text-slate-900">{s.receipt_number}</td>
                      <td className="py-2 px-3 font-mono text-[11px] text-slate-600">
                        {s.date} {s.time}
                      </td>
                      {!isCashierUser && <td className="py-2 px-3 text-slate-800">{s.cashier_name}</td>}
                      <td className="py-2 px-3 text-slate-800">{s.customer_name || 'Walk-in'}</td>
                      <td className="py-2 px-3 text-slate-600 max-w-xs truncate">
                        {s.items.map((i) => `${i.quantity}x ${i.medicine_name}`).join(', ')}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-slate-600">
                        {settings.currency} {saleSubtotal.toFixed(2)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono">
                        {discountAmt > 0 ? (
                          <span className="text-emerald-700 font-semibold">
                            -{settings.currency} {discountAmt.toFixed(2)}
                            {discountPct > 0 && <span className="text-[10px] text-emerald-600 block">({discountPct}%)</span>}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right font-mono font-bold text-slate-900">
                        {settings.currency} {s.total.toFixed(2)}
                      </td>
                      <td className="py-2 px-3 font-medium">
                        <span>{s.payment_method}</span>
                        {s.payment_reference && (
                          <div className="text-[10px] text-slate-400 font-mono">{s.payment_reference}</div>
                        )}
                      </td>
                      <td className="py-2 px-3 text-center">
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              s.status === 'completed'
                                ? 'bg-emerald-600'
                                : s.status === 'returned'
                                ? 'bg-amber-600'
                                : s.status === 'voided'
                                ? 'bg-rose-600'
                                : 'bg-slate-400'
                            }`}
                          />
                          <span className="capitalize text-slate-700">{s.status}</span>
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => setSelectedSaleForReceipt(s)}
                            className="p-1 rounded border border-slate-200 hover:bg-slate-100 text-slate-700 transition cursor-pointer"
                            title="Reprint Thermal Receipt"
                          >
                            <Printer className="w-3.5 h-3.5" />
                          </button>

                          {s.status === 'completed' && (
                            <button
                              onClick={() => handleOpenReturn(s)}
                              className="p-1 rounded border border-slate-200 hover:bg-amber-50 text-amber-700 transition cursor-pointer"
                              title="Process Return"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </button>
                          )}

                          {s.status === 'completed' && (
                            <button
                              onClick={() => handleOpenVoidModal(s)}
                              className="p-1 rounded border border-rose-200 hover:bg-rose-50 text-rose-600 transition cursor-pointer"
                              title="Void Transaction (Requires Approval)"
                            >
                              <Ban className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* RETURN MODAL */}
      {returnSale && selectedItemToReturn && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="w-full max-w-md bg-white rounded border border-slate-300 shadow-lg overflow-hidden text-slate-800">
            <div className="bg-slate-900 px-4 py-3 text-white flex justify-between items-center">
              <span className="font-bold text-xs">
                Customer Return: Receipt {returnSale.receipt_number}
              </span>
              <button onClick={() => setReturnSale(null)} className="text-slate-400 hover:text-white p-1 rounded cursor-pointer">
                &times;
              </button>
            </div>

            <form onSubmit={handleProcessReturn} className="p-4 space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Select Item to Return</label>
                <select
                  value={`${selectedItemToReturn.medicine_id}_${selectedItemToReturn.batch_id}`}
                  onChange={(e) => {
                    const it = returnSale.items.find((x) => `${x.medicine_id}_${x.batch_id}` === e.target.value);
                    if (it) {
                      handleItemSelect(it);
                    }
                  }}
                  className="w-full p-2 border border-slate-300 rounded bg-white focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                >
                  {returnSale.items.map((it, idx) => {
                    const key = `${it.medicine_id}_${it.batch_id}`;
                    const returned = itemReturnedQtyMap[key] || 0;
                    const remaining = Math.max(0, it.quantity - returned);
                    return (
                      <option key={idx} value={key} disabled={remaining === 0}>
                        {it.medicine_name} (Batch: {it.batch_number}, Sold: {it.quantity}x, Returnable: {remaining}x)
                      </option>
                    );
                  })}
                </select>
              </div>

              {isCurrentBatchExpired && (
                <div className="p-2 rounded bg-amber-50 border border-amber-200 text-amber-800 text-[11px] flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                  <span>
                    Batch {selectedItemToReturn.batch_number} has expired. Returned stock will be quarantined rather than returned to sellable stock.
                  </span>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div>
                  {(() => {
                    const key = `${selectedItemToReturn.medicine_id}_${selectedItemToReturn.batch_id}`;
                    const returned = itemReturnedQtyMap[key] || 0;
                    const maxReturnable = Math.max(0, selectedItemToReturn.quantity - returned);
                    return (
                      <>
                        <label className="block font-semibold text-slate-700 mb-1">
                          Return Quantity (Max: {maxReturnable}) *
                        </label>
                        <input
                          type="number"
                          min="1"
                          max={maxReturnable}
                          value={returnQty}
                          disabled={maxReturnable <= 0}
                          onChange={(e) => setReturnQty(Math.min(maxReturnable, Math.max(1, parseInt(e.target.value) || 1)))}
                          className="w-full p-2 border border-slate-300 rounded font-mono font-bold focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden disabled:bg-slate-100"
                        />
                      </>
                    );
                  })()}
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Refund Due</label>
                  <div className="p-2 border border-slate-200 bg-slate-50 rounded font-mono font-bold text-slate-900">
                    {settings.currency}{' '}
                    {((selectedItemToReturn.total / selectedItemToReturn.quantity) * returnQty).toFixed(2)}
                  </div>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Inventory Destination *</label>
                <select
                  value={returnAction}
                  onChange={(e) => setReturnAction(e.target.value as ReturnAction)}
                  className="w-full p-2 border border-slate-300 rounded bg-white focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                >
                  <option value="return_to_stock" disabled={isCurrentBatchExpired}>
                    {isCurrentBatchExpired ? 'Return to Sellable Stock (Disabled - Expired)' : 'Return to Sellable Stock (Untampered seal)'}
                  </option>
                  <option value="quarantine">Quarantine for Inspection</option>
                  <option value="damaged">Mark as Damaged</option>
                  <option value="dispose">Dispose / Destroy</option>
                </select>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Return Reason / Justification *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Physician adjusted prescription dosage"
                  value={returnReason}
                  onChange={(e) => setReturnReason(e.target.value)}
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setReturnSale(null)}
                  className="px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isProcessingReturn}
                  className="px-4 py-1.5 rounded bg-teal-700 hover:bg-teal-800 text-white font-semibold transition cursor-pointer"
                >
                  {isProcessingReturn ? 'Processing...' : 'Authorize Return'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* SUPERVISOR-PROTECTED VOID MODAL */}
      {voidingSale && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="w-full max-w-md bg-white rounded border border-slate-300 shadow-lg overflow-hidden text-slate-800">
            <div className="bg-slate-900 px-4 py-3 text-white flex justify-between items-center">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-rose-400" />
                <span className="font-bold text-xs uppercase tracking-wider">
                  Void Sale — Supervisor Approval
                </span>
              </div>
              <button onClick={() => setVoidingSale(null)} className="text-slate-400 hover:text-white p-1 rounded cursor-pointer">
                &times;
              </button>
            </div>

            <form onSubmit={handleAuthorizeAndVoid} className="p-4 space-y-3 text-xs">
              <div className="p-3 bg-rose-50 border border-rose-200 rounded text-rose-800">
                <p className="font-semibold">Manager or Administrator authorization required.</p>
                <p className="text-[11px] mt-1">
                  Receipt: <strong>{voidingSale.receipt_number}</strong> | Amount: {settings.currency} {voidingSale.total.toFixed(2)}
                </p>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Mandatory Void Justification Reason *
                </label>
                <textarea
                  required
                  rows={2}
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  placeholder="e.g. Accidental double tender or incorrect payment method"
                  className="w-full p-2 border border-slate-300 rounded focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                />
              </div>

              {currentUser?.role !== 'ADMIN' && (
                <div>
                  <label className="block font-semibold text-slate-700 mb-1 flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 text-slate-500" />
                    <span>Manager / Admin Override PIN *</span>
                  </label>
                  <input
                    type="password"
                    required
                    value={supervisorPin}
                    onChange={(e) => setSupervisorPin(e.target.value)}
                    placeholder="Enter Supervisor PIN (e.g. 1234 / 2345)"
                    className="w-full p-2 border border-slate-300 rounded font-mono tracking-widest text-center text-sm focus:ring-1 focus:ring-teal-700 focus:border-teal-700 focus:outline-hidden"
                  />
                </div>
              )}

              {supervisorError && (
                <div className="p-2 rounded bg-rose-50 border border-rose-200 text-rose-800 text-[11px] flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-rose-600 shrink-0" />
                  <span>{supervisorError}</span>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setVoidingSale(null)}
                  className="px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-50 transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded bg-rose-700 hover:bg-rose-800 text-white font-semibold transition cursor-pointer"
                >
                  Authorize &amp; Void Transaction
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* REPRINT RECEIPT MODAL */}
      <ReceiptModal
        isOpen={!!selectedSaleForReceipt}
        onClose={() => setSelectedSaleForReceipt(null)}
        sale={selectedSaleForReceipt}
        settings={settings}
      />
    </div>
  );
};
