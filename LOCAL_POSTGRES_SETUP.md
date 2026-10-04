# GIGA CHEMIST — Local PostgreSQL & Hybrid Deployment Guide

Comprehensive installation, configuration, and operations manual for running GIGA CHEMIST Pharmacy POS on a local Windows server, on-premise local area network (LAN), or in hybrid cloud synchronization mode.

---

## 1. Overview

GIGA CHEMIST is an enterprise-grade pharmacy point-of-sale and inventory management system. It supports **Hybrid Deployment Architecture**:

- **Local Server Mode (`APP_MODE=local`):** The entire application (backend API, frontend PWA, and authoritative PostgreSQL database) runs completely on a local Windows PC. It requires zero internet access for sales, dispensing, inventory adjustments, receipts, and reporting.
- **Cloud Mode (`APP_MODE=cloud`):** The application connects directly to Supabase cloud PostgreSQL for multi-branch organizations with constant internet connectivity.
- **Hybrid Mode (`APP_MODE=hybrid`):** Transactions and inventory movements are committed to the local PostgreSQL database immediately with zero latency. When internet connectivity is detected, local transactions synchronize to the cloud Supabase database without risking stock loss or duplicate transactions.

> **Note:** Supabase cloud support is NOT removed. You can toggle between Local, Cloud, and Hybrid modes using simple environment variables in `.env`.

---

