# GIGA CHEMIST SHOP 2 — DEPLOYMENT CHECKLIST

- [x] Real legacy OSPOS SQL data migrated and validated (102,131 sales, 2,326 medicines).
- [x] Database cutover completed to `giga_chemist_shop2`.
- [x] Authoritative cloud mirror initialized with seq 48 snapshot.
- [x] Local and cloud inventory parity confirmed: MATCH (`a63d73de1d2cf2a5572fc6f58612e368a57192cfd9d223b81386a266440cbe05`).
- [x] Remote command regression suite executed and 100% PASS (10/10).
- [x] Remote medicine archive propagation verified (outbox pump, cloud status `archived`, catalogue exclusion, duplicate idempotency).
- [x] Shop 1 isolation verified: 100% untouched.
- [x] DEVTEST shop deactivated in cloud mirror.
- [x] Final PostgreSQL 18 custom backup created: `giga_chemist_shop2_final.backup` (38.89 MB, 327 TOC entries).
- [x] Copy-ready package assembled in `deployment/shop2-ready/GIGA-CHEMIST-POS`.
- [x] Installer scripts created in `deployment/shop2/installer/`.
- [x] Verification scripts created in `deployment/shop2/verification/`.
- [x] Copy-ready package verified with `verify-copy-ready.ps1`.
