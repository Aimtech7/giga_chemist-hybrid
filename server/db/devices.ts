import { pgPool, type Queryable } from './client';

export interface DeviceRecord {
  id: string;
  name: string;
  device_type: string;
  app_version: string;
  first_registered: string;
  last_seen: string;
  last_synced_at?: string;
  status: string;
}

/** Backend device used when a request carries no usable device id. Created by migration 005/007. */
export const SERVER_DEVICE_ID = 'SERVER';

/** devices.id is VARCHAR(100); accept only plain identifier characters from the X-Device-Id header. */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

export function normalizeDeviceId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return DEVICE_ID_PATTERN.test(id) ? id : null;
}

function toDeviceRecord(r: any): DeviceRecord {
  return {
    id: r.id,
    name: r.name,
    device_type: r.device_type || 'desktop',
    app_version: r.app_version,
    first_registered: r.first_registered ? new Date(r.first_registered).toISOString() : '',
    last_seen: r.last_seen ? new Date(r.last_seen).toISOString() : '',
    last_synced_at: r.last_synced_at ? new Date(r.last_synced_at).toISOString() : undefined,
    status: r.status || 'active',
  };
}

/**
 * Guarantees the devices row referenced by sales / returns / inventory_movements exists (FK) and
 * returns the id to use. Runs on the caller's transaction client so the device row commits or rolls
 * back together with the business write. Unknown or malformed ids fall back to the SERVER device.
 */
export async function ensureDevice(q: Queryable, rawDeviceId: unknown, userId?: string | null): Promise<string> {
  const id = normalizeDeviceId(rawDeviceId);
  if (!id || id === SERVER_DEVICE_ID) {
    await q.query(
      `INSERT INTO devices (id, name, device_type, app_version, status)
       VALUES ($1, 'Local Server Backend', 'server', '1.0.0', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [SERVER_DEVICE_ID]
    );
    return SERVER_DEVICE_ID;
  }
  await q.query(
    `INSERT INTO devices (id, name, device_type, app_version, status, current_user_id, last_seen)
     VALUES ($1, $2, 'desktop', '1.0.0-pwa', 'active', $3, CURRENT_TIMESTAMP)
     ON CONFLICT (id) DO UPDATE SET
       last_seen = CURRENT_TIMESTAMP,
       current_user_id = COALESCE(EXCLUDED.current_user_id, devices.current_user_id)`,
    [id, `Terminal ${id.slice(-12)}`, userId || null]
  );
  return id;
}

/** Explicit registration from POST /api/devices/register. Persists to PostgreSQL. */
export async function registerDevice(data: {
  device_id: string;
  name?: string;
  device_type?: string;
  app_version?: string;
  user_id?: string;
}): Promise<DeviceRecord> {
  const id = normalizeDeviceId(data.device_id);
  if (!id) {
    const err: any = new Error('device_id must be 1-100 characters of letters, digits, ".", "_", ":" or "-".');
    err.status = 400;
    throw err;
  }
  const res = await pgPool.query(
    `INSERT INTO devices (id, name, device_type, app_version, status, current_user_id, last_seen)
     VALUES ($1, $2, $3, $4, 'active', $5, CURRENT_TIMESTAMP)
     ON CONFLICT (id) DO UPDATE SET
       name = COALESCE($6, devices.name),
       device_type = COALESCE($7, devices.device_type),
       app_version = COALESCE($8, devices.app_version),
       current_user_id = COALESCE(EXCLUDED.current_user_id, devices.current_user_id),
       last_seen = CURRENT_TIMESTAMP
     RETURNING *`,
    [
      id,
      (data.name || `Terminal ${id.slice(-12)}`).slice(0, 255),
      (data.device_type || 'desktop').slice(0, 50),
      (data.app_version || '1.0.0-pwa').slice(0, 50),
      data.user_id || null,
      data.name ? data.name.slice(0, 255) : null,
      data.device_type ? data.device_type.slice(0, 50) : null,
      data.app_version ? data.app_version.slice(0, 50) : null,
    ]
  );
  return toDeviceRecord(res.rows[0]);
}

export async function getDevice(id: string): Promise<DeviceRecord | null> {
  const res = await pgPool.query('SELECT * FROM devices WHERE id = $1', [id]);
  return res.rows[0] ? toDeviceRecord(res.rows[0]) : null;
}
