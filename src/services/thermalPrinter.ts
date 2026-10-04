import type { Sale, PharmacySettings } from '../types';

export interface ThermalPrintOptions {
  paperWidth?: '58mm' | '80mm';
  autoPrint?: boolean;
}

export const DEFAULT_GIGA_SETTINGS: PharmacySettings = {
  pharmacy_name: 'GIGA CHEMIST',
  tagline: 'Healthcare & Pharmaceutical Dispensing Centre',
  address: 'Commercial Street, Kitale, Kenya',
  phone: '+254 700 123 456',
  email: 'orders@gigachemist.co.ke',
  currency: 'KES',
  tax_rate: 0,
  tax_enabled: false,
  receipt_header: 'GIGA CHEMIST\nKitale, Kenya\nTel: +254 700 123 456\nOfficial Dispensing Receipt',
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

/**
 * Formats sales data into thermal receipt HTML optimized for 58mm or 80mm thermal paper.
 */
export function formatThermalReceiptHtml(
  sale: Sale,
  settings: PharmacySettings = DEFAULT_GIGA_SETTINGS
): string {
  const paperWidth = settings.printer_type || '80mm';
  const widthCss = paperWidth === '58mm' ? '58mm' : '80mm';

  const itemsMarkup = sale.items
    .map(
      (item) => `
      <div style="margin-bottom: 5px; border-bottom: 1px dashed #d1d5db; padding-bottom: 4px;">
        <div style="font-weight: 700; font-size: 13px; line-height: 1.2;">${item.medicine_name}</div>
        <div style="display: flex; justify-content: space-between; font-size: 10px; color: #4b5563; margin-top: 1px;">
          <span>Batch: ${item.batch_number}</span>
          <span>Exp: ${item.expiry_date}</span>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 12px; margin-top: 2px;">
          <span>${item.quantity} × ${settings.currency} ${item.unit_price.toFixed(2)}</span>
          <span style="font-weight: 700;">${settings.currency} ${item.total.toFixed(2)}</span>
        </div>
      </div>
    `
    )
    .join('');

  const splitPaymentsMarkup =
    sale.split_payments && sale.split_payments.length > 0
      ? `<div style="margin-top: 4px; font-size: 11px; border-top: 1px dotted #9ca3af; padding-top: 3px;">
          ${sale.split_payments
            .map(
              (p) => `
              <div style="display: flex; justify-content: space-between;">
                <span>• ${p.method}${p.reference ? ` (${p.reference})` : ''}:</span>
                <span>${settings.currency} ${p.amount.toFixed(2)}</span>
              </div>
            `
            )
            .join('')}
        </div>`
      : '';

  return `
  <!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8">
      <title>Receipt ${sale.receipt_number}</title>
      <style>
        @page {
          size: ${widthCss} auto;
          margin: 0;
        }
        body {
          font-family: 'Courier New', Courier, monospace, system-ui;
          margin: 0;
          padding: 8px 10px;
          width: ${widthCss};
          background: #fff;
          color: #000;
          font-size: 12px;
          line-height: 1.3;
          box-sizing: border-box;
          -webkit-print-color-adjust: exact;
        }
        .text-center { text-align: center; }
        .text-right { text-align: right; }
        .font-bold { font-weight: bold; }
        .divider {
          border-top: 1px dashed #000;
          margin: 6px 0;
        }
        .double-divider {
          border-top: 2px solid #000;
          margin: 6px 0;
        }
        .row {
          display: flex;
          justify-content: space-between;
        }
        @media print {
          body {
            width: ${widthCss};
            padding: 4px 6px;
          }
        }
      </style>
    </head>
    <body>
      <div class="text-center">
        <h2 style="margin: 0; font-size: 16px; font-weight: 900; letter-spacing: 0.5px;">
          ${settings.pharmacy_name.toUpperCase()}
        </h2>
        <div style="font-size: 10px; margin-top: 2px;">${settings.tagline}</div>
        <div style="font-size: 10px;">${settings.address}</div>
        <div style="font-size: 10px;">Tel: ${settings.phone}</div>
      </div>

      <div class="divider"></div>

      <div>
        <div class="row">
          <span>Receipt #:</span>
          <span class="font-bold">${sale.receipt_number}</span>
        </div>
        <div class="row">
          <span>Date/Time:</span>
          <span>${sale.date} ${sale.time}</span>
        </div>
        <div class="row">
          <span>Cashier:</span>
          <span>${sale.cashier_name}</span>
        </div>
        ${
          sale.customer_name && sale.customer_name !== 'Walk-in Customer'
            ? `<div class="row"><span>Customer:</span><span>${sale.customer_name}</span></div>`
            : ''
        }
      </div>

      <div class="divider"></div>

      <div>
        ${itemsMarkup}
      </div>

      <div class="divider"></div>

      <div>
        <div class="row">
          <span>Subtotal:</span>
          <span>${settings.currency} ${sale.subtotal.toFixed(2)}</span>
        </div>
        ${
          sale.discount_total > 0
            ? `<div class="row">
                <span>Discount:</span>
                <span>-${settings.currency} ${sale.discount_total.toFixed(2)}</span>
              </div>`
            : ''
        }
        ${
          settings.tax_enabled
            ? `<div class="row">
                <span>Tax (${settings.tax_rate}%):</span>
                <span>${settings.currency} ${sale.tax_total.toFixed(2)}</span>
              </div>`
            : ''
        }
        <div class="row font-bold" style="font-size: 14px; margin-top: 3px;">
          <span>TOTAL:</span>
          <span>${settings.currency} ${sale.total.toFixed(2)}</span>
        </div>
      </div>

      <div class="double-divider"></div>

      <div>
        <div class="row">
          <span>Payment:</span>
          <span class="font-bold">${sale.payment_method.toUpperCase()}</span>
        </div>
        ${
          sale.payment_reference
            ? `<div class="row"><span>Reference:</span><span class="font-bold">${sale.payment_reference}</span></div>`
            : ''
        }
        <div class="row">
          <span>Paid:</span>
          <span>${settings.currency} ${sale.amount_received.toFixed(2)}</span>
        </div>
        <div class="row">
          <span>Change:</span>
          <span>${settings.currency} ${sale.change_given.toFixed(2)}</span>
        </div>
        ${splitPaymentsMarkup}
      </div>

      <div class="divider"></div>

      <div class="text-center" style="font-size: 10px; margin-top: 6px; white-space: pre-line;">
        ${settings.receipt_footer}
      </div>
      <div class="text-center" style="font-size: 9px; margin-top: 6px; color: #6b7280;">
        Terminal: ${sale.device_id} | Ref: ${sale.idempotency_key.substring(0, 12)}
      </div>
    </body>
  </html>
  `;
}

/**
 * Triggers thermal receipt print dialog in the browser.
 * Uses window popup or hidden iframe fallback.
 */
export function printThermalReceipt(
  sale: Sale,
  settings: PharmacySettings = DEFAULT_GIGA_SETTINGS
): void {
  const receiptHtml = formatThermalReceiptHtml(sale, settings);
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.bottom = '0';
  iframe.style.right = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = 'none';
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow?.document;
  if (doc) {
    doc.open();
    doc.write(receiptHtml);
    doc.close();
    setTimeout(() => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch (err) {
        console.warn('Silent print blocked by browser sandbox:', err);
      }
      setTimeout(() => {
        if (document.body.contains(iframe)) {
          document.body.removeChild(iframe);
        }
      }, 1500);
    }, 300);
  }
}
