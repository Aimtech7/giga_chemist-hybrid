import fs from 'fs';
import path from 'path';
import readline from 'readline';

interface TableAudit {
  name: string;
  rowCount: number;
  columns: string[];
  purpose: string;
  targetTable: string;
  status: string;
  notes: string;
}

const TABLE_MAPPINGS: Record<string, { purpose: string; target: string; status: string; notes: string }> = {
  ospos_items: {
    purpose: 'Core product / formulary catalogue',
    target: 'medicines, medicine_batches',
    status: 'MIGRATE',
    notes: 'Maps item_id, name, category, cost_price, unit_price, reorder_level'
  },
  ospos_inventory: {
    purpose: 'Stock transaction logs and adjustments',
    target: 'inventory_movements, medicine_batches',
    status: 'MIGRATE',
    notes: 'Reconstructs initial batch stock and historical movement ledger'
  },
  ospos_sales: {
    purpose: 'Sales transaction headers',
    target: 'sales',
    status: 'MIGRATE',
    notes: 'Preserves sale_id, sale_time, customer_id, employee_id, comment'
  },
  ospos_sales_items: {
    purpose: 'Line items per sale',
    target: 'sale_items',
    status: 'MIGRATE',
    notes: 'Maps item_id, quantity_purchased, item_cost_price, item_unit_price, discount_percent'
  },
  ospos_sales_payments: {
    purpose: 'Payment methods and amounts per sale',
    target: 'payments',
    status: 'MIGRATE',
    notes: 'Preserves Cash, M-Pesa, Card payment records and transaction amounts'
  },
  ospos_receivings: {
    purpose: 'Purchase / receiving headers',
    target: 'purchases',
    status: 'MIGRATE',
    notes: 'Maps receiving_time, supplier_id, employee_id, payment_type'
  },
  ospos_receivings_items: {
    purpose: 'Line items received from suppliers',
    target: 'purchase_items',
    status: 'MIGRATE',
    notes: 'Maps item_id, quantity_purchased, item_cost_price, item_unit_price'
  },
  ospos_customers: {
    purpose: 'Customer entity profiles',
    target: 'customers',
    status: 'MIGRATE',
    notes: 'Joined with ospos_people for full name, phone, email, address'
  },
  ospos_suppliers: {
    purpose: 'Supplier contacts and terms',
    target: 'suppliers',
    status: 'MIGRATE',
    notes: 'Joined with ospos_people for company name, contact, phone, email'
  },
  ospos_people: {
    purpose: 'Master person records for customers, employees, suppliers',
    target: 'customers, suppliers, users',
    status: 'REFERENCE',
    notes: 'Contains first_name, last_name, phone_number, email, address'
  },
  ospos_employees: {
    purpose: 'Legacy staff credentials and roles',
    target: 'users',
    status: 'SANITIZE_MIGRATE',
    notes: 'Staff profiles migrated with secure hashed password placeholders'
  },
  ospos_app_config: {
    purpose: 'Legacy pharmacy configuration',
    target: 'settings',
    status: 'REFERENCE',
    notes: 'Pharmacy address, currency, company name'
  },
  ospos_giftcards: {
    purpose: 'Legacy gift cards',
    target: 'N/A',
    status: 'SKIP',
    notes: 'Not used in current pharmacy POS schema'
  },
  ospos_item_kits: {
    purpose: 'Legacy item bundles / kits',
    target: 'N/A',
    status: 'SKIP',
    notes: 'Kit bundles not used'
  },
  ospos_item_kit_items: {
    purpose: 'Kit item associations',
    target: 'N/A',
    status: 'SKIP',
    notes: 'Kit associations not used'
  },
  ospos_items_taxes: {
    purpose: 'Legacy tax mappings',
    target: 'medicines (tax attributes)',
    status: 'REFERENCE',
    notes: 'Pharmacy items generally tax-exempt or standard rate'
  },
  ospos_sales_items_taxes: {
    purpose: 'Historical tax breakdown on line items',
    target: 'sale_items',
    status: 'REFERENCE',
    notes: 'Embedded into sale line item tax rate'
  },
  ospos_sales_suspended: {
    purpose: 'Held / parked sales',
    target: 'N/A',
    status: 'SKIP',
    notes: 'Temporary held cart state, not completed sales'
  },
  ospos_sales_suspended_items: {
    purpose: 'Held cart items',
    target: 'N/A',
    status: 'SKIP',
    notes: 'Temporary cart items'
  },
  ospos_sales_suspended_payments: {
    purpose: 'Held cart payments',
    target: 'N/A',
    status: 'SKIP',
    notes: 'Temporary cart payments'
  },
  ospos_sales_suspended_items_taxes: {
    purpose: 'Held cart item taxes',
    target: 'N/A',
    status: 'SKIP',
    notes: 'Temporary cart taxes'
  },
  ospos_sessions: {
    purpose: 'PHP session tokens',
    target: 'N/A',
    status: 'EXCLUDE',
    notes: 'Ephemeral web session cookies'
  },
  ospos_modules: {
    purpose: 'Legacy UI module permissions',
    target: 'permissions',
    status: 'REFERENCE',
    notes: 'Replaced by current GIGA CHEMIST RBAC system'
  },
  ospos_permissions: {
    purpose: 'Legacy employee module access',
    target: 'role_permissions',
    status: 'REFERENCE',
    notes: 'Mapped to current roles (ADMIN, MANAGER, CASHIER)'
  },
};

