# GIGA CHEMIST — Phase 1: Multi-shop Online Admin + Unified Authentication

Status: **feature branch, tested, NOT deployed.** No credential hash, password, PIN, token or secret appears in this document.

| | |
|---|---|
| Production (`origin/production`) at start | `f93c8c42e8a7100734fbae6e9d1f88246a06cf74` (unchanged; `main` identical) |
| Feature branch | `feature/multi-shop-unified-auth` (from `origin/production`) |
| Feature branch SHA | see the commit on the branch (`git rev-parse feature/multi-shop-unified-auth`) |
| Production branch modified / deployed | NO / NO |
| Supabase production migrations applied | NO (cloud 005 prepared only) |
| Shop 1 (live) touched | NO: no restart, no `.env`, no data, no credential, no command |

---

## 1. What changed (files)

**Cloud (Supabase), new, additive:** `cloud/supabase/migrations/005_unified_auth_multishop.sql`
**Local (shop PostgreSQL), new, additive:** `migrations/016_unified_auth_credentials.sql`

**Online API (Vercel):**
- `server/online/app.ts`: request-scoped shop resolver (`X-GIGA-SHOP-ID`), account types, unified login, per-account brute-force brake, per-shop maintenance gate.
- `server/online/remoteAdmin.ts`: every route uses the request's authorized shop; new `GET /api/admin/shops`; the target shop is recorded on commands; online-account management scoped.
- `server/online/userAdmin.ts` (new): Global-Admin User Management API.
- `server/http/common.ts`: CORS allows the `X-GIGA-SHOP-ID` header.

**Shop server / sync:**
- `server/sync/credentials.ts` (new): credential publish + per-command credential fetch.
- `server/sync/worker.ts`: credential fetch before `USER_CREATE` / `USER_CREDENTIAL_REFRESH`; credential publish step each cycle.
- `server/sync/commands.ts`: `USER_CREATE` and `USER_CREDENTIAL_REFRESH` handlers; a rejected staff command re-publishes the account (convergence).
- `server/sync/commandSchema.ts`: validation for the two new command types (no credential field accepted).
- `server/sync/cloudClient.ts`: new RPC names.
- `server/sync/outbox.ts`: business events also strip the credential bookkeeping columns.
- `server/db/users.ts`: exports `unusablePinHash`.

**Frontend:**
- `src/services/shopContext.ts` (new): selected shop + account type.
- `src/services/http.ts`: header on authenticated requests, safe fallback.
- `src/services/syncEngine.ts`: per-shop cache purge.
- `src/services/auth.ts`, `src/services/remoteAdmin.ts`.
- `src/components/layout/ShopSelector.tsx` (new), `src/components/layout/AppShell.tsx`.
- `src/components/remote/UserManagement.tsx` (new), `RemoteAdminPanel.tsx`, `RemoteOps.tsx`.
- `src/components/auth/LoginPage.tsx`.

**Tools/tests:**
- `scripts/auth/credential-sync-dryrun.ts` (new), `scripts/online/create-online-user.ts` (`--global`).
- `scripts/cloud-emulator.ts` (new RPCs).
- `scripts/integration/unified-auth.test.ts` + `run-unified-auth.ts` (new).
- `package.json` (`test:unified-auth`, `auth:credential-dryrun`).
- `api/index.js` (rebuilt Vercel bundle).

The existing sync RPCs `gc_ingest_events`, `gc_ping`, `gc_pull_commands`, `gc_ack_command` and `gc_heartbeat` are **unchanged**. `SHOP_ID`, `SYNC_SHOP_TOKEN` and `DEVICE_ID` keep their meaning.

## 2. Schema changes (all additive, re-runnable)

### Cloud 005
- `giga_cloud.online_users` gets new columns:
  - `account_type` (`GLOBAL_ADMIN` | `SHOP_USER`)
  - `username`
  - `credential_version`, `credential_updated_at`, `credential_source`
  - `deactivated_at`
- Role constraint widened to `ADMIN, MANAGER, CASHIER`.
- Shape constraints:
  - A GLOBAL_ADMIN has no shop, no staff link and role ADMIN.
  - A SHOP_USER has a shop (`NOT VALID`: grandfathers old rows).
