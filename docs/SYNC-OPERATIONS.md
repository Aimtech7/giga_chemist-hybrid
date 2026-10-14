# Sync & conflict control center

System -> **Sync Center** (Administrator).

## Shop computer (`GET /api/sync/center`)

Mode, cloud reachability, outbox last sequence / last synced sequence, pending / retrying / failed events
with the cloud's reason, recent remote commands with a plain conflict reason. Actions: Sync now, retry all
failed events, retry one event (`POST /api/sync/events/:id/retry`).

## Online (`GET /admin/sync-center`, `/admin/sync-center/issues`)

Every authorized shop (Global Administrator: all; shop Administrator: own): online / offline, last
heartbeat, last successful sync, shop outbox sequence vs the cloud's highest processed sequence (gap),
outbox pending / failed, commands pending / delivered / rejected (7 days), installed and available commit,
device id, last backup (age, verified). Issues of the selected shop: rejected / expired commands and
cloud-rejected events with the conflict reason.

Actions: **Retry** a rejected command (`POST /admin/commands/:id/retry`), **Re-send failed events**
(`SYNC_RETRY_FAILED` command, cloud migration 010).

## Never duplicate

- An event retry re-sends the same row with its ORIGINAL idempotency key: the cloud answers DUPLICATE for
  anything it already has (tests SC4, SC12: still one cloud copy).
- A rejected command changed nothing; a retry is ONE new command linked by `display.retry_of`, re-checked
  by the shop against its current data; a second retry of the same command, a retry of an APPLIED command,
  of staff account commands or of update approvals is refused (SC8-SC11).

## Conflict reasons

STALE_VERSION, USER_CHANGED_LOCALLY, STOCK_CHANGED, RECORD_NOT_FOUND, DUPLICATE_USERNAME, DUPLICATE_EMAIL,
INVALID_STATE, else OTHER (the original message is always shown).

## Known operational risk

The online API uses the Supabase **session** pooler (port 5432, pool size 15). On 2026-10-12 it was full
(15 idle Supavisor sessions) and some connections were refused ("max clients reached"). Shop sync uses the
REST API and is not affected; online screens can fail briefly. Recommended (separate approved change):
point Vercel `DATABASE_URL` at the **transaction** pooler (port 6543) with a small pool per function.
