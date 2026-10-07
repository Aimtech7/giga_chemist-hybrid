# GIGA CHEMIST — Production Checklist

> **TARGET DATABASE DATA MUST NEVER BE REPLACED BY DEVELOPMENT DATA.**

## A. Before the upgrade (pharmacy PC)

- [ ] Read `GIGA_CHEMIST_TARGET_UPGRADE.md`
- [ ] Manual off-PC copy of a recent backup exists (USB / cloud drive)
- [ ] Target `.env` kept (`DB_NAME=giga_chemist`, own `JWT_SECRET` ≥ 32 chars, own DB password)
- [ ] `upgrade-target.ps1 -ValidateOnly` → PASS
- [ ] `upgrade-target.ps1` → PASS (rehearsal PASS, invariants PASS, health online)

## B. Network / security

- [ ] `API_HOST=0.0.0.0` only if other LAN terminals use the POS; otherwise `127.0.0.1`
- [ ] Windows Firewall: inbound TCP 3000 allowed for the **Private** profile and the shop LAN subnet only:
      `New-NetFirewallRule -DisplayName "GIGA CHEMIST POS (LAN)" -Direction Inbound -Protocol TCP -LocalPort 3000 -Profile Private -RemoteAddress LocalSubnet -Action Allow`
- [ ] Network profile of the shop LAN is **Private**; no Public-profile rule for 3000
- [ ] Router: **no** port forwarding for 3000 or 5432; UPnP off
- [ ] PostgreSQL: `listen_addresses = 'localhost'` in `postgresql.conf`; `pg_hba.conf` only `127.0.0.1/32` and `::1/128`; port 5432 not open in the firewall
- [ ] `ALLOWED_ORIGINS` set only if an online frontend must call this API (comma-separated https origins)
- [ ] Strong, unique Admin passwords; Cashiers use their own accounts/PINs
- [ ] Role checks (all backend-enforced, covered by tests): Admin only for stock changes, pricing, users,
      settings, return approval, voids, purchases, expenses, email settings, backups, sync administration,
      system health. Cashier: sell, receipts, own sales, return **requests** only.

## C. Backups

- [ ] `BACKUP_ENABLED=true`, `BACKUP_TIME`, `BACKUP_DIR` (second disk preferred), `BACKUP_KEEP`
- [ ] Settings → System Health → **Back up now** succeeds; file appears in `BACKUP_DIR`
- [ ] Optional: Task Scheduler runs `scripts\backup\run-backup.bat` daily
- [ ] Weekly copy of the newest backup off the PC

## D. Email reports (when SMTP credentials are available)

- [ ] SMTP_* / EMAIL_FROM / STOCK_REPORT_RECIPIENTS in `.env`, `EMAIL_ENABLED=true`, POS restarted
- [ ] Settings → Email Reports → **Send Test Email** received (external delivery verified only now)
- [ ] Report times and toggles set; next day: Daily Stock and Business Summary received

## E. Hybrid / cloud (when a Supabase project exists)

- [ ] `cloud/supabase/migrations/001_giga_cloud_hybrid.sql` applied in Supabase
- [ ] Shop registered with the **target's** shop id: `SELECT giga_cloud.register_shop('<id>', 'SHOP1', 'GIGA CHEMIST - MAIN', '<token>');`
- [ ] `.env`: `APP_MODE=hybrid`, `SYNC_ENABLED=true`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SYNC_SHOP_TOKEN`
- [ ] Header indicator shows ONLINE — SYNCED; System Health shows Cloud CONNECTED
- [ ] Optional once: `npm run sync:bootstrap -- --confirm` (cloud stock baseline)

## F. Physical tests (owner)

- [ ] Login (Admin, Cashier; username and email; password and PIN)
- [ ] Search medicine, sell Cash, sell M-Pesa (with code), Mixed, Wholesale, discount; receipt prints
- [ ] Physical Stock Count; add/remove stock; expiry edit
- [ ] Cashier return request → Admin approval; void (Admin)
- [ ] Purchase receipt; expense; supplier; customer
- [ ] Reports: Today / This Week / This Month / Custom match expectations
- [ ] Sales History: paging, date range, receipt search, payment, Retail/Wholesale, status, cashier filters
- [ ] Internet unplugged: everything above still works; indicator OFFLINE — n PENDING (hybrid);
      emails stay queued; reconnect → events SYNCED, emails SENT, no duplicates
- [ ] Restart the PC: POS comes back; pending events/e-mails continue

## G. Never commit

`.env`, `.env.online`, SMTP passwords, Supabase keys, JWT secrets, database passwords, backups/dumps,
`logs/`, `node_modules/`, `dist/`.
