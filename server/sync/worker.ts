import pg from 'pg';
import { pgPool, getDatabaseConnectionConfig } from '../db/client';
import { getSyncConfig, cloudHost } from './config';
import { callCloud, CloudError } from './cloudClient';
import { applyCloudCommand, type CloudCommand } from './commands';
import { getShopIdentity, reconcileShopIdentity } from './identity';

/**
 * Background sync worker on the LOCAL server.
 *
 *  - one active worker per database: a session-level advisory lock elects the leader, so a second
 *    server process (or a restart overlap) never ships events concurrently
 *  - events are claimed in short transactions (FOR UPDATE SKIP LOCKED); no database connection or
 *    transaction is held while waiting on the network
 *  - transient failures (network, DNS, timeout, HTTP 5xx/429) keep events PENDING with exponential
 *    backoff; only an event the cloud explicitly REJECTS becomes FAILED
 *  - when the cloud becomes reachable again, backed-off events are made due immediately
 *  - PROCESSING rows left by a crash are returned to PENDING when leadership is acquired
 *  - startup never depends on the cloud: every cloud error is caught, logged and retried later
 */
const LEADER_LOCK_KEY = 7_420_317_001; // arbitrary constant for pg_try_advisory_lock
const BASE_RETRY_SECONDS = 5;
const MAX_BATCHES_PER_CYCLE = 20;
const MANUAL_WAKE_MIN_INTERVAL_MS = 3000;

type StateKey = 'last_success_at' | 'last_error' | 'last_error_at' | 'last_contact_at';

class SyncWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;
  private stopped = false;
  private wakePending = false;
  private lastManualWake = 0;
  private leader: pg.Client | null = null;
  private isLeader = false;
  private leaderNoticeLogged = false;
  private consecutiveFailures = 0;
  private haltedReason: string | null = null;
  private nextRunAt: number | null = null;
  /** Commands whose apply failure was already logged (avoid one log line per cycle). */
  private loggedCommandErrors = new Set<string>();
  readonly workerId = `server-${process.pid}`;

  cloudReachable: boolean | null = null;

  start(): void {
    const cfg = getSyncConfig();
    if (this.started || !cfg.workerEnabled) return;
    this.started = true;
    this.stopped = false;
    if (!cfg.cloudConfigured) {
      console.warn(`[Sync] Hybrid worker enabled but the cloud is not configured: ${cfg.configError} Events will queue locally.`);
    } else {
      console.log(`[Sync] Worker started (cloud ${cloudHost(cfg)}, every ${cfg.intervalMs / 1000}s, batch ${cfg.batchSize}).`);
    }
    this.schedule(1000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const deadline = Date.now() + 10_000;
    while (this.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await this.releaseLeadership();
  }

  /** Runs a cycle as soon as possible. Never bypasses per-event backoff or idempotency. */
  wake(manual = false): 'scheduled' | 'throttled' | 'disabled' {
    if (!this.started || this.stopped) return 'disabled';
    if (manual) {
      if (Date.now() - this.lastManualWake < MANUAL_WAKE_MIN_INTERVAL_MS) return 'throttled';
      this.lastManualWake = Date.now();
    }
    if (this.running) {
      this.wakePending = true;
      return 'scheduled';
    }
    this.schedule(0);
    return 'scheduled';
  }

  status() {
    return {
      running: this.started && !this.stopped,
      leader: this.isLeader,
      busy: this.running,
      halted_reason: this.haltedReason,
      consecutive_failures: this.consecutiveFailures,
      next_run_at: this.nextRunAt ? new Date(this.nextRunAt).toISOString() : null,
    };
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextRunAt = Date.now() + ms;
    this.timer = setTimeout(() => void this.cycle(), ms);
    this.timer.unref?.();
  }

  private nextDelay(): number {
    const cfg = getSyncConfig();
    if (this.consecutiveFailures === 0) return cfg.intervalMs;
    return Math.min(cfg.maxBackoffMs, cfg.intervalMs * 2 ** Math.min(this.consecutiveFailures - 1, 10));
  }

  private async cycle(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    this.nextRunAt = null;
    try {
      await this.runOnce();
    } catch (err: any) {
      // Database trouble or a bug: log and retry later; never crash the POS server.
      console.error('[Sync] Cycle error:', err?.message || err);
      await this.saveState({ last_error: `Local: ${String(err?.message || err).slice(0, 500)}`, last_error_at: new Date().toISOString() }).catch(() => {});
    } finally {
      this.running = false;
      const again = this.wakePending;
      this.wakePending = false;
      this.schedule(again ? 0 : this.nextDelay());
    }
  }

  private async runOnce(): Promise<void> {
    const cfg = getSyncConfig();
    if (!(await this.ensureLeadership())) return;
    if (!cfg.cloudConfigured) {
      this.haltedReason = cfg.configError;
      return;
    }
    if (this.haltedReason !== null) {
      this.haltedReason = await reconcileShopIdentity();
      if (this.haltedReason) return;
    }

    await this.reackInboundCommands();

    // 1. Outbound
    const outbound = await this.pushDueEvents();
    if (outbound === 'unreachable') return;

    // 2. Inbound (doubles as the reachability probe when nothing was due)
    const inbound = await this.pullAndApplyCommands();
    if (inbound === 'unreachable') return;

    // 3. Cloud just became reachable again: make backed-off events due and push them now.
    if (inbound === 'reconnected' || outbound === 'reconnected') {
      const res = await pgPool.query(
        `UPDATE sync_events SET next_attempt_at = CURRENT_TIMESTAMP WHERE status = 'PENDING' AND next_attempt_at > CURRENT_TIMESTAMP`
      );
      if (res.rowCount) console.log(`[Sync] Cloud reachable again; retrying ${res.rowCount} backed-off event(s) now.`);
      await this.pushDueEvents();
    }
  }

  // -------------------------------------------------------------------------- leadership
  private async ensureLeadership(): Promise<boolean> {
    if (this.isLeader && this.leader) return true;
    try {
      if (!this.leader) {
        const conf: any = { ...getDatabaseConnectionConfig() };
        delete conf.max;
        delete conf.idleTimeoutMillis;
        const client = new pg.Client(conf);
        client.on('error', (err) => {
          console.warn('[Sync] Leader connection lost:', err.message);
          this.isLeader = false;
          this.leader = null;
        });
        await client.connect();
        this.leader = client;
      }
      const res = await this.leader.query('SELECT pg_try_advisory_lock($1) AS ok', [LEADER_LOCK_KEY]);
      if (!res.rows[0].ok) {
        if (!this.leaderNoticeLogged) {
          console.warn('[Sync] Another server process is already running the sync worker for this database; this one stays idle.');
          this.leaderNoticeLogged = true;
        }
        return false;
      }
      this.isLeader = true;
      this.leaderNoticeLogged = false;
      // Rows a previous (crashed) worker had claimed go back to the queue.
      const recovered = await pgPool.query(
        `UPDATE sync_events SET status = 'PENDING', locked_at = NULL, locked_by = NULL WHERE status = 'PROCESSING'`
      );
      if (recovered.rowCount) console.log(`[Sync] Recovered ${recovered.rowCount} event(s) left in PROCESSING.`);
      this.haltedReason = await reconcileShopIdentity();
      if (this.haltedReason) console.error(`[Sync] ${this.haltedReason}`);
      return true;
    } catch (err: any) {
      console.warn('[Sync] Could not acquire worker leadership (database unavailable?):', err?.message || err);
      await this.releaseLeadership();
      return false;
    }
  }

  private async releaseLeadership() {
    const c = this.leader;
    this.leader = null;
    this.isLeader = false;
    if (c) await c.end().catch(() => {});
  }

  // -------------------------------------------------------------------------- outbound
  private async pushDueEvents(): Promise<'ok' | 'reconnected' | 'unreachable'> {
    const cfg = getSyncConfig();
    let outcome: 'ok' | 'reconnected' = 'ok';
    for (let i = 0; i < MAX_BATCHES_PER_CYCLE && !this.stopped; i++) {
      const claimed = await pgPool.query(
        `UPDATE sync_events
            SET status = 'PROCESSING', attempt_count = attempt_count + 1, last_attempt_at = CURRENT_TIMESTAMP,
                locked_at = CURRENT_TIMESTAMP, locked_by = $2
          WHERE id IN (SELECT id FROM sync_events
                        WHERE status = 'PENDING' AND next_attempt_at <= CURRENT_TIMESTAMP
                        ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED)
          RETURNING id, seq, idempotency_key, shop_id, device_id, event_type, operation, entity_type, entity_id,
                    payload, actor_user_id, actor_name, business_ref, created_at, attempt_count`,
        [cfg.batchSize, this.workerId]
      );
      const rows = claimed.rows.sort((a, b) => Number(a.seq) - Number(b.seq));
      if (rows.length === 0) return outcome;

      const identity = await getShopIdentity();
      const events = rows.map((r) => ({
        event_id: r.id,
        idempotency_key: r.idempotency_key,
        shop_id: r.shop_id,
        local_seq: String(r.seq),
        event_type: r.event_type,
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        operation: r.operation,
        device_id: r.device_id,
        actor_user_id: r.actor_user_id,
        actor_name: r.actor_name,
        business_ref: r.business_ref,
        occurred_at: new Date(r.created_at).toISOString(),
        payload: r.payload,
      }));

      let response: any;
      try {
        response = await callCloud('gc_ingest_events', { p_shop_id: identity.shop_id, p_token: cfg.shopToken, p_events: events });
      } catch (err: any) {
        await this.markRetry(rows.map((r) => r.id), err?.message || String(err));
        return (await this.noteFailure(err)) ? 'unreachable' : outcome;
      }
      if ((await this.noteSuccess()) === 'reconnected') outcome = 'reconnected';

      const byKey = new Map<string, any>();
      for (const r of Array.isArray(response?.results) ? response.results : []) byKey.set(r.idempotency_key, r);
      const synced: string[] = [];
      const missing: string[] = [];
      for (const r of rows) {
        const res = byKey.get(r.idempotency_key);
        if (res?.status === 'APPLIED' || res?.status === 'DUPLICATE') synced.push(r.id);
        else if (res?.status === 'REJECTED') {
          await pgPool.query(
            `UPDATE sync_events SET status = 'FAILED', last_error = $2, locked_at = NULL, locked_by = NULL WHERE id = $1`,
            [r.id, `Rejected by cloud: ${String(res.error || 'invalid event').slice(0, 1000)}`]
          );
          console.error(`[Sync] Event ${r.event_type} ${r.id} rejected by cloud: ${res.error}`);
        } else missing.push(r.id);
      }
      if (synced.length) {
        await pgPool.query(
          `UPDATE sync_events SET status = 'SYNCED', synced_at = CURRENT_TIMESTAMP, processed_at = CURRENT_TIMESTAMP,
                  last_error = NULL, locked_at = NULL, locked_by = NULL
            WHERE id = ANY($1::uuid[])`,
          [synced]
        );
        await this.saveState({ last_success_at: new Date().toISOString() });
      }
      if (missing.length) await this.markRetry(missing, 'Cloud response did not include a result for this event.');
      if (rows.length < cfg.batchSize) return outcome;
    }
    return outcome;
  }

  private async markRetry(ids: string[], error: string) {
    const cfg = getSyncConfig();
    await pgPool.query(
      `UPDATE sync_events
          SET status = 'PENDING', locked_at = NULL, locked_by = NULL, last_error = $2,
              next_attempt_at = CURRENT_TIMESTAMP + make_interval(secs =>
                LEAST($3::float8, $4::float8 * power(2, LEAST(GREATEST(attempt_count - 1, 0), 16))) * (0.8 + random() * 0.4))
        WHERE id = ANY($1::uuid[]) AND status = 'PROCESSING'`,
      [ids, error.slice(0, 1000), cfg.maxBackoffMs / 1000, BASE_RETRY_SECONDS]
    );
  }

  // -------------------------------------------------------------------------- inbound
  private async pullAndApplyCommands(): Promise<'ok' | 'reconnected' | 'unreachable'> {
    const cfg = getSyncConfig();
    const identity = await getShopIdentity();
    let response: any;
    try {
      response = await callCloud('gc_pull_commands', { p_shop_id: identity.shop_id, p_token: cfg.shopToken, p_limit: 20 });
    } catch (err: any) {
      return (await this.noteFailure(err)) ? 'unreachable' : 'ok';
    }
    const outcome = await this.noteSuccess();
    const commands: CloudCommand[] = Array.isArray(response?.commands) ? response.commands : [];
    const outcomes: { cmd: CloudCommand; result: Awaited<ReturnType<typeof applyCloudCommand>> }[] = [];
    for (const cmd of commands) {
      let result;
      try {
        result = await applyCloudCommand(cmd);
      } catch (err: any) {
        if (typeof err?.status === 'number') {
          // Malformed beyond recording (no usable id/key): nothing to apply or acknowledge.
          console.error('[Sync] Ignoring malformed cloud command:', err.message);
          continue;
        }
        if (!this.loggedCommandErrors.has(cmd?.command_id)) {
          this.loggedCommandErrors.add(cmd?.command_id);
          console.error(`[Sync] Command ${cmd?.command_id} could not be applied now (will retry):`, err?.message || err);
        }
        continue;
      }
      if (!result.duplicate) {
        console.log(`[Sync] Cloud command ${cmd.command_type} ${cmd.command_id}: ${result.status}${result.error ? ` (${result.error})` : ''}`);
      }
      outcomes.push({ cmd, result });
    }
    // Ship the events the applied commands produced (stock movements, prices) BEFORE acknowledging,
    // so a command reported APPLIED in the cloud is already reflected in the cloud copy.
    if (outcomes.some((o) => o.result.status === 'APPLIED' && !o.result.duplicate)) {
      if ((await this.pushDueEvents()) === 'unreachable') return 'unreachable';
    }
    for (const { cmd, result } of outcomes) await this.ack(cmd.command_id, result.status, result.result, result.error);
    return outcome;
  }

  private async ack(commandId: string, status: string, result: unknown, error: string | null): Promise<boolean> {
    const cfg = getSyncConfig();
    const identity = await getShopIdentity();
    try {
      await callCloud('gc_ack_command', {
        p_shop_id: identity.shop_id, p_token: cfg.shopToken, p_command_id: commandId, p_status: status,
        p_result: result ?? null, p_error: error,
      });
      await pgPool.query('UPDATE sync_inbound_commands SET acked_at = CURRENT_TIMESTAMP WHERE command_id = $1', [commandId]);
      return true;
    } catch (err: any) {
      // Applied locally already; the next cycle re-acknowledges (re-delivery is a no-op here).
      console.warn(`[Sync] Acknowledgement of command ${commandId} failed (will retry):`, err?.message || err);
      if (err instanceof CloudError && err.transient) await this.noteFailure(err);
      return false;
    }
  }

  private async reackInboundCommands() {
    const res = await pgPool.query(
      `SELECT command_id, status, result, error FROM sync_inbound_commands WHERE acked_at IS NULL ORDER BY received_at LIMIT 50`
    );
    for (const r of res.rows) {
      if (!(await this.ack(r.command_id, r.status, r.result, r.error))) break;
    }
  }

  // -------------------------------------------------------------------------- state
  /** Returns true when the failure means the cloud is unreachable (stop this cycle). */
  private async noteFailure(err: any): Promise<boolean> {
    const message = String(err?.message || err).slice(0, 500);
    const unreachable = err instanceof CloudError ? err.status === 0 : true;
    if (unreachable) this.cloudReachable = false;
    else this.cloudReachable = true;
    this.consecutiveFailures++;
    if (this.consecutiveFailures === 1 || this.consecutiveFailures % 10 === 0) {
      console.warn(`[Sync] ${message} (failure #${this.consecutiveFailures}; events stay queued locally)`);
    }
    await this.saveState({ last_error: message, last_error_at: new Date().toISOString() });
    return unreachable || (err instanceof CloudError && err.transient);
  }

  private async noteSuccess(): Promise<'ok' | 'reconnected'> {
    const wasDown = this.cloudReachable !== true;
    this.cloudReachable = true;
    if (this.consecutiveFailures > 0) console.log('[Sync] Cloud connection restored.');
    this.consecutiveFailures = 0;
    await this.saveState({ last_contact_at: new Date().toISOString() });
    return wasDown ? 'reconnected' : 'ok';
  }

  private async saveState(values: Partial<Record<StateKey, string>>) {
    for (const [key, value] of Object.entries(values)) {
      await pgPool.query(
        `INSERT INTO sync_state (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
        [key, value]
      );
    }
  }
}

export const syncWorker = new SyncWorker();

export function startSyncWorker(): void {
  try {
    syncWorker.start();
  } catch (err: any) {
    console.error('[Sync] Worker failed to start (POS continues locally):', err?.message || err);
  }
}

/** Status for GET /api/sync/status. Contains no secrets. */
export async function getSyncStatus() {
  const cfg = getSyncConfig();
  const base = {
    mode: cfg.mode,
    outbox_enabled: cfg.outboxEnabled,
    enabled: cfg.workerEnabled,
    device_id: cfg.deviceId,
  };
  if (!cfg.outboxEnabled) {
    return { ...base, shop_id: null, branch_id: null, shop_code: null, counts: null, cloud: null, worker: null, last_sync: null, last_error: null };
  }
  const [identity, counts, state, inbound] = await Promise.all([
    getShopIdentity(),
    pgPool.query(`
      SELECT COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
             COUNT(*) FILTER (WHERE status = 'PROCESSING')::int AS processing,
             COUNT(*) FILTER (WHERE status = 'SYNCED')::int AS synced,
             COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
             COUNT(*) FILTER (WHERE status = 'PENDING' AND attempt_count > 0)::int AS retrying,
             MIN(created_at) FILTER (WHERE status IN ('PENDING', 'PROCESSING')) AS oldest_pending_at,
             MAX(synced_at) AS last_synced_event_at
        FROM sync_events`),
    pgPool.query(`SELECT key, value FROM sync_state`),
    pgPool.query(`
      SELECT COUNT(*) FILTER (WHERE status = 'APPLIED')::int AS applied,
             COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
             COUNT(*) FILTER (WHERE acked_at IS NULL)::int AS unacknowledged
        FROM sync_inbound_commands`),
  ]);
  const st = Object.fromEntries(state.rows.map((r) => [r.key, r.value]));
  const c = counts.rows[0];
  const lastErrorRow = await pgPool.query(
    `SELECT event_type, last_error, last_attempt_at FROM sync_events
      WHERE status IN ('PENDING', 'FAILED') AND last_error IS NOT NULL ORDER BY last_attempt_at DESC NULLS LAST LIMIT 1`
  );
  return {
    ...base,
    shop_id: identity.shop_id,
    shop_code: identity.shop_code,
    branch_id: identity.branch_id,
    counts: {
      pending: c.pending,
      processing: c.processing,
      synced: c.synced,
      failed: c.failed,
      retrying: c.retrying,
      oldest_pending_at: c.oldest_pending_at ? new Date(c.oldest_pending_at).toISOString() : null,
    },
    inbound_commands: inbound.rows[0],
    last_sync: st.last_success_at || (c.last_synced_event_at ? new Date(c.last_synced_event_at).toISOString() : null),
    last_contact: st.last_contact_at || null,
    last_error: st.last_error || null,
    last_error_at: st.last_error_at || null,
    last_event_error: lastErrorRow.rows[0]
      ? { event_type: lastErrorRow.rows[0].event_type, error: lastErrorRow.rows[0].last_error, at: lastErrorRow.rows[0].last_attempt_at }
      : null,
    cloud: {
      configured: cfg.cloudConfigured,
      config_error: cfg.configError,
      host: cloudHost(cfg),
      key_type: cfg.apiKeyKind,
      reachable: cfg.workerEnabled ? syncWorker.cloudReachable : null,
    },
    cloud_reachable: cfg.workerEnabled ? syncWorker.cloudReachable : null,
    worker: syncWorker.status(),
  };
}