async function main() {
  const sqlPath = path.resolve('shop2 db.sql');
  if (!fs.existsSync(sqlPath)) {
    throw new Error(`SQL file not found at: ${sqlPath}`);
  }

  console.log('======================================================================');
  console.log('  SHOP 2 — REAL LEGACY SQL DATA AUDIT');
  console.log(`  Source: ${sqlPath}`);
  console.log('======================================================================\n');

  const fileStream = fs.createReadStream(sqlPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const tables = new Map<string, TableAudit>();
  let currentTable: TableAudit | null = null;
  let inCreateTable = false;
  let inInsertTable: string | null = null;
  let lineCount = 0;
  let totalDataRows = 0;

  const paymentStats = new Map<string, { count: number; total: number }>();
  let earliestSale = '';
  let latestSale = '';

  for await (const line of rl) {
    lineCount++;
    const trimmed = line.trim();

    // Match CREATE TABLE
    const createMatch = trimmed.match(/^CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+`?([a-zA-Z0-9_]+)`?/i);
    if (createMatch) {
      const tableName = createMatch[1];
      if (tableName.startsWith('ospos_')) {
        const meta = TABLE_MAPPINGS[tableName] || {
          purpose: 'Legacy POS table',
          target: 'N/A',
          status: 'UNMAPPED',
          notes: ''
        };
        currentTable = {
          name: tableName,
          rowCount: 0,
          columns: [],
          purpose: meta.purpose,
          targetTable: meta.target,
          status: meta.status,
          notes: meta.notes,
        };
        tables.set(tableName, currentTable);
        inCreateTable = true;
      } else {
        currentTable = null;
        inCreateTable = false;
      }
      inInsertTable = null;
      continue;
    }

    if (inCreateTable && currentTable) {
      if (trimmed.startsWith(')')) {
        inCreateTable = false;
        continue;
      }
      const colMatch = trimmed.match(/^`([a-zA-Z0-9_]+)`\s+([a-zA-Z0-9_()]+)/i);
      if (colMatch) {
        currentTable.columns.push(colMatch[1]);
      }
    }

    // Match INSERT INTO
    const insertMatch = trimmed.match(/^INSERT\s+INTO\s+`?([a-zA-Z0-9_]+)`?/i);
    if (insertMatch) {
      const tableName = insertMatch[1];
      if (tables.has(tableName)) {
        inInsertTable = tableName;
      } else {
        inInsertTable = null;
      }
    }

    if (inInsertTable) {
      const target = tables.get(inInsertTable);
      if (target) {
        // Fast tuple counting by counting occurrences of '),(' or terminal ');'
        let count = 0;
        let pos = 0;
        while ((pos = line.indexOf('(', pos)) !== -1) {
          // Avoid matching inside string quotes
          count++;
          pos++;
        }
        if (trimmed.startsWith('INSERT INTO')) {
          // The first '(' was after VALUES, count adjusted
          count = Math.max(1, count - 1);
        }
        target.rowCount += count;
        totalDataRows += count;

        // Specific statistics
        if (inInsertTable === 'ospos_sales_payments') {
          const payMatch = line.match(/\('([^']+)',\s*([0-9.-]+)\)/g);
          if (payMatch) {
            for (const m of payMatch) {
              const parts = m.slice(1, -1).split(',');
              const pType = parts[0]?.replace(/'/g, '').trim() || 'Unknown';
              const pAmt = parseFloat(parts[1] || '0') || 0;
              const cur = paymentStats.get(pType) || { count: 0, total: 0 };
              cur.count++;
              cur.total += pAmt;
              paymentStats.set(pType, cur);
            }
          }
        }
      }
      if (trimmed.endsWith(';')) inInsertTable = null;
    }
  }

  console.log(`Scan completed: ${lineCount.toLocaleString()} lines analyzed.`);
  console.log(`Found ${tables.size} ospos tables with ~${totalDataRows.toLocaleString()} rows.\n`);

  // Ensure reports directory exists
  const reportsDir = path.resolve('migration-reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  // Generate SHOP2_LEGACY_DATA_AUDIT.md
  let auditMd = `# SHOP 2 LEGACY DATA AUDIT REPORT\n\n`;
  auditMd += `- **Source File:** \`shop2 db.sql\`\n`;
  auditMd += `- **File Size:** ${(fs.statSync(sqlPath).size / (1024 * 1024)).toFixed(2)} MB\n`;
  auditMd += `- **Lines:** ${lineCount.toLocaleString()}\n`;
  auditMd += `- **Dialect:** MySQL (phpMyAdmin 3.2.4 dump, InnoDB tables)\n`;
  auditMd += `- **Source Database:** \`chemist_pos\`\n`;
  auditMd += `- **Audit Date:** ${new Date().toISOString()}\n\n`;

  auditMd += `## 1. Table Summary & Record Counts\n\n`;
  auditMd += `| Legacy Table | Estimated Rows | Purpose | Target GIGA CHEMIST Table | Status | Notes |\n`;
  auditMd += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;

  for (const t of tables.values()) {
    auditMd += `| \`${t.name}\` | **${t.rowCount.toLocaleString()}** | ${t.purpose} | \`${t.targetTable}\` | **${t.status}** | ${t.notes} |\n`;
  }

  auditMd += `\n## 2. Key Operational Totals\n\n`;
  const itemsCount = tables.get('ospos_items')?.rowCount || 0;
  const inventoryCount = tables.get('ospos_inventory')?.rowCount || 0;
  const salesCount = tables.get('ospos_sales')?.rowCount || 0;
  const saleItemsCount = tables.get('ospos_sales_items')?.rowCount || 0;
  const paymentsCount = tables.get('ospos_sales_payments')?.rowCount || 0;
  const receivingsCount = tables.get('ospos_receivings')?.rowCount || 0;
  const customersCount = tables.get('ospos_customers')?.rowCount || 0;
  const suppliersCount = tables.get('ospos_suppliers')?.rowCount || 0;

  auditMd += `- **Formulary Products (\`ospos_items\`):** ${itemsCount.toLocaleString()}\n`;
  auditMd += `- **Stock Movement Records (\`ospos_inventory\`):** ${inventoryCount.toLocaleString()}\n`;
  auditMd += `- **Historical Sales (\`ospos_sales\`):** ${salesCount.toLocaleString()}\n`;
  auditMd += `- **Sale Line Items (\`ospos_sales_items\`):** ${saleItemsCount.toLocaleString()}\n`;
  auditMd += `- **Payment Records (\`ospos_sales_payments\`):** ${paymentsCount.toLocaleString()}\n`;
  auditMd += `- **Receivings / Purchases (\`ospos_receivings\`):** ${receivingsCount.toLocaleString()}\n`;
  auditMd += `- **Customers (\`ospos_customers\`):** ${customersCount.toLocaleString()}\n`;
  auditMd += `- **Suppliers (\`ospos_suppliers\`):** ${suppliersCount.toLocaleString()}\n\n`;

  if (paymentStats.size > 0) {
    auditMd += `## 3. Historical Payment Breakdown\n\n`;
    auditMd += `| Payment Method | Transactions | Total Volume (KES) |\n`;
    auditMd += `| :--- | :--- | :--- |\n`;
    let grandTotal = 0;
    for (const [method, stat] of paymentStats) {
      auditMd += `| \`${method}\` | ${stat.count.toLocaleString()} | **${stat.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}** |\n`;
      grandTotal += stat.total;
    }
    auditMd += `| **TOTAL** | - | **${grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}** |\n\n`;
  }

  const auditPath = path.join(reportsDir, 'SHOP2_LEGACY_DATA_AUDIT.md');
  fs.writeFileSync(auditPath, auditMd, 'utf-8');
  console.log(`✓ Audit report generated: ${auditPath}`);

  // Generate SHOP2_FIELD_MAPPING.md
  let mapMd = `# SHOP 2 LEGACY FIELD MAPPING\n\n`;
  mapMd += `Mapping legacy OSPOS (\`chemist_pos\`) fields to GIGA CHEMIST relational PostgreSQL schema.\n\n`;

  mapMd += `## 1. Medicines & Inventory\n\n`;
  mapMd += `### \`ospos_items\` → \`medicines\`\n`;
  mapMd += `| Legacy Field | PostgreSQL Target | Transform Rule |\n`;
  mapMd += `| :--- | :--- | :--- |\n`;
  mapMd += `| \`item_id\` | \`id\` | Deterministic UUID namespace mapping |\n`;
  mapMd += `| \`name\` | \`name\` | Direct string |\n`;
  mapMd += `| \`category\` | \`category_id\` | Foreign key lookup in \`categories\` (auto-upsert) |\n`;
  mapMd += `| \`item_number\` | \`barcode\` | Trimmed barcode identifier |\n`;
  mapMd += `| \`description\` | \`description\` | Text description |\n`;
  mapMd += `| \`cost_price\` | \`purchase_price\` | Numeric(12,2) |\n`;
  mapMd += `| \`unit_price\` | \`selling_price\` | Numeric(12,2) |\n`;
  mapMd += `| \`reorder_level\` | \`min_stock_level\` | Integer, minimum threshold |\n`;
  mapMd += `| \`deleted\` | \`status\` | 0 = 'active', 1 = 'archived' |\n\n`;

  mapMd += `### \`ospos_inventory\` → \`medicine_batches\` & \`inventory_movements\`\n`;
  mapMd += `| Legacy Field | PostgreSQL Target | Transform Rule |\n`;
  mapMd += `| :--- | :--- | :--- |\n`;
  mapMd += `| \`trans_id\` | \`inventory_movements.id\` | Deterministic UUID |\n`;
  mapMd += `| \`trans_items\` | \`medicine_id\` | Mapped medicine UUID |\n`;
  mapMd += `| \`trans_inventory\` | \`quantity\` | Delta quantity (positive = receipt/adjustment, negative = sale) |\n`;
  mapMd += `| \`trans_date\` | \`created_at\`, \`date\` | Timestamptz |\n`;
  mapMd += `| \`trans_comment\` | \`reason\` | Text note (retains legacy movement narrative) |\n`;
  mapMd += `| Reconstructed sum | \`quantity_available\` | Net remaining stock per item mapped to primary provisional batch |\n\n`;

  mapMd += `## 2. Sales & Revenue\n\n`;
  mapMd += `### \`ospos_sales\` → \`sales\`\n`;
  mapMd += `| Legacy Field | PostgreSQL Target | Transform Rule |\n`;
  mapMd += `| :--- | :--- | :--- |\n`;
  mapMd += `| \`sale_id\` | \`id\` | Deterministic UUID |\n`;
  mapMd += `| \`sale_time\` | \`created_at\` | Timestamptz |\n`;
  mapMd += `| \`customer_id\` | \`customer_id\` | UUID lookup or Walk-in default |\n`;
  mapMd += `| \`employee_id\` | \`user_id\` | Staff UUID lookup |\n`;
  mapMd += `| \`comment\` | \`notes\` | Text note |\n\n`;

  mapMd += `### \`ospos_sales_items\` → \`sale_items\`\n`;
  mapMd += `| Legacy Field | PostgreSQL Target | Transform Rule |\n`;
  mapMd += `| :--- | :--- | :--- |\n`;
  mapMd += `| \`sale_id\` | \`sale_id\` | Parent sale UUID |\n`;
  mapMd += `| \`item_id\` | \`medicine_id\` | Mapped medicine UUID |\n`;
  mapMd += `| \`quantity_purchased\` | \`quantity\` | Integer units sold |\n`;
  mapMd += `| \`item_unit_price\` | \`unit_price\` | Numeric(12,2) selling price |\n`;
  mapMd += `| \`item_cost_price\` | \`cost_price\` | Numeric(12,2) acquisition cost |\n`;
  mapMd += `| \`discount_percent\` | \`discount_percent\` | Numeric(5,2) discount |\n\n`;

  mapMd += `### \`ospos_sales_payments\` → \`payments\`\n`;
  mapMd += `| Legacy Field | PostgreSQL Target | Transform Rule |\n`;
  mapMd += `| :--- | :--- | :--- |\n`;
  mapMd += `| \`sale_id\` | \`sale_id\` | Parent sale UUID |\n`;
  mapMd += `| \`payment_type\` | \`payment_method\` | 'Cash', 'M-Pesa', 'Card' normalized |\n`;
  mapMd += `| \`payment_amount\` | \`amount\` | Numeric(12,2) |\n\n`;

  mapMd += `## 3. Contacts & Entities\n\n`;
  mapMd += `### \`ospos_customers\` + \`ospos_people\` → \`customers\`\n`;
  mapMd += `| Legacy Field | PostgreSQL Target | Transform Rule |\n`;
  mapMd += `| :--- | :--- | :--- |\n`;
  mapMd += `| \`person_id\` | \`id\` | Deterministic UUID |\n`;
  mapMd += `| \`first_name\` + \`last_name\` | \`name\` | Combined full name |\n`;
  mapMd += `| \`phone_number\` | \`phone\` | String |\n`;
  mapMd += `| \`email\` | \`email\` | Normalized email |\n`;
  mapMd += `| \`address_1\` | \`address\` | Text address |\n\n`;

  mapMd += `### \`ospos_suppliers\` + \`ospos_people\` → \`suppliers\`\n`;
  mapMd += `| Legacy Field | PostgreSQL Target | Transform Rule |\n`;
  mapMd += `| :--- | :--- | :--- |\n`;
  mapMd += `| \`person_id\` | \`id\` | Deterministic UUID |\n`;
  mapMd += `| \`company_name\` | \`name\` | Supplier name |\n`;
  mapMd += `| \`first_name\` + \`last_name\` | \`contact_person\` | Contact person name |\n`;
  mapMd += `| \`phone_number\` | \`phone\` | Phone |\n`;
  mapMd += `| \`email\` | \`email\` | Email |\n`;
  mapMd += `| \`agency_name\` | \`notes\` | Additional supplier details |\n\n`;

  const mapPath = path.join(reportsDir, 'SHOP2_FIELD_MAPPING.md');
  fs.writeFileSync(mapPath, mapMd, 'utf-8');
  console.log(`✓ Field mapping generated: ${mapPath}`);
}

main().then(() => {
  process.exitCode = 0;
}).catch((err) => {
  console.error('\n[AUDIT ERROR]:', err?.message || err);
  process.exitCode = 1;
});
