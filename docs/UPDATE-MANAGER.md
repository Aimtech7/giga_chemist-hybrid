# Update manager (Shop 1)

`scripts/updater/updater.mjs` (unchanged design): checks the `production` branch, reports
UPDATE_AVAILABLE with the heartbeat; installs only after an Administrator approves the EXACT commit
(online: Remote Operations -> Health -> Software updates -> Install = `APP_UPDATE_APPROVE`).

Install: verified backup -> maintenance lock -> checkout exact commit -> `npm ci` -> `npm run lint` ->
`npm run build` -> `npm run db:migrate` (additive) -> `npm run db:check` -> restart -> health gate (API up,
PostgreSQL connected, running the new commit). Failure: the CODE is rolled back to the previous commit and
rebuilt; the database is **never** restored automatically (migrations are additive), real sales stay.

## Hardening in this phase

- **2026-10-12 rollback cause**: an old untracked file on Shop 1 (`scripts/test-pos-verification.ts`,
  removed from git on 2026-10-04) failed `tsc --noEmit` (tsconfig has no `include`). Hotfix `3c7fc9e`:
  `npm run lint` = `scripts/lint-tracked.mjs` type-checks the files TRACKED by git only (git located like the
  updater; falls back to the whole folder). Shop 1 then installed `3c7fc9e` successfully (19:21 UTC).
- **Update audit**: the next server start records APP_UPDATE_INSTALLED / ROLLED_BACK / FAILED / REFUSED
  once per attempt.
- **Version visibility**: installed and available commit, version, update status, last install result in
  the online Health screen and the Sync Center.

Tests: `npm run test:updater` (58 checks: success, build failure, health failure, rollback, no DB restore).
