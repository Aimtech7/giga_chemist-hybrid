# Alerts Center and audit trail

## Alerts Center

System -> **Alerts Center**. Shop computer: local table `alerts` (migration 024), works offline. Online:
the selected shop's cloud alerts (`giga_cloud.alerts`, fed by the heartbeat and the cloud itself).

- One OPEN row per condition (refreshing never duplicates); OPEN -> ACKNOWLEDGED (Administrator,
  audited) -> RESOLVED automatically when the condition is gone; a condition that returns opens a NEW row.
- Fields: shop, severity, type, message, detail, first / last seen, related entity, status.

| Type | Raised when |
|---|---|
| LOW_STOCK, OUT_OF_STOCK | active medicines at / below reorder level, at 0 |
| EXPIRING_SOON, EXPIRED | batches expiring within 30 days / expired with stock |
| DEAD_STOCK | medicines in stock with no sale in 90 days |
| SHIFT_SHORTAGE, SHIFT_OVERAGE, SHIFT_LEFT_OPEN | closed with variance awaiting review / still open from a previous day |
| SYNC_FAILURE, COMMAND_REJECTED | sync failing / halted / events rejected; remote commands rejected (24 h) |
| SHOP_OFFLINE | (online) no heartbeat |
| BACKUP_FAILED, BACKUP_STALE | last backup failed / older than 26 h / disabled |
| UPDATE_FAILED | update failed or rolled back (7 days) |
| DATA_INTEGRITY_WARNING | negative stock, medicine total different from its batches |
| LOGIN_SECURITY_WARNING | 10+ failed logins at the shop in an hour |
| SYSTEM_DISK, SYSTEM_SERVICE | low disk, server restarting repeatedly |

The slower checks (dead stock, integrity, failed logins) are cached `OPS_CHECKS_CACHE_SECONDS` (600 s).
`GET /api/alerts` (`alerts.view`: Admin, Manager), `POST /api/alerts/:id/ack` (`alerts.manage`: Admin).

## Audit trail

Audited at the shop (`audit_logs`, travels to the cloud with the next event): login, **failed login**
(identifier only), user create / profile / role / password / activation / sessions (local and remote),
medicine and price changes (+ `price_history`), stock add / remove / set / physical count, stocktake
create / start / submit / approve / adjustment / cancel, purchases, returns, voids, refunds, expenses,
settings, shift open / close / review / correction, remote commands (`REMOTE_*`), alert acknowledgement,
**backup succeeded / failed**, **sync event rejected, sync failure / restored**, **application update
installed / rolled back / failed** (recorded at the next server start), receipt reprints.

Never stored: password, password hash, PIN, PIN hash, JWT, database password, service keys, shop token,
backup file paths (test AU3).
