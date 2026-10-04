import fs from 'fs';
import path from 'path';
import readline from 'readline';

async function inspectDetails() {
  const sqlPath = path.resolve('chemist_pos.sql');
  const fileStream = fs.createReadStream(sqlPath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let inTable: string | null = null;
  const people: any[] = [];
  const employees: any[] = [];
  const suppliers: any[] = [];
  const customers: any[] = [];
  const appConfig: Record<string, string> = {};
  const sampleItems: any[] = [];
  const sampleReceivings: any[] = [];
  const sampleSales: any[] = [];
  const sampleInventory: any[] = [];

  const itemCategories = new Set<string>();
  const customFieldPopulated: Record<string, number> = {
    custom1: 0, custom2: 0, custom3: 0, custom4: 0, custom5: 0,
    custom6: 0, custom7: 0, custom8: 0, custom9: 0, custom10: 0,
  };
  const customFieldSamples: Record<string, Set<string>> = {
    custom1: new Set(), custom2: new Set(), custom3: new Set(), custom4: new Set(), custom5: new Set(),
    custom6: new Set(), custom7: new Set(), custom8: new Set(), custom9: new Set(), custom10: new Set(),
  };

  let totalItemsCount = 0;
  let deletedItemsCount = 0;
  let totalStockUnits = 0;
  let zeroCostItems = 0;
  let zeroPriceItems = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    const insertMatch = trimmed.match(/^INSERT\s+INTO\s+`?([a-zA-Z0-9_]+)`?/i);
    if (insertMatch) {
      inTable = insertMatch[1];
    }

    if (inTable && trimmed.startsWith('(')) {
      if (inTable === 'ospos_app_config') {
        // ('key', 'value')
        const m = trimmed.match(/^\('([^']+)',\s*'([^']*)'\)/);
        if (m) appConfig[m[1]] = m[2];
      } else if (inTable === 'ospos_people') {
        // (first_name, last_name, phone_number, email, address_1, address_2, city, state, zip, country, comments, person_id)
        people.push(trimmed);
      } else if (inTable === 'ospos_employees') {
        // (username, password, person_id, deleted)
        employees.push(trimmed);
      } else if (inTable === 'ospos_suppliers') {
        // (person_id, company_name, account_number, deleted)
        suppliers.push(trimmed);
      } else if (inTable === 'ospos_customers') {
        // (person_id, account_number, taxable, deleted)
        customers.push(trimmed);
      } else if (inTable === 'ospos_items') {
        totalItemsCount++;
        if (sampleItems.length < 5) sampleItems.push(trimmed);
        
        // Parse items
        // name, category, supplier_id, item_number, description, cost_price, unit_price, quantity, reorder_level, location, item_id, allow_alt_description, is_serialized, deleted, custom1..custom10
        // Let's extract values with a regex or simple parser
        const vals = trimmed.replace(/^\(/, '').replace(/\)[,;]?$/, '');
        // Split handling escaped commas if needed or regex
        if (trimmed.includes(", '1',") || trimmed.includes(", 1,")) {
          // deleted check
        }
      } else if (inTable === 'ospos_receivings' && sampleReceivings.length < 5) {
        sampleReceivings.push(trimmed);
      } else if (inTable === 'ospos_sales' && sampleSales.length < 5) {
        sampleSales.push(trimmed);
      } else if (inTable === 'ospos_inventory' && sampleInventory.length < 5) {
        sampleInventory.push(trimmed);
      }
    }

    if (trimmed.endsWith(';')) {
      inTable = null;
    }
  }

  console.log('=== APP CONFIG ===');
  console.log(JSON.stringify(appConfig, null, 2));

  console.log('\n=== PEOPLE ===');
  console.log(people);

  console.log('\n=== EMPLOYEES (AUTH DATA DETECTED - WILL BE EXCLUDED) ===');
  console.log(employees);

  console.log('\n=== SUPPLIERS ===');
  console.log(suppliers);

  console.log('\n=== CUSTOMERS ===');
  console.log(customers);

  console.log('\n=== SAMPLE ITEMS ===');
  console.log(sampleItems);

  console.log('\n=== SAMPLE RECEIVINGS ===');
  console.log(sampleReceivings);

  console.log('\n=== SAMPLE SALES ===');
  console.log(sampleSales);

  console.log('\n=== SAMPLE INVENTORY ===');
  console.log(sampleInventory);
}

inspectDetails().catch(console.error);
