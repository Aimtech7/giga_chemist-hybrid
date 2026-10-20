/**
 * Rejected Change Classification & Payload Sanitization
 *
 * Categorizes sync rejection errors into clear operational buckets with
 * human-friendly explanations, safe preview data, and zero credential exposure.
 */

export type RejectionCategory =
  | 'SCHEMA_RPC_ERROR'
  | 'UNSUPPORTED_EVENT_TYPE'
  | 'VALIDATION_ERROR'
  | 'SEQUENCE_CONFLICT'
  | 'CONCURRENCY_CONFLICT'
  | 'MISSING_REFERENCE'
  | 'PROTOCOL_INCOMPATIBLE'
  | 'AUTHENTICATION_ERROR'
  | 'CLOUD_ERROR'
  | 'DUPLICATE_ALREADY_APPLIED'
  | 'OTHER';

export interface ClassifiedRejection {
  category: RejectionCategory;
  human_reason: string;
  technical_error: string;
  is_eligible_for_retry: boolean;
  is_permanent_failure: boolean;
}

export function classifyRejection(
  eventType: string,
  rawError?: string | null
): ClassifiedRejection {
  const err = String(rawError || '').trim();
  const lower = err.toLowerCase();

  // 1. Schema RPC argument / signature errors
  if (
    lower.includes('function') && lower.includes('does not exist') ||
    lower.includes('42883') ||
    lower.includes('p_idempotency_keys') ||
    lower.includes('p_keys') ||
    lower.includes('parameter mismatch') ||
    lower.includes('argument') && lower.includes('signature')
  ) {
    return {
      category: 'SCHEMA_RPC_ERROR',
      human_reason: 'Cloud function signature or parameter contract was incompatible.',
      technical_error: err,
      is_eligible_for_retry: true, // Eligible because cloud migration / hotfix fixed the contract!
      is_permanent_failure: false,
    };
  }

  // 2. Unsupported event type
  if (
    lower.includes('unsupported event type') ||
    lower.includes('unknown event type') ||
    lower.includes('case not found')
  ) {
    return {
      category: 'UNSUPPORTED_EVENT_TYPE',
      human_reason: `Event type "${eventType}" is not supported by the cloud schema.`,
      technical_error: err,
      is_eligible_for_retry: false,
      is_permanent_failure: true,
    };
  }

  // 3. Validation / Check constraint errors
  if (
    lower.includes('check constraint') ||
    lower.includes('violates check') ||
    lower.includes('23514') ||
    lower.includes('not-null') ||
    lower.includes('23502') ||
    lower.includes('invalid uuid') ||
    lower.includes('invalid input syntax')
  ) {
    return {
      category: 'VALIDATION_ERROR',
      human_reason: 'Payload violated a database validation constraint.',
      technical_error: err,
      is_eligible_for_retry: false,
      is_permanent_failure: true,
    };
  }

  // 4. Sequence conflicts
  if (
    lower.includes('sequence') ||
    lower.includes('out of order') ||
    lower.includes('gap') ||
    lower.includes('prior event')
  ) {
    return {
      category: 'SEQUENCE_CONFLICT',
      human_reason: 'Out-of-order sequence conflict with prior events.',
      technical_error: err,
      is_eligible_for_retry: true,
      is_permanent_failure: false,
    };
  }

  // 5. Concurrency / Stale version conflicts
  if (
    lower.includes('stale') ||
    lower.includes('conflict') ||
    lower.includes('version mismatch') ||
    lower.includes('concurrent')
  ) {
    return {
      category: 'CONCURRENCY_CONFLICT',
      human_reason: 'Concurrent edit conflict; record was modified elsewhere.',
      technical_error: err,
      is_eligible_for_retry: false, // Requires review
      is_permanent_failure: false,
    };
  }

  // 6. Missing foreign key reference
  if (
    lower.includes('foreign key') ||
    lower.includes('violates foreign key') ||
    lower.includes('23503') ||
    lower.includes('parent record')
  ) {
    return {
      category: 'MISSING_REFERENCE',
      human_reason: 'Referenced parent record is missing in cloud database.',
      technical_error: err,
      is_eligible_for_retry: true,
      is_permanent_failure: false,
    };
  }

  // 7. Protocol incompatible
  if (lower.includes('protocol') || lower.includes('incompatible protocol')) {
    return {
      category: 'PROTOCOL_INCOMPATIBLE',
      human_reason: 'Sync protocol version incompatible with target cloud endpoint.',
      technical_error: err,
      is_eligible_for_retry: false,
      is_permanent_failure: true,
    };
  }

  // 8. Authentication error
  if (
    lower.includes('unauthorized') ||
    lower.includes('token') && lower.includes('invalid') ||
    lower.includes('forbidden') ||
    lower.includes('wrong shop token')
  ) {
    return {
      category: 'AUTHENTICATION_ERROR',
      human_reason: 'Shop authentication rejected by cloud security gateway.',
      technical_error: err,
      is_eligible_for_retry: false,
      is_permanent_failure: false,
    };
  }

  // 9. Duplicate already applied
  if (lower.includes('duplicate') || lower.includes('already applied')) {
    return {
      category: 'DUPLICATE_ALREADY_APPLIED',
      human_reason: 'Event was already safely applied by cloud ledger.',
      technical_error: err,
      is_eligible_for_retry: false,
      is_permanent_failure: false,
    };
  }

  // 10. Transient Cloud Error
  if (
    lower.includes('timeout') ||
    lower.includes('connection') ||
    lower.includes('500') ||
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504')
  ) {
    return {
      category: 'CLOUD_ERROR',
      human_reason: 'Temporary cloud infrastructure or network timeout.',
      technical_error: err,
      is_eligible_for_retry: true,
      is_permanent_failure: false,
    };
  }

  return {
    category: 'OTHER',
    human_reason: err ? `Sync rejected: ${err.slice(0, 150)}` : 'Sync rejected with an unknown error.',
    technical_error: err || 'Unknown rejection',
    is_eligible_for_retry: false,
    is_permanent_failure: false,
  };
}