## 2. Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                 Client Terminals & Tablets                  │
│  - Primary Cashier Register (Local Browser / PWA)           │
│  - Secondary Counter Terminals on LAN (http://192.168.x.x)  │
│  - Offline Cache & Dexie IndexedDB                          │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP / WebSocket (Port 3000)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 GIGA CHEMIST Local Server                   │
│  - Node.js / Express Backend (Binding: 0.0.0.0:3000)        │
│  - JWT Authentication & RBAC Authorization Middleware       │
│  - Response Shaping (Cashier Cost Data Privacy)             │
│  - Static PWA Frontend Hosting                              │
└──────────────────────────────┬──────────────────────────────┘
                               │ TCP (Port 5432)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                  Local PostgreSQL Server                    │
│  - Authoritative On-Premise Relational Database             │
│  - Strict Relational Constraints & Atomic Transactions      │
│  - Salted PBKDF2 Hashed Password & PIN Directory            │
│  - Immutable Audit Log & Sync Queue Tables                  │
└──────────────────────────────┬──────────────────────────────┘
                               │ Optional Hybrid Sync (Internet)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     Supabase Cloud                          │
│  - Multi-Branch Cloud Persistence & Remote Dashboard        │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Requirements

### Hardware Recommendations
- **Processor:** 64-bit Dual Core or Quad Core Intel/AMD CPU (2.0 GHz+).
- **RAM:** 4 GB minimum (8 GB recommended for busy pharmacy servers).
- **Storage:** 20 GB free disk space (SSD strongly recommended).
- **Network:** Standard 100 Mbps / 1 Gbps Ethernet Switch or Wi-Fi Router for LAN multi-counter access.

### Software & Operating System Compatibility
- **Operating Systems:**
  - Windows 11 / Windows 10 / Windows 8.1 (Full Support).
  - Windows Server 2016 / 2019 / 2022 (Full Support).
  - Windows 7 SP1 (Supported with compatible Node.js and PostgreSQL versions — see Section 17).
- **Runtimes:**
  - Node.js `v18.x` LTS or `v20.x` LTS (Node `v18.19+` recommended).
  - PostgreSQL `v14.x`, `v15.x`, or `v16.x` (PostgreSQL `v10.x` to `v13.x` for Windows 7).
- **Web Browsers:** Google Chrome, Microsoft Edge, Brave, or Mozilla Firefox (latest versions supporting PWA / IndexedDB).

---

## 4. Install PostgreSQL

1. Download the official PostgreSQL installer for Windows from [EnterpriseDB](https://www.enterprisedb.com/downloads/postgres-postgresql-downloads).
2. Run the installer `.exe` as Administrator.
3. Choose the default installation path (e.g., `C:\Program Files\PostgreSQL\16`).
4. Select all default components:
   - PostgreSQL Server
   - pgAdmin 4
   - Command Line Tools (`psql`, `pg_dump`, `pg_restore`)
5. **Set Password:** Enter a secure password for the `postgres` superuser (e.g. `YourStrongPassword2026!`). Note this password down securely.
6. **Port:** Leave the default port set to `5432`.
7. **Locale:** Select `[Default locale]` or `English, United States`.
8. Complete the installation. PostgreSQL will automatically register and start as a background Windows Service (`postgresql-x64-16`).

---

## 5. Create Database

Open **pgAdmin 4** or launch **SQL Shell (psql)** from your Start Menu:

```sql
-- Connect as postgres superuser, then execute:
CREATE DATABASE giga_chemist;

-- Optional: Verify database creation
\l
```

Alternatively, run from Windows Command Prompt (`cmd.exe`):
```cmd
psql -U postgres -c "CREATE DATABASE giga_chemist;"
```

---

## 6. Environment Variables Configuration

In the root of the project directory (`GIGA-CHEMIST-POS`), copy the canonical configuration template:

```cmd
copy .env.example .env
```

Open `.env` in a text editor (e.g. Notepad, VS Code) and configure:

```ini
# =============================================================================
# GIGA CHEMIST — LOCAL CONFIGURATION (.env)
# =============================================================================

# Set Application Mode to 'local'
APP_MODE=local

# Network Binding: 0.0.0.0 allows other PCs on the same LAN to connect
API_HOST=0.0.0.0
API_PORT=3000
PORT=3000
NODE_ENV=production

# Frontend API URL (leave blank to automatically use current browser origin)
VITE_API_URL=

# Backend Secret for HMAC-SHA256 JWT Token Signatures (Keep secure)
JWT_SECRET=giga_chemist_local_secure_jwt_secret_key_2026_kitale

# Local PostgreSQL Database Connection String
# Format: postgresql://[USER]:[PASSWORD]@[HOST]:[PORT]/[DATABASE_NAME]
DATABASE_URL=postgresql://postgres:YourStrongPassword2026!@localhost:5432/giga_chemist
```

---

## 7. Install Project Dependencies

Open Command Prompt or PowerShell in `GIGA-CHEMIST-POS`:

```cmd
npm install
```

---

## 8. Run Database Migrations

Apply the complete relational database schema (including UUID extensions, foreign keys, tables, and performance indexes):

```cmd
npm run db:migrate
```

**Expected Output:**
```text
=============================================================
  GIGA CHEMIST — PostgreSQL Database Migrations
=============================================================

[Migrator] Applying migration: 001_initial_schema.sql...
[Migrator] Successfully applied 001_initial_schema.sql
[Migrator] Applying migration: 002_auth_rbac.sql...
[Migrator] Successfully applied 002_auth_rbac.sql
[Migrator] Applying migration: 003_indexes_constraints.sql...
[Migrator] Successfully applied 003_indexes_constraints.sql

Successfully applied 3 migrations:
- 001_initial_schema.sql
- 002_auth_rbac.sql
- 003_indexes_constraints.sql
```

---

## 9. Create Administrator Account

Register your primary pharmacy Administrator user:

```cmd
npm run create-admin
```

Follow the prompts or pass arguments directly:
```cmd
npm run create-admin -- "Dr. Austin (Admin)" admin@gigachemist.co.ke AdminPassword2026! 1234
```

This generates a cryptographically salted **PBKDF2 SHA-512** hash and stores the admin in the PostgreSQL `users` table with the `ADMIN` security role.

---

## 10. Start Local Server

### Step A: Build Frontend Production Bundle
```cmd
npm run build
```

### Step B: Start Server
```cmd
npm run start:local
```

### Step C: Open in Browser
Open your browser and navigate to:
```text
http://localhost:3000
```

> **Tip for Windows Users:** You can double-click **`start-giga-chemist.bat`** to start the entire POS system with a single click.

---

## 11. Access POS from Other PCs on the Local Network (LAN)

You can run additional cashier registers or manager tablets connected to the main server PC over your pharmacy Wi-Fi or LAN.

1. **Find Server IP Address:**
   On the server PC, open Command Prompt and type:
   ```cmd
   ipconfig
   ```
   Look for the `IPv4 Address` under your active adapter (e.g. `192.168.1.50`).

2. **Access from Other Counter PCs:**
   On any other PC, tablet, or smartphone connected to the same Wi-Fi/router, open Chrome or Edge and navigate to:
   ```text
   http://192.168.1.50:3000
   ```

3. **Configure Windows Firewall (If Connection Times Out):**
   Run the following command in Administrator Command Prompt on the server PC:
   ```cmd
   netsh advfirewall firewall add rule name="GIGA CHEMIST POS" dir=in action=allow protocol=TCP localport=3000
   ```

> **Important Security Rule:** Client PCs only connect to port `3000` (Node.js API). Port `5432` (PostgreSQL) is strictly bound locally and should NEVER be directly exposed to external networks.

---

## 12. Test Database Connection

Verify that PostgreSQL is healthy and all tables are present:

```cmd
npm run db:check
```

**Expected Output:**
```text
=============================================================
  GIGA CHEMIST — Database Connectivity & Health Check
=============================================================

Configured Application Mode: [LOCAL]
Target Database Host:     localhost:5432
Target Database Name:     giga_chemist
Target Database User:     postgres

Testing connection to PostgreSQL server...
✓ Connected successfully to PostgreSQL!
Server Version: PostgreSQL 16.2

Found 14 tables in public schema:
  - audit_logs
  - branches
  - categories
  - customers
  - devices
  - expenses
  - inventory_movements
  - medicine_batches
  - medicines
  - payments
  - permissions
  - roles
  - sales
  - settings
  - users

✓ All core schema tables are verified and present.
Total Registered Staff Users: 3
Total Formulary Medicines:    8

=============================================================
  DATABASE CHECK PASSED: Ready for local / production use
=============================================================
```

---

## 13. Switching to Cloud (Supabase) Mode

To switch the deployment to Cloud Mode:

1. Edit `.env` (or copy `.env.example` to `.env`).
2. Set:
   ```ini
   APP_MODE=cloud
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-key
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   ```
3. Restart the server with `npm run start`.

---

## 14. Hybrid Mode Operation

In Hybrid Mode (`APP_MODE=hybrid`), both `DATABASE_URL` (Local PostgreSQL) and `SUPABASE_URL` are configured.

1. **Offline Sales:** Transactions and inventory movements are committed to the local PostgreSQL database immediately.
2. **Pending Queue:** Offline transactions are tracked in `sync_events` and Dexie `pending_sync`.
3. **Resumed Connectivity:** The canonical sync engine synchronizes transactions upstream to Supabase with unique idempotency keys, preventing duplicates and protecting current local inventory counts.

---

## 15. Local Database Backups & Disaster Recovery

### Automated Dump Backup
```cmd
REM Create timestamped backup directory
mkdir C:\GIGA-CHEMIST-BACKUPS 2>nul

REM Run custom compressed backup
pg_dump -U postgres -d giga_chemist -F c -b -v -f "C:\GIGA-CHEMIST-BACKUPS\giga_chemist_%date:~10,4%%date:~4,2%%date:~7,2%.dump"
```

### Disaster Recovery / Database Restore
```cmd
REM Restore from custom format dump
pg_restore -U postgres -d giga_chemist --clean --if-exists -v "C:\GIGA-CHEMIST-BACKUPS\giga_chemist_20261001.dump"
```

---

## 16. Troubleshooting

| Issue / Symptom | Probable Cause | Resolution |
| :--- | :--- | :--- |
| **`ECONNREFUSED 127.0.0.1:5432`** | PostgreSQL Windows service is stopped. | Open Windows Services (`services.msc`), find `postgresql-x64-xx`, and click **Start**. |
| **`password authentication failed`** | Wrong password in `DATABASE_URL`. | Check `DATABASE_URL` in `.env` and verify postgres password. |
| **`database "giga_chemist" does not exist`** | Database has not been created. | Run `psql -U postgres -c "CREATE DATABASE giga_chemist;"` |
| **LAN PCs cannot connect** | Windows Firewall is blocking Port 3000. | Allow inbound TCP port 3000 in Windows Defender Firewall. |
| **`Port 3000 already in use`** | Another application or previous instance is running. | Close existing terminal or change `API_PORT=3001` in `.env`. |
| **`Schema cache error`** | Migrations have not been applied. | Run `npm run db:migrate`. |
| **`Cannot find module tsx`** | Dependencies not installed. | Run `npm install`. |

---

## 17. Windows 7 Compatibility Notes

Windows 7 reached End-of-Life (EOL) by Microsoft. If operating on a legacy Windows 7 PC:

1. **Node.js Compatibility:**
   - Standard Node.js versions above v13 require Windows 8.1+.
   - For Windows 7 SP1, install **Node.js v13.14.0** or use the unofficial Windows 7 Node.js patches (e.g. `NODE_SKIP_PLATFORM_CHECK=1`).
2. **PostgreSQL Compatibility:**
   - PostgreSQL 10.x, 11.x, and 12.x natively support Windows 7 64-bit.
3. **Security Best Practice:**
   - Windows 7 POS machines must be isolated on an internal pharmacy local network behind a firewall/router.
   - Do NOT use legacy POS workstations for general web browsing.
   - Keep daily automated backups on an external USB flash drive or NAS.
