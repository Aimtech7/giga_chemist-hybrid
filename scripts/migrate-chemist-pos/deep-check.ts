import fs from 'fs';
import path from 'path';
import readline from 'readline';

async function deepCheckItemsAndBatches() {
  const sqlPath = path.resolve('chemist_pos.sql');
  const fileStream = fs.createReadStream(sqlPath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let inTable: string | null = null;
  const nonZeroCustoms: Record<string, number> = {};
  const categories = new Map<string, number>();
  let deletedItems = 0;
  let itemsWithSupplier = 0;
  let itemsWithItemNumber = 0;
  let totalLegacyQuantity = 0;
  let positiveStockItems = 0;
  let zeroStockItems = 0;
  let negativeStockItems = 0;

  // Check receivings description / serialnumber for batch info
  const receivingDescriptions = new Set<string>();
  const receivingSerialNumbers = new Set<string>();

  for await (const line of rl) {
    const trimmed = line.trim();
    const insertMatch = trimmed.match(/^INSERT\s+INTO\s+`?([a-zA-Z0-9_]+)`?/i);
    if (insertMatch) {
      inTable = insertMatch[1];
    }

    if (inTable === 'ospos_items' && trimmed.startsWith('(')) {
      // Regex or parser to extract fields
      // name, category, supplier_id, item_number, description, cost_price, unit_price, quantity, reorder_level, location, item_id, allow_alt_description, is_serialized, deleted, custom1..custom10
      // We can use a regex or split
      // Example line: ('ABZ 10ml susp', 'syrup', NULL, NULL, '', 40.00, 70.00, 13.00, 0.00, '', 1, 0, 0, 0, '0', '0', '0', '0', '0', '0', '0', '0', '0', '0'),
      const catMatch = trimmed.match(/^\('([^']*)',\s*'([^']*)',\s*(NULL|\d+),\s*(NULL|'[^']*'),\s*'([^']*)',\s*([0-9.-]+),\s*([0-9.-]+),\s*([0-9.-]+),\s*([0-9.-]+),\s*'([^']*)',\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'\)/);
      if (catMatch) {
        const cat = catMatch[2].trim();
        categories.set(cat, (categories.get(cat) || 0) + 1);
        if (catMatch[3] !== 'NULL') itemsWithSupplier++;
        if (catMatch[4] !== 'NULL') itemsWithItemNumber++;
        const qty = parseFloat(catMatch[8]) || 0;
        totalLegacyQuantity += qty;
        if (qty > 0) positiveStockItems++;
        else if (qty === 0) zeroStockItems++;
        else negativeStockItems++;

        const isDeleted = parseInt(catMatch[14], 10) === 1;
        if (isDeleted) deletedItems++;

        // custom1 to custom10 are indices 15 to 24
        for (let i = 1; i <= 10; i++) {
          const val = catMatch[14 + i];
          if (val && val !== '0' && val !== '') {
            nonZeroCustoms[`custom${i}`] = (nonZeroCustoms[`custom${i}`] || 0) + 1;
          }
        }
      }
    } else if (inTable === 'ospos_receivings_items' && trimmed.startsWith('(')) {
      // receiving_id, item_id, description, serialnumber, line, quantity_purchased, item_cost_price, item_unit_price, discount_percent
      const m = trimmed.match(/^\((\d+),\s*(\d+),\s*(NULL|'[^']*'),\s*(NULL|'[^']*')/);
      if (m) {
        if (m[3] !== 'NULL' && m[3] !== "''") receivingDescriptions.add(m[3]);
        if (m[4] !== 'NULL' && m[4] !== "''") receivingSerialNumbers.add(m[4]);
      }
    }

    if (trimmed.endsWith(';')) {
      inTable = null;
    }
  }

  console.log('=== ITEMS AUDIT ===');
  console.log(`Distinct Categories: ${categories.size}`);
  console.log(`Deleted Items: ${deletedItems}`);
  console.log(`Items with Supplier Linked: ${itemsWithSupplier}`);
  console.log(`Items with Item Number/Barcode: ${itemsWithItemNumber}`);
  console.log(`Total Stock Units in Legacy: ${totalLegacyQuantity.toLocaleString()}`);
  console.log(`Positive Stock Items: ${positiveStockItems}`);
  console.log(`Zero Stock Items: ${zeroStockItems}`);
  console.log(`Negative Stock Items: ${negativeStockItems}`);
  console.log(`Non-zero custom fields found:`, nonZeroCustoms);

  console.log('\nTop 20 Categories:');
  const sortedCats = Array.from(categories.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20);
  console.log(sortedCats);

  console.log('\nReceiving Items with descriptions or serials:');
  console.log('Descriptions count:', receivingDescriptions.size);
  console.log('Serial numbers count:', receivingSerialNumbers.size);
}

deepCheckItemsAndBatches().catch(console.error);
