process.env.APP_MODE = 'hybrid';
import fs from 'fs';
import path from 'path';
import { check, section, summary } from './harness';
import { ACTIONS, shopSupportsStockOverride, shopSupportsMedicineDelete } from '../../server/online/remoteAdmin';
import { COMMAND_TYPES, ALL_SHOPS_TYPES } from '../../server/sync/commandSchema';
import { SUPPORTED_COMMANDS } from '../../server/sync/commands';

async function run() {
  section('ONLINE ADMIN COMPLETE PARITY AUDIT & RBAC GATING');

  // 1. Verify docs/ONLINE_ADMIN_PARITY.md
  const docPath = path.resolve('docs/ONLINE_ADMIN_PARITY.md');
  check(fs.existsSync(docPath), '1.1 docs/ONLINE_ADMIN_PARITY.md exists');
  const docContent = fs.readFileSync(docPath, 'utf-8');

  const requiredSections = [
    'Medicines', 'Inventory', 'Batches', 'Expiry', 'Purchases', 'Suppliers',
    'Customers', 'Sales', 'Returns', 'Expenses', 'Reports', 'Users', 'Shifts',
    'Stocktakes', 'Settings', 'Audit Logs', 'Alerts', 'Sync Center', 'Backups',
    'Health', 'Updates'
  ];

  for (const s of requiredSections) {
    check(docContent.includes(s), `1.2 Parity doc covers ${s}`);
  }

  // 2. Verify all Command Types have registered Handlers
  section('COMMAND SCHEMA & HANDLER COMPLETENESS');
  check(COMMAND_TYPES.includes('STOCK_OVERRIDE_ADD'), '2.1 STOCK_OVERRIDE_ADD in COMMAND_TYPES');
  check(COMMAND_TYPES.includes('STOCK_OVERRIDE_REMOVE'), '2.2 STOCK_OVERRIDE_REMOVE in COMMAND_TYPES');
  check(COMMAND_TYPES.includes('STOCK_OVERRIDE_SET'), '2.3 STOCK_OVERRIDE_SET in COMMAND_TYPES');
  check(COMMAND_TYPES.includes('STOCK_SNAPSHOT_REQUEST'), '2.4 STOCK_SNAPSHOT_REQUEST in COMMAND_TYPES');
  check(COMMAND_TYPES.includes('MEDICINE_DELETE'), '2.5 MEDICINE_DELETE in COMMAND_TYPES');

  for (const cmdType of COMMAND_TYPES) {
    check(SUPPORTED_COMMANDS.includes(cmdType), `2.6 Handler exists for ${cmdType}`);
  }

  // 3. Verify Remote Actions Mapping in online server
  section('REMOTE ACTIONS ROUTING COMPLETENESS');
  check(ACTIONS['stock-override-add'] === 'STOCK_OVERRIDE_ADD', '3.1 stock-override-add mapped');
  check(ACTIONS['stock-override-remove'] === 'STOCK_OVERRIDE_REMOVE', '3.2 stock-override-remove mapped');
  check(ACTIONS['stock-override-set'] === 'STOCK_OVERRIDE_SET', '3.3 stock-override-set mapped');
  check(ACTIONS['stock-snapshot-request'] === 'STOCK_SNAPSHOT_REQUEST', '3.4 stock-snapshot-request mapped');
  check(ACTIONS['medicine-delete'] === 'MEDICINE_DELETE', '3.5 medicine-delete mapped');

  // 4. Verify Stock Overrides are NOT in ALL_SHOPS_TYPES (Single shop only)
  section('ALL SHOPS WILDCARD FANOUT PROHIBITION');
  check(!ALL_SHOPS_TYPES.includes('STOCK_OVERRIDE_ADD'), '4.1 STOCK_OVERRIDE_ADD blocked from All Shops fanout');
  check(!ALL_SHOPS_TYPES.includes('STOCK_OVERRIDE_REMOVE'), '4.2 STOCK_OVERRIDE_REMOVE blocked from All Shops fanout');
  check(!ALL_SHOPS_TYPES.includes('STOCK_OVERRIDE_SET'), '4.3 STOCK_OVERRIDE_SET blocked from All Shops fanout');
  check(!ALL_SHOPS_TYPES.includes('STOCK_SNAPSHOT_REQUEST'), '4.4 STOCK_SNAPSHOT_REQUEST blocked from All Shops fanout');

  // 5. Verify Capability Gating
  section('CAPABILITY GATE VERIFICATION');
  const oldShopRuntime = {
    git_commit: '5fee286f59d7b80f291a126c0a4c745321705fef',
    capabilities: ['STOCK_ADD', 'STOCK_REMOVE'],
  };
  const capDelete = shopSupportsMedicineDelete(oldShopRuntime);
  check(!capDelete.supported, '5.1 Old shop release blocked from remote medicine delete');

  const capOverride = shopSupportsStockOverride(oldShopRuntime, 'STOCK_OVERRIDE_ADD');
  check(!capOverride.supported, '5.2 Old shop release without capability blocked from STOCK_OVERRIDE_ADD');

  const newShopRuntime = {
    git_commit: 'abcdef1234567890',
    capabilities: [
      'MEDICINE_DELETE',
      'STOCK_OVERRIDE_ADD',
      'STOCK_OVERRIDE_REMOVE',
      'STOCK_OVERRIDE_SET',
      'STOCK_SNAPSHOT_REQUEST',
    ],
  };
  const capNew = shopSupportsStockOverride(newShopRuntime, 'STOCK_OVERRIDE_ADD');
  check(capNew.supported, '5.3 Up-to-date shop release with capability permitted');

  const code = summary();
  process.exit(code);
}

void run();
