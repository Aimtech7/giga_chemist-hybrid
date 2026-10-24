# SHOP 2 CLOUD ACTIVATION SPECIFICATION (ACTIVATE-SHOP2-ONLINE.md)

## IMPORTANT: FUTURE PHASE ONLY
Shop 2 must first be deployed and operated **100% OFFLINE / LOCAL**.
Only after the physical Shop 2 computer is running steadily on local PostgreSQL will cloud synchronization be activated.

---

## The Required 12-Step Cloud Activation Sequence:

1. **Verify Local Database**:
   - Ensure local PostgreSQL `giga_chemist_shop2` is healthy and responsive.
   - Assert database is NOT `giga_chemist` or `giga_chemist_dev`.

2. **Verify Local Backup**:
   - Confirm a verified, encrypted backup of Shop 2 PostgreSQL exists before touching cloud.

3. **Verify Unique Shop 2 Identity**:
   - Confirm `SHOP_ID` is a fresh UUID.
   - Refuse setup if `SHOP_ID` equals Shop 1 (`c2a176c8-a50f-456f-a370-225c11d2e32f`).

4. **Verify Unique Shop 2 Token**:
   - Confirm `SYNC_SHOP_TOKEN` is present and unique to Shop 2.

5. **Verify Supabase Registration**:
   - Confirm `SHOP_ID` exists in Supabase `giga_cloud.shops` with active status.

6. **Verify Internet & Connectivity**:
   - Check DNS resolution and HTTPS ping to Supabase endpoint (`gc_ping`).

7. **Verify Schema & Protocol Compatibility**:
   - Execute `gc_check_compatibility` RPC (Protocol version 2, Cloud schema 16).

8. **Enable Hybrid Mode**:
   - Atomically update `.env` on Shop 2 PC:
     ```env
     APP_MODE=hybrid
     SYNC_ENABLED=true
     ```

9. **Start Sync Worker**:
   - Restart the GIGA CHEMIST Windows service / sync worker.

10. **Publish Authoritative Initial Snapshot**:
    - Publish initial authoritative Shop 2 snapshot (`gc_apply_inventory_snapshot`).
    - Seed Supabase mirror with Shop 2's authoritative baseline.

11. **Verify Fingerprint Parity**:
    - Fetch cloud fingerprint (`gc_get_inventory_fingerprint`).
    - Confirm: `Shop 2 Fingerprint == Cloud Fingerprint`.

12. **Verify Cloud Contact & Drain**:
    - Confirm `last_seen_at` is updated in `giga_cloud.shops`.
    - Confirm `sync_events` pending count drains to 0.
