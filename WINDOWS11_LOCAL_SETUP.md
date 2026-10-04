# GIGA CHEMIST — Windows 11 Production Local PostgreSQL Setup Manual

This document is the installation and operations manual for deploying **GIGA CHEMIST** on a **Windows 11 Target Pharmacy PC** running local **PostgreSQL** for 100% offline-capable, high-speed dispensing and inventory management.

---

## 1. System Architecture Overview

```text
Windows 11 Target Pharmacy PC
│
├── Local PostgreSQL Server (Port 5432)
│   └── Database: `giga_chemist` (Relational schema, UUID keys, ACID transactions)
│
├── GIGA CHEMIST Node Server (Port 3000, Bound to 0.0.0.0)
│   ├── REST API & RBAC Controller
│   └── Static Production PWA Host
│
├── Primary Register Browser (Local Client)
│   ├── PWA Offline Shell
│   └── Dexie / IndexedDB Resilience Layer
│
└── Secondary LAN Terminals / Tablets (Optional)
    └── Accessed via http://<SERVER-IP>:3000/
```

---

## 2. Target PC Prerequisites

- **Operating System:** Windows 11 64-bit (22H2 / 23H2 or newer).
- **Node.js:** Node.js v18.x or v20.x LTS installed from [nodejs.org](https://nodejs.org/).
- **PostgreSQL:** PostgreSQL 14, 15, or 16 installed from [EnterpriseDB](https://www.enterprisedb.com/downloads/postgres-postgresql-downloads).
- **Web Browser:** Google Chrome, Microsoft Edge, or Mozilla Firefox.

---

## 3. Step-by-Step Installation on Target PC

### Step 3.1: Install PostgreSQL
1. Run the PostgreSQL installer for Windows 11.
2. During setup, choose a secure master password (e.g. `postgres` or your preferred password) and note the default port `5432`.
3. Complete the installation (Stack Builder is optional and can be unchecked).

### Step 3.2: Create the `giga_chemist` Database
Open **pgAdmin 4** or **SQL Shell (psql)**:
```sql
CREATE DATABASE giga_chemist;
```

### Step 3.3: Copy GIGA CHEMIST to the Target PC
Copy the `GIGA-CHEMIST-POS` project folder to `C:\GIGA-CHEMIST-POS\`.

### Step 3.4: Configure Environment Variables
1. In `C:\GIGA-CHEMIST-POS\`, copy `.env.example` to `.env`:
   ```cmd
   copy .env.example .env
   ```
2. Open `.env` in Notepad and verify:
   ```ini
   APP_MODE=local
   NODE_ENV=production
   HOST=0.0.0.0
   PORT=3000
   
   # Update with your local PostgreSQL password:
   LOCAL_DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@127.0.0.1:5432/giga_chemist
   DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@127.0.0.1:5432/giga_chemist
   ```

### Step 3.5: Run Migrations and Seed Database
In Command Prompt / PowerShell:
```cmd
cd C:\GIGA-CHEMIST-POS
npm install
npm run db:migrate
npm run create-admin
```
Follow the interactive prompt to set up the administrator account.

### Step 3.6: Launching or Configuring Windows Autostart

#### Option A: Automatic Windows 11 Boot Service (Recommended for Production)
Run the autostart installer once:
```cmd
deployment\windows\install-autostart.bat
```
This registers a background service in Windows Task Scheduler that starts GIGA CHEMIST automatically whenever Windows boots, with automated restart on failure. See [`deployment/windows/WINDOWS11_AUTOSTART_GUIDE.md`](file:///g:/GIGA-CHEMIST-POS/deployment/windows/WINDOWS11_AUTOSTART_GUIDE.md) for full management details.

#### Option B: Manual Console Launcher (Fallback)
Simply double-click:
```cmd
start-giga-chemist.bat
```

3. Open your browser or PWA and navigate to:
   ```text
   http://localhost:3000/
   ```

---

## 4. LAN Multi-Counter Access (Other Pharmacy PCs / Tablets)

To allow secondary dispensing counters or mobile tablets to access GIGA CHEMIST:

1. On the Main Server PC, open Command Prompt and run:
   ```cmd
   ipconfig
   ```
2. Note the **IPv4 Address** (e.g., `192.168.1.100`).
3. Configure Windows 11 Firewall:
   - Open **Windows Defender Firewall with Advanced Security**.
   - Select **Inbound Rules** &rarr; **New Rule**.
   - Rule Type: **Port** &rarr; Protocol: **TCP** &rarr; Specific Port: **3000**.
   - Action: **Allow the connection** &rarr; Profile: **Private** network.
   - Name: `GIGA CHEMIST POS (Port 3000)`.
4. On any other PC or tablet on the same Wi-Fi / LAN, navigate to:
   ```text
   http://192.168.1.100:3000/
   ```

---

## 5. Offline Operation & Verification

- GIGA CHEMIST operates with **zero internet connection**.
- All transactions, stock reductions, and receipt printing are processed through the local PostgreSQL server and synchronized with IndexedDB.
- When internet is later available, Supabase hybrid sync will automatically synchronize new records to the cloud.

---

## 6. Daily Backups

To create a backup of the `giga_chemist` PostgreSQL database:

```cmd
pg_dump -U postgres -h 127.0.0.1 -p 5432 giga_chemist > C:\GIGA-CHEMIST-BACKUPS\giga_chemist_backup_%date:~-4,4%%date:~-7,2%%date:~-10,2%.sql
```

To restore from a backup:
```cmd
psql -U postgres -h 127.0.0.1 -p 5432 giga_chemist < C:\GIGA-CHEMIST-BACKUPS\giga_chemist_backup.sql
```