- Unique indexes: one identity per `(shop_id, local_user_id)`; usernames unique per shop.
- **Backfill:** a pre-005 `ADMIN` with no staff link becomes `GLOBAL_ADMIN` (shop cleared). Its password, id, sessions (`token_version`) are kept. Every other row becomes `SHOP_USER`.
- `giga_cloud.shops.credential_sync_enabled` (default **FALSE**: nothing is published until the operator enables it per shop).
- The trigger `protect_last_global_admin` (serialized by an advisory lock) refuses to deactivate, demote or delete the last active GLOBAL_ADMIN on **every** write path.
- `commands.command_type` gains `USER_CREATE` and `USER_CREDENTIAL_REFRESH`.
- RPCs (shop-token authenticated, same pattern as `gc_ingest_events`):
  - `gc_sync_user_credentials`
  - `gc_fetch_user_credential`
  - `gc_credential_sync_preview`
- `upsert_online_user` (owner helper): same signature; it now sets `account_type`.

### Local 016
- `users` gets `credential_version`, `credential_updated_at`, `auth_sync_seq` and `auth_synced_seq`.
- A trigger bumps the credential version when `password_hash` changes. It marks the account "to publish" when the password, active flag, role, email, username or name changes, **never for a PIN change**.
- No existing hash, PIN, role or active flag is modified.

## 3. Authentication architecture

| | Shop (local) | Online (Vercel) |
|---|---|---|
| Endpoint | `/api/auth/login` | `/api/auth/login` (same login screen) |
| Store | shop PostgreSQL `users` | `giga_cloud.online_users` (cloud login mirror) |
| Password | yes | **yes, same password** (same PBKDF2 hash) |
| PIN | yes (station quick login) | **no** (a `pin` field is ignored; a PIN typed as password fails) |
| JWT secret | shop `JWT_SECRET` | online `JWT_SECRET` (independent; sessions are environment-specific) |

Online login rules:
- Accepts email, or username only when **exactly one** active account in all shops has it.
- Same generic 401 for unknown user, wrong password, inactive account or inactive shop. The timing is equalised with a dummy hash.
- Per-IP limit (existing), plus a per-account lock: 10 failures lock that identifier for 15 minutes.
- Active status, `token_version` and shop activity are re-checked on **every** request.

**Identity rule:**
- **email = globally unique online identifier.**
- Usernames are a local convenience, unique per shop. An ambiguous username never authenticates anyone online.
- A shop staff account whose email is already used by another online account is reported as `EMAIL_CONFLICT` and gets no online login until resolved.

## 4. Account model

- **GLOBAL_ADMIN** is cloud-managed with `shop_id NULL`. It may:
  - select any **active** shop;
  - manage every shop's staff;
  - manage Global Admins.
  
  It is never converted into a shop staff account.
- **SHOP USER** (`SHOP_USER`) belongs to exactly one shop and normally has `local_user_id`. Roles are ADMIN, MANAGER and CASHIER, as in the shop RBAC. It is locked to its shop: any other `X-GIGA-SHOP-ID` returns **403**.
- **Local ADMIN ≠ GLOBAL_ADMIN.** A shop ADMIN online:
  - keeps own-shop remote administration (unchanged behaviour);
  - gets **no** User Management, no Global Admin management and no other shop.
  
  Global authority is decided by `account_type`, never by role alone.
- **Online CASHIER:** own-shop cashier permissions only. No remote-admin powers, no shop selection.

## 5. Credential sync design

**Shop → cloud: `gc_sync_user_credentials`.**
- The shop worker publishes accounts marked by the 016 trigger: hash, version, timestamp, email, username, name, role, active.
- **Password hash only.** Never the PIN or `pin_hash`, and never plaintext.
- It is **never** sent in business events, commands, audit rows or logs.
- Accounts without a usable password (legacy `LOCKED_MIGRATED_…` markers) are not published.

**Version rule (identical on both sides):** `(credential_version, credential_updated_at)` ordering. An older credential never replaces a newer one. Timestamps travel as PostgreSQL text, so no precision is lost.

**Shop authority with one exception.** The shop is authoritative for active, role and profile. The exception: while an online Administrator's `USER_SET_ACTIVE` / `USER_ROLE_UPDATE` for that account is still **open**, the cloud keeps the Administrator's value.

