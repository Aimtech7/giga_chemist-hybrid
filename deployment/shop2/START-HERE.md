# GIGA CHEMIST SHOP 2 — PRODUCTION DEPLOYMENT GUIDE

## Identity
- **Shop Code**: `SHOP2`
- **Shop Name**: GIGA CHEMIST - SHOP 2
- **Shop ID**: `13bdb896-e243-4772-accf-b8609e1d977f`
- **Branch ID**: `00000000-0000-0000-0000-000000000002`
- **Device ID**: `SERVER`
- **Database**: `giga_chemist_shop2`

---

## Fast Automated Installation
On the target Windows server (Shop 2):
1. Copy `deployment/shop2-ready/GIGA-CHEMIST-POS` to `C:\GIGA-CHEMIST-POS`.
2. Copy `deployment/shop2` alongside it.
3. Open PowerShell as Administrator and run:
```powershell
powershell -ExecutionPolicy Bypass -File .\deployment\shop2\installer\install-shop2.ps1 -PostgresPassword "YOUR_PASSWORD"
```

---

## Manual Step-by-Step Installation

### 1. Database Restore
Restore `deployment/shop2/database/giga_chemist_shop2_final.backup` into local PostgreSQL 18:
```powershell
powershell -ExecutionPolicy Bypass -File .\deployment\shop2\installer\restore-shop2-database.ps1 -PostgresPassword "YOUR_PASSWORD"
```

### 2. Configure Environment
Copy `deployment/shop2/config/.env.shop2.example` to `.env` in your application directory and fill in:
- `DB_PASSWORD`
- `DATABASE_URL`

### 3. Verify
Run verification scripts:
```powershell
powershell -ExecutionPolicy Bypass -File .\deployment\shop2\verification\verify-shop2.ps1
powershell -ExecutionPolicy Bypass -File .\deployment\shop2\verification\verify-shop2-cloud.ps1
```

### 4. Start POS
```powershell
npm run start
```
