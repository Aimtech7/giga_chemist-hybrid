import type { Sale, PharmacySettings } from '../types';

export function generateThermalReceiptHtml(sale: Sale, settings: PharmacySettings): string {
  const is58mm = settings.printer_type === '58mm';
  const widthMm = is58mm ? '58mm' : '80mm';

  const itemsHtml = sale.items
    .map(
      (item) => `
      <div style="margin-bottom: 6px; border-bottom: 1px dashed #ddd; padding-bottom: 4px;">
        <div style="font-weight: 700; font-size: 13px;">${item.medicine_name}${item.price_mode === 'WHOLESALE' ? ' [WS]' : ''}</div>
        <div style="display: flex; justify-content: space-between; font-size: 11px; color: #444;">
          <span>Batch: ${item.batch_number} (Exp: ${item.expiry_date})</span>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 12px; margin-top: 2px;">
          <span>${item.quantity} × ${settings.currency} ${item.unit_price.toFixed(2)}</span>
          <span style="font-weight: 600;">${settings.currency} ${(item.quantity * item.unit_price).toFixed(2)}</span>
        </div>
      </div>
    `
    )
    .join('');

  const splitPaymentsHtml =
    sale.split_payments && sale.split_payments.length > 0
      ? `<div style="margin-top: 4px; font-size: 11px; border-top: 1px dotted #ccc; padding-top: 4px;">
          ${sale.split_payments
            .map(
              (p) =>
                `<div style="display: flex; justify-content: space-between;">
                  <span>- ${p.method}${p.reference ? ` (${p.reference})` : ''}:</span>
                  <span>${settings.currency} ${p.amount.toFixed(2)}</span>
                </div>`
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
          size: ${widthMm} auto;
          margin: 0;
        }
        body {
          font-family: 'Courier New', Courier, monospace;
          margin: 0;
          padding: 8px 10px;
          width: ${widthMm};
          background: #fff;
          color: #000;
          font-size: 12px;
          line-height: 1.35;
          box-sizing: border-box;
        }
        .text-center { text-align: center; }
        .text-right { text-align: right; }
        .font-bold { font-weight: bold; }
        .divider {
          border-top: 1px dashed #000;
          margin: 8px 0;
        }
        .double-divider {
          border-top: 2px solid #000;
          margin: 8px 0;
        }
        .row {
          display: flex;
          justify-content: space-between;
        }
        @media print {
          body {
            width: ${widthMm};
            padding: 4px 6px;
          }
        }
      </style>
    </head>
    <body>
      <div class="text-center">
        <h2 style="margin: 0; font-size: 16px; font-weight: 800; letter-spacing: 1px;">
          ${settings.pharmacy_name.toUpperCase()}
        </h2>
        <div style="font-size: 11px; margin-top: 2px;">${settings.tagline}</div>
        <div style="font-size: 11px;">${settings.address}</div>
        <div style="font-size: 11px;">Tel: ${settings.phone}</div>
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
          sale.price_mode === 'WHOLESALE'
            ? `<div class="text-center font-bold" style="margin-top: 4px; border: 1px solid #000; letter-spacing: 2px;">*** WHOLESALE SALE ***</div>`
            : ''
        }
        ${
          sale.customer_name && sale.customer_name !== 'Walk-in Customer'
            ? `<div class="row">
                <span>Customer:</span>
                <span>${sale.customer_name}</span>
              </div>`
            : ''
        }
      </div>

      <div class="divider"></div>

      <div>
        ${itemsHtml}
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
                <span>Discount ${sale.discount_percent ? `${sale.discount_percent}%` : ''}:</span>
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
        <div class="row font-bold" style="font-size: 14px; margin-top: 4px;">
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
            ? `<div class="row">
                <span>Reference:</span>
                <span class="font-bold">${sale.payment_reference}</span>
              </div>`
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
        ${splitPaymentsHtml}
      </div>

      <div class="divider"></div>

      <div class="text-center" style="font-size: 11px; margin-top: 8px; white-space: pre-line;">
        ${settings.receipt_footer}
      </div>
      <div class="text-center" style="font-size: 9px; margin-top: 8px; color: #666;">
        Device: ${sale.device_id} | Ref: ${sale.idempotency_key.substring(0, 10)}
      </div>
    </body>
  </html>
  `;
}

export function printThermalReceipt(sale: Sale, settings: PharmacySettings): void {
  const receiptHtml = generateThermalReceiptHtml(sale, settings);
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
      } catch (e) {
        console.warn('Iframe print intercepted:', e);
      }
      setTimeout(() => {
        if (document.body.contains(iframe)) {
          document.body.removeChild(iframe);
        }
      }, 1200);
    }, 300);
  }
}