**Convergence after a refused command.** A staff command the shop REJECTS (for example, the last local admin) re-publishes the account, so the cloud converges back to the shop's state.

**Sessions:** a new password, a deactivation or a demotion bumps `token_version`, which revokes online sessions.

**Cloud → shop:**
- Commands carry the account id and a credential **version** only.
- The shop fetches that one hash with `gc_fetch_user_credential` just before applying.
- That RPC answers only for the authenticated shop's own account, and only while a `USER_CREATE` / `USER_CREDENTIAL_REFRESH` for it is open. A shop token cannot bulk-read hashes.
- The hash is kept in memory only. The command row, its result and the audit rows never contain it. TLS is mandatory (Supabase HTTPS).

## 6. Password reset design

**Global Admin reset of a shop user:**
1. The backend hashes the new password.
2. The cloud identity is updated: version+1, `token_version`+1, so sessions are revoked.
3. `USER_CREDENTIAL_REFRESH(user_id, version)` is queued for **the selected shop only**.
4. The shop fetches the hash and applies it if it is newer.

The new password works online immediately and at the shop once applied. The old password fails on both.

**Local password change (or local admin reset):**
1. The trigger bumps the version.
2. The worker publishes it.
3. The cloud accepts it if newer and revokes online sessions.

**Offline conflict.** Example: a cloud reset while the shop is offline, then a later local change. The newer one wins on both sides. The cloud reset arrives as `applied:false` ("superseded"), and the local hash is then published.

## 7. Shop isolation (multi-shop)

**Request-scoped resolver.** Every request runs: authenticate → resolve the authorized shop → store it **on the request object** (never module state). Every cloud read runs `BEGIN READ ONLY` + transaction-local `set_config('giga.shop_id', …)`.

| Request | Result |
|---|---|
| No header | the account's own shop; for a Global Admin, `SHOP_ID` (Shop 1). **Existing Shop 1 behaviour unchanged.** |
| Global Admin + header | any active registered shop. Unknown or inactive → 404; malformed → 400. |
| Shop account + another shop | 403 (`SHOP_ACCESS_DENIED`, audited) |
| Anonymous | header ignored; default shop only; cannot list shops |

Where the selected shop applies:
- **Per shop:** remote commands, command history, alerts, health, insights, emergency controls, reports, staff, medicines, sales, etc.
- **Database check:** `queue_online_command` re-checks shop authorization inside the database.
- **Recorded on the command:** the target shop (`display.target_shop`).

**Frontend:**
- A shop selector appears in the top bar, **online Administrators only**, never on the shop POS. A Global Admin can switch; a shop admin sees a locked label.
- It shows name, code and online/offline status.
- Switching asks for confirmation, **empties the shop-specific browser cache** and reloads. Other tabs reload too.
- The header is added centrally in `apiFetch`.
- Every remote-change confirmation shows a **Target shop** box. User Management confirmations name the target shop and staff member.

## 8. Shop 1 compatibility strategy

- The existing online Admin is shop-scoped to Shop 1 today. Cloud 005 turns it into GLOBAL_ADMIN **without changing its password or session**; this was tested by re-running 005 over live data. With no header it still sees Shop 1.
- Shop 1 local logins, password hashes, PINs, roles and active flags are not modified by 016.
- Credential sync is **off** for Shop 1 until the operator enables it, so upgrading code or migrations publishes nothing.
- Old code still works with cloud 005 applied:
  - the old online API accepts a GLOBAL admin (`shop_id NULL`);
  - the old shop worker never calls the new RPCs.
- New code still works before cloud 005 (column fallbacks), and before local 016 (credential step waits quietly).

### Shop 1 credential-migration DRY RUN (read-only; PC2's restored copy of the target dump, local analysis)

| | |
|---|---|
| Local staff accounts found | 7: active 3, inactive 4. Roles: ADMIN 2, CASHIER 5 |
| Publishable (PBKDF2 password) | 2: **Administrator** (ADMIN, active), **Cashier** (CASHIER, active) |
| LOCKED (legacy, no usable password; not published) | 5: **system admin** (ADMIN, *active*), janet okumu, johny githaiga, rogers kwalera, vincent che (all CASHIER, inactive) |
| Local email / username duplicates | 0 / 0 (no usernames set) |
| Email collision with production cloud (read-only check) | **1: the local "Administrator" uses the same email as the existing online Admin** (which becomes GLOBAL_ADMIN) |
| Cloud identities matched / to create | production cloud has no 005 yet. Expected after 005: 0 matched, 1 to create (Cashier), 1 EMAIL_CONFLICT (Administrator) |
| Secret values read/printed/sent | none |

