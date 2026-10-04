# GIGA CHEMIST — PostgreSQL Database Import & Setup Guide (Windows 11)

This package contains the fully populated, production-ready PostgreSQL database export for **GIGA CHEMIST**, including complete schema, initial formulary, stock levels, historical sales, payments, purchases, and inventory movement audit logs.

---

## Files in this Package

- `giga_chemist_full.sql` — Standalone, full PostgreSQL database schema + data export (Self-contained).
- `verify-import.sql` — SQL verification script to validate row counts, stock balances, and security.
- `IMPORT_README.md` — This setup guide.

---

## Step 1: Install PostgreSQL on Windows 11 (If not already installed)

1. Download and install **PostgreSQL 15 or 16** for Windows from [postgresql.org](https://www.postgresql.org/download/windows/).
2. During setup, choose a password for the `postgres` superuser (e.g. your local secure password).
3. Ensure PostgreSQL service is running on port `5432`.

---

## Step 2: Create the Target Database

Open **PowerShell** or **Command Prompt** and create the `giga_chemist` database:

```cmd
psql -U postgres -c "CREATE DATABASE giga_chemist;"
```

*(Enter your postgres password when prompted)*

---

## Step 3: Import the Full Database Export

Run the SQL import command:

```cmd
psql -U postgres -d giga_chemist -f giga_chemist_full.sql
```

> **Note:** The import takes approximately 15–45 seconds depending on your disk speed. It ingests all tables, constraints, indexes, triggers, and 767,000+ data records in a single transactional block.

---

## Step 4: Verify the Imported Database

Run the automated verification script:

```cmd
psql -U postgres -d giga_chemist -f verify-import.sql
```

### Expected Verification Results:
- **Medicines Formulary:** `2,181` (`PASS`)
- **Medicine Batches:** `2,181` (`PASS`)
- **Sales Transactions:** `135,818` (`PASS`)
- **Sale Line Items:** `226,401` (`PASS`)
- **Payment Records:** `135,817` (`PASS`)
- **Purchases (Receivings):** `728` (`PASS`)
- **Purchase Line Items:** `2,524` (`PASS`)
- **Inventory Movement History:** `263,107` (`PASS`)
- **Total Stock Units:** `43,686` (`PASS`)
- **Fake Expiry Dates (2029-12-31):** `0` (`PASS`)
- **Leaked MD5 / Plaintext Passwords:** `0` (`PASS`)
- **Locked Legacy Accounts:** `5` (`PASS`)

---

## Step 5: Configure Application Environment

In your GIGA CHEMIST root folder, ensure `.env` has your PostgreSQL connection string:

```env
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@127.0.0.1:5432/giga_chemist
PORT=3000
NODE_ENV=production
```

---

## Step 6: Create the Admin User

Because legacy passwords and MD5 hashes were excluded for security, all 5 migrated staff accounts are locked. Create your active administrator account:

```cmd
npm run create-admin
```

Follow the prompts to set up your administrator email, secure password, and POS PIN.

---

## Step 7: Start GIGA CHEMIST

Start the system on Windows 11:

```cmd
.\start-giga-chemist.bat
```

Or manually:

```cmd
npm run build
npm start
```

Access the POS in your browser at `http://localhost:3000`.
