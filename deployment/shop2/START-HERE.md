# SHOP 2 DEPLOYMENT — OPERATOR START HERE

Follow these sequential phases to prepare and deploy Shop 2:

---

## PHASE 1: LEGACY SQLITE DATA MIGRATION (Development PC)
1. **Receive SQLite File**: Place the legacy Shop 2 POS database into `deployment/shop2/migration/backup/shop2-legacy.db`.
2. **Inspect & Audit**: Run the schema analyzer:
   ```powershell
   npx tsx deployment/shop2/migration/analyze-shop2-sqlite.ts
   ```
3. **Execute Migration**: Import into `giga_chemist_shop2_dev`:
   ```powershell
   npx tsx deployment/shop2/migration/migrate-shop2.ts
   ```
4. **Audit Financials & Stock**: Confirm zero missing records, correct balances, and positive quantities:
   ```powershell
   npx tsx deployment/shop2/migration/validate-shop2-migration.ts
   ```

---

## PHASE 2: PACKAGE CREATION (Development PC)
Compile the standalone deployment bundle:
```powershell
powershell -ExecutionPolicy Bypass -File deployment/shop2/build-shop2-package.ps1
```
Result: `deployment/shop2/release/GIGA-CHEMIST-SHOP2-PACKAGE/`

---

## PHASE 3: PHYSICAL SHOP 2 INSTALLATION (Shop 2 PC)
1. Copy `GIGA-CHEMIST-SHOP2-PACKAGE` to `C:\GIGA-CHEMIST-POS` on the Shop 2 computer.
2. Initialize local PostgreSQL database `giga_chemist_shop2`.
3. Restore migrated data.
4. Launch local GIGA CHEMIST service in offline mode (`APP_MODE=local`).
5. Confirm local sales, stock lookup, and receipts operate smoothly.

---

## PHASE 4: CLOUD ACTIVATION (Planned Future Phase)
Once offline operation is verified:
1. Register unique Shop 2 identity on Supabase.
2. Run `ACTIVATE-SHOP2-ONLINE.ps1`.
3. Verify authoritative mirror parity.