**Decision needed before enabling Shop 1 credential sync:**
- Either keep the shared email (the owner signs in online as Global Admin; the local Administrator gets no separate shop login),
- or change the local Administrator's email at the shop first.

Separately, "system admin" is an *active* ADMIN with no usable password. Set a password at the shop or deactivate it.

Run it on the live target later with `npm run auth:credential-dryrun` (adds the cloud preview once cloud 005 is applied).

## 9. Production deployment plan (each step needs explicit approval)

1. Review the branch. Merge to `main`. Re-run the suites.
2. **Supabase:** apply `005_unified_auth_multishop.sql` (SQL editor; additive; re-runnable). Verify:
   - the online Admin is `GLOBAL_ADMIN` and still logs in;
   - `credential_sync_enabled = false` for SHOP1.
3. **Vercel:** deploy the new bundle. No new environment variable; `SHOP_ID` stays the default shop. Verify `/api/health`, Admin login, the shop selector shows SHOP1, and Shop 1 screens are unchanged.
4. **Shop 1:**
   - push the commit to `production`, approve from the phone;
   - the updater installs it and runs local migrations (016);
   - verify local logins (password + PIN) are unchanged.
5. On Shop 1, run `npm run auth:credential-dryrun`. Resolve the email collision decision and the "system admin" account.
6. Enable unified login for Shop 1 in the SQL editor: `UPDATE giga_cloud.shops SET credential_sync_enabled = TRUE WHERE shop_code = 'SHOP1';`. Verify the Cashier can sign in online with the shop password and cannot reach another shop.
7. Later, a separate operation: register Shop 2 and enable its credential sync.

## 10. Rollback plan

- **Code:** the updater rolls back to the previous production commit. Vercel can promote the previous deployment. Both old versions run against cloud 005 and local 016 (additive).
- **Stop publishing:** `UPDATE giga_cloud.shops SET credential_sync_enabled = FALSE WHERE shop_code = 'SHOP1';`
- **Remove published shop identities** (cloud only; shop accounts untouched): `DELETE FROM giga_cloud.online_users WHERE account_type = 'SHOP_USER' AND local_user_id IS NOT NULL AND shop_id = '<shop>';`
- **Return the Admin to shop-scoped** if required: this is a demotion of the last GLOBAL_ADMIN, which the trigger refuses by design. Create a second Global Admin first, or temporarily disable `trg_protect_last_global_admin` in the SQL editor.
- Migrations 005 / 016 are additive. They can stay in place, and no data needs restoring.

## 11. Known limitations

- Rate limits and the per-account lock are per serverless instance (the database checks are the hard guarantees).
- Online username login works only for usernames unique across all shops; otherwise use the email.
- Users created remotely get an unusable PIN until one is set at the shop.
- Shop staff are never deleted (deactivate); permanent deletion exists only for never-used Global Admins.
- Password reset online needs the staff member's published identity (credential sync enabled).
- Security tab "online account" activate/deactivate keeps its previous behaviour (online login only). For a shop staff login with credential sync enabled, the shop's next publish of that account restores the shop's status. Use User Management for a durable deactivation (it also deactivates at the shop and holds the cloud value while the command is open).
- The two browser tabs of one browser always show the same shop (shared cache, by design).
- Timestamps only break ties between equal versions (shop PC clock vs cloud clock).
- `ASSIGNABLE_ROLES` remain ADMIN / CASHIER (as the shop's user screen). MANAGER is accepted in the cloud for existing accounts.
- Shop 2 is not registered: the selector shows only SHOP1 until it is.

## 12. Tests

See the final report in the session (counts per suite). Every suite runs only against `giga_chemist_dev` and the local cloud emulator `giga_chemist_cloud_test`. The wrapper blanks every real cloud credential, so no test reached Supabase, Vercel or Shop 1.
