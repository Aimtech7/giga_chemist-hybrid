# Unified local + online accounts

Builds on cloud migration 005 / local 016 (see `MULTI-SHOP-UNIFIED-AUTH-PHASE1.md`).

## Identity

- `giga_cloud.online_users`: `GLOBAL_ADMIN` (no shop, every shop) or `SHOP_USER` (one shop,
  `local_user_id`). The durable link is **shop_id + local_user_id**; ids never change on edits.
- Same email / username and **same password** at the shop and online. The PIN stays at the shop only
  (never uploaded; a PIN typed online fails).
- Login identifier: **email** is globally unique online. A **username** logs in online only when exactly
  one active account in all shops has it; an ambiguous username never authenticates anyone.

## Editing (Global Administrator, User management)

| Field | How it travels | Online effect | Shop effect |
|---|---|---|---|
| Name, username, email | `USER_PROFILE_UPDATE` with `expected` (what the admin saw) | identity updated at once; a new email / username ends online sessions | applied after a stale check; refused if the shop changed it meanwhile (the cloud then converges back) |
| Role (ADMIN / MANAGER / CASHIER) | `USER_ROLE_UPDATE` | at once (demotion ends sessions) | applied |
| Active | `USER_SET_ACTIVE` | login blocked at once | applied |
| Password | hash in the cloud identity; `USER_CREDENTIAL_REFRESH` (version only) | new works, old fails, sessions end | the shop fetches the hash for that one command |
| Sessions | token_version + `USER_SESSION_REVOKE` | ended | terminals signed out |

Global Administrators: name / email / active / password / sessions; never converted to shop staff; the
last active Global Administrator cannot be removed (database trigger).

Receipts keep the cashier name recorded with the sale: local `user_name_history` + `sale_cashier_name`
(no sale row is rewritten), online the per-sale `cashier_name` snapshot.

## Publishing existing Shop 1 users

User management -> **Publish existing shop users**: a DRY RUN from the shop's heartbeat (local users,
cloud matches, identities to create, username / email conflicts, inactive users, accounts without a usable
password; no hash ever leaves the shop for this), then typing the shop code enables credential publishing
for that shop. The shop worker publishes within ~10 minutes.

Expected for Shop 1 (PC2 copy): 7 local users, 3 active; publishable: Administrator, Cashier; the
"Administrator" email equals the production online Admin email -> **EMAIL_CONFLICT** (no second identity
is created; decide whether that local admin gets a different email). "system admin" is active without a
usable password (cannot log in anywhere until a password is set at the shop).

## Offline

A local Administrator can create / edit / deactivate users and change passwords with the internet down;
the change is published (credential sync) when the shop reconnects (test P10).

## Tests

`npm run test:unified-auth`: 126 checks (profile round trip, stale reject + convergence, offline edit,
username / email login, MANAGER, RBAC, cross-shop, publish dry run, Global Admin edit, no secret anywhere).