/**
 * Sanitizes business data preview:
 * Never exposes credentials (passwords, PINs, hashes, tokens, keys).
 */
export function sanitizePayloadPreview(
  eventType: string,
  rawPayload: any
): Record<string, unknown> {
  if (!rawPayload || typeof rawPayload !== 'object') return {};

  const p = rawPayload.payload ? rawPayload.payload : rawPayload;
  const data = p.data || p;

  switch (eventType) {
    case 'SALE_COMPLETED': {
      const sale = data.sale || {};
      const items = Array.isArray(data.items) ? data.items : [];
      const payments = Array.isArray(data.payments) ? data.payments : [];
      return {
        receipt_number: sale.receipt_number || rawPayload.business_ref || '—',
        sale_id: sale.id || rawPayload.entity_id || '—',
        cashier_name: data.cashier_name || rawPayload.actor_name || sale.cashier_name || '—',
        items_count: items.length,
        total: sale.total != null ? Number(sale.total) : 0,
        subtotal: sale.subtotal != null ? Number(sale.subtotal) : 0,
        discount: sale.discount_total != null ? Number(sale.discount_total) : 0,
        payment_methods: payments.map((m: any) => m.method || m.payment_method).filter(Boolean),
        created_at: sale.created_at || rawPayload.occurred_at || null,
      };
    }

    case 'SALE_VOIDED': {
      const sale = data.sale || {};
      return {
        receipt_number: sale.receipt_number || rawPayload.business_ref || '—',
        sale_id: sale.id || rawPayload.entity_id || '—',
        void_reason: data.reason || '—',
        voided_by: rawPayload.actor_name || '—',
      };
    }

    case 'RETURN_REQUESTED':
    case 'RETURN_APPROVED':
    case 'RETURN_REJECTED': {
      const ret = data.return || data;
      return {
        return_id: ret.id || rawPayload.entity_id || '—',
        receipt_number: ret.receipt_number || rawPayload.business_ref || '—',
        medicine_name: ret.medicine_name || '—',
        quantity: ret.quantity,
        refund_amount: ret.refund_amount,
        status: ret.status,
        reason: ret.reason || '—',
      };
    }

    case 'MEDICINE_CREATED':
    case 'MEDICINE_UPDATED':
    case 'MEDICINE_PRICE_CHANGED':
    case 'MEDICINE_ARCHIVED':
    case 'MEDICINE_DELETED': {
      const med = data.medicine || data;
      return {
        medicine_id: med.id || rawPayload.entity_id || '—',
        name: med.name || '—',
        barcode: med.barcode || '—',
        selling_price: med.selling_price != null ? Number(med.selling_price) : null,
        wholesale_price: med.wholesale_price != null ? Number(med.wholesale_price) : null,
        category: med.category || '—',
      };
    }

    case 'STOCK_SET':
    case 'STOCK_ADDED':
    case 'STOCK_REMOVED':
    case 'PHYSICAL_COUNT': {
      const movements = Array.isArray(p.movements) ? p.movements : [];
      return {
        medicine_id: rawPayload.entity_id || '—',
        movements_count: movements.length,
        movements: movements.map((m: any) => ({
          batch_id: m.batch_id,
          delta: m.quantity_delta,
          previous: m.previous_quantity,
          new: m.new_quantity,
          reason: m.reason,
        })),
      };
    }

    case 'PURCHASE_RECEIVED':
    case 'PURCHASE_DRAFTED':
    case 'PURCHASE_UPDATED':
    case 'PURCHASE_CANCELLED': {
      const purchase = data.purchase || data;
      const items = Array.isArray(data.items) ? data.items : [];
      return {
        purchase_id: purchase.id || rawPayload.entity_id || '—',
        invoice_number: purchase.invoice_number || rawPayload.business_ref || '—',
        supplier_id: purchase.supplier_id || '—',
        total_amount: purchase.total_amount != null ? Number(purchase.total_amount) : 0,
        items_count: items.length,
        status: purchase.status || '—',
      };
    }

    case 'USER_UPSERTED':
    case 'USER_DELETED': {
      const u = data.user || data;
      return {
        user_id: u.id || rawPayload.entity_id || '—',
        name: u.name || '—',
        email: u.email || '—',
        username: u.username || '—',
        role: u.role || '—',
        active: u.active ?? true,
      };
    }

    case 'SHIFT_OPENED':
    case 'SHIFT_CLOSED':
    case 'SHIFT_REVIEWED':
    case 'SHIFT_CORRECTED': {
      const s = data.shift || data;
      return {
        shift_id: s.id || rawPayload.entity_id || '—',
        shift_number: s.shift_number || rawPayload.business_ref || '—',
        cashier_name: s.cashier_name || rawPayload.actor_name || '—',
        status: s.status || '—',
        opening_float: s.opening_float != null ? Number(s.opening_float) : 0,
        actual_cash: s.actual_cash != null ? Number(s.actual_cash) : null,
        variance: s.cash_variance != null ? Number(s.cash_variance) : null,
      };
    }

    default: {
      // General safe filter stripping any credentials
      const clean: Record<string, unknown> = {};
      const forbidden = /password|pin|token|secret|hash|jwt|key/i;
      for (const [k, v] of Object.entries(data)) {
        if (!forbidden.test(k) && typeof v !== 'function') {
          if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
            clean[k] = sanitizePayloadPreview('generic', v);
          } else {
            clean[k] = v;
          }
        }
      }
      return clean;
    }
  }
}
