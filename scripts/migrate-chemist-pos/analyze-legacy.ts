import fs from 'fs';
import path from 'path';
import readline from 'readline';

interface TableMeta {
  name: string;
  columns: { name: string; type: string; isNullable: boolean; isPrimary: boolean }[];
  primaryKeys: string[];
  rowCount: number;
}

async function analyzeLegacySql(sqlFilePath: string) {
  console.log(`Deep analyzing legacy database dump: ${sqlFilePath}`);
  const startTime = Date.now();

  const fileStream = fs.createReadStream(sqlFilePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const tables: Map<string, TableMeta> = new Map();
  let currentTable: TableMeta | null = null;
  let inCreateTable = false;
  let inInsertTable: string | null = null;
  let totalRows = 0;
  let dumpHeader = '';
  let lineCount = 0;

  const paymentTypes = new Map<string, { count: number; totalAmount: number }>();
  let earliestSale = '';
  let latestSale = '';

  for await (const line of rl) {
    lineCount++;
    if (lineCount <= 20) {
      dumpHeader += line + '\n';
    }

    const trimmed = line.trim();

    // Match CREATE TABLE
    const createMatch = trimmed.match(/^CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+`?([a-zA-Z0-9_]+)`?/i);
    if (createMatch) {
      const tableName = createMatch[1];
      currentTable = {
        name: tableName,
        columns: [],
        primaryKeys: [],
        rowCount: 0,
      };
      tables.set(tableName, currentTable);
      inCreateTable = true;
      inInsertTable = null;
      continue;
    }

    if (inCreateTable && currentTable) {
      if (trimmed.startsWith(')')) {
        inCreateTable = false;
        continue;
      }

      // Match PRIMARY KEY
      const pkMatch = trimmed.match(/^PRIMARY\s+KEY\s*\((.*?)\)/i);
      if (pkMatch) {
        const pks = pkMatch[1].split(',').map((s) => s.replace(/[`\s]/g, ''));
        currentTable.primaryKeys.push(...pks);
        pks.forEach((pk) => {
          const col = currentTable?.columns.find((c) => c.name === pk);
          if (col) col.isPrimary = true;
        });
        continue;
      }

      // Match columns
      const colMatch = trimmed.match(/^`?([a-zA-Z0-9_]+)`?\s+([a-zA-Z0-9_]+(?:\([0-9,\s]+\))?)(.*?)(?:,|$)/i);
      if (colMatch && !trimmed.startsWith('KEY') && !trimmed.startsWith('UNIQUE') && !trimmed.startsWith('CONSTRAINT') && !trimmed.startsWith('FULLTEXT')) {
        const colName = colMatch[1];
        const colType = colMatch[2];
        const colRest = colMatch[3] || '';
        const isNullable = !colRest.toUpperCase().includes('NOT NULL');
        currentTable.columns.push({
          name: colName,
          type: colType,
          isNullable,
          isPrimary: false,
        });
      }
      continue;
    }

    // Match start of INSERT INTO
    const insertMatch = trimmed.match(/^INSERT\s+INTO\s+`?([a-zA-Z0-9_]+)`?/i);
    if (insertMatch) {
      inInsertTable = insertMatch[1];
      const table = tables.get(inInsertTable);
      
      // Check if VALUES are on the same line
      const valuesIdx = trimmed.indexOf('VALUES');
      if (valuesIdx !== -1) {
        const rest = trimmed.substring(valuesIdx + 6).trim();
        if (rest.startsWith('(')) {
          if (table) table.rowCount++;
          totalRows++;
        }
      }
      if (trimmed.endsWith(';')) {
        inInsertTable = null;
      }
      continue;
    }

    // Inside multi-line INSERT block
    if (inInsertTable) {
      if (trimmed.startsWith('(')) {
        const table = tables.get(inInsertTable);
        if (table) table.rowCount++;
        totalRows++;

        // Detailed extraction for key tables
        if (inInsertTable === 'ospos_sales_payments') {
          // e.g. (1, 'Cash', '150.00'),
          const match = trimmed.match(/^\((\d+),\s*'([^']+)',\s*'?([0-9.-]+)'?\)/);
          if (match) {
            const pType = match[2];
            const pAmt = parseFloat(match[3]) || 0;
            const existing = paymentTypes.get(pType) || { count: 0, totalAmount: 0 };
            existing.count++;
            existing.totalAmount += pAmt;
            paymentTypes.set(pType, existing);
          }
        } else if (inInsertTable === 'ospos_sales') {
          // (sale_time, customer_id, employee_id, comment, sale_id, payment_type)
          const match = trimmed.match(/^\('([^']+)',/);
          if (match) {
            const sDate = match[1];
            if (!earliestSale || sDate < earliestSale) earliestSale = sDate;
            if (!latestSale || sDate > latestSale) latestSale = sDate;
          }
        }
      }

      if (trimmed.endsWith(';')) {
        inInsertTable = null;
      }
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`Analyzed ${lineCount.toLocaleString()} lines in ${duration}s.`);
  console.log(`Found ${tables.size} tables with ${totalRows.toLocaleString()} total data rows.\n`);

  return {
    dumpHeader,
    lineCount,
    duration,
    totalRows,
    tables: Array.from(tables.values()),
    paymentTypes: Array.from(paymentTypes.entries()),
    earliestSale,
    latestSale,
  };
}

async function main() {
  const sqlPath = path.resolve('chemist_pos.sql');
  if (!fs.existsSync(sqlPath)) {
    console.error(`File not found: ${sqlPath}`);
    process.exit(1);
  }

  const result = await analyzeLegacySql(sqlPath);

  // Generate Markdown report
  let md = `# Legacy Database Audit Report — \`chemist_pos.sql\`\n\n`;
  md += `**Audit Date:** ${new Date().toISOString()}\n`;
  md += `**Source File:** \`chemist_pos.sql\` (${(fs.statSync(sqlPath).size / (1024 * 1024)).toFixed(2)} MB, ${result.lineCount.toLocaleString()} lines)\n\n`;

  md += `## 1. Dump Metadata\n\n`;
  md += `\`\`\`sql\n${result.dumpHeader.trim()}\n\`\`\`\n\n`;

  md += `## 2. Table Summary & Accurate Row Counts\n\n`;
  md += `| Table Name | Row Count | Primary Key(s) | Column Count | Status / Classification |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- |\n`;

  for (const table of result.tables) {
    let classification = 'Business Data';
    if (['ospos_employees', 'ospos_sessions'].includes(table.name)) {
      classification = '⚠️ **Auth / Security (EXCLUDE PASSWORDS)**';
    } else if (['ospos_app_config'].includes(table.name)) {
      classification = '⚙️ Configuration';
    } else if (['ospos_items', 'ospos_inventory', 'ospos_item_kits', 'ospos_item_kit_items'].includes(table.name)) {
      classification = '📦 Products & Inventory';
    } else if (['ospos_sales', 'ospos_sales_items', 'ospos_sales_payments', 'ospos_sales_items_taxes', 'ospos_sales_suspended', 'ospos_sales_suspended_items', 'ospos_sales_suspended_payments'].includes(table.name)) {
      classification = '💰 Sales & Transactions';
    } else if (['ospos_receivings', 'ospos_receivings_items'].includes(table.name)) {
      classification = '🚚 Purchases / Receivings';
    } else if (['ospos_customers', 'ospos_suppliers', 'ospos_people'].includes(table.name)) {
      classification = '👥 Contacts & Entities';
    }

    md += `| \`${table.name}\` | **${table.rowCount.toLocaleString()}** | ${table.primaryKeys.map((p) => `\`${p}\``).join(', ') || 'None'} | ${table.columns.length} | ${classification} |\n`;
  }

  md += `\n**Total Data Rows:** ${result.totalRows.toLocaleString()}\n\n`;

  md += `## 3. Historical Sales & Payment Summary\n\n`;
  md += `- **Date Range:** \`${result.earliestSale || 'N/A'}\` to \`${result.latestSale || 'N/A'}\`\n\n`;
  md += `### Payment Breakdown in Legacy Dump\n\n`;
  md += `| Payment Type | Transaction Count | Total Amount (KES) |\n`;
  md += `| :--- | :--- | :--- |\n`;
  let totalPayments = 0;
  for (const [pType, pInfo] of result.paymentTypes) {
    md += `| \`${pType}\` | ${pInfo.count.toLocaleString()} | **${pInfo.totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}** |\n`;
    totalPayments += pInfo.totalAmount;
  }
  md += `| **TOTAL** | - | **${totalPayments.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}** |\n\n`;

  md += `## 4. Detailed Schema Structure per Table\n\n`;
  for (const table of result.tables) {
    md += `### Table: \`${table.name}\` (${table.rowCount.toLocaleString()} rows)\n\n`;
    md += `| Column | Type | Nullable | Primary Key |\n`;
    md += `| :--- | :--- | :--- | :--- |\n`;
    for (const col of table.columns) {
      md += `| \`${col.name}\` | \`${col.type}\` | ${col.isNullable ? 'YES' : 'NO'} | ${col.isPrimary ? '🔑 YES' : 'NO'} |\n`;
    }
    md += `\n`;
  }

  const outPath = path.resolve('docs/LEGACY_DATA_AUDIT.md');
  fs.writeFileSync(outPath, md, 'utf-8');
  console.log(`Audit report generated at: ${outPath}`);
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
