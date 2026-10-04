import type { DeviceInfo } from '../types';
import { db } from '../db/dexie';

/** Same key read synchronously by services/http.ts for the X-Device-Id header. */
const DEVICE_STORAGE_KEY = 'giga_chemist_device_id';

/**
 * Terminal identity. New terminals get "POS-<uuid>"; an id already stored on this browser is kept
 * so that existing sales / movements stay linked to it. The server persists every id it receives
 * in the PostgreSQL devices table (FK target of sales, returns and inventory_movements).
 */
function readStoredDeviceId(): string {
  try {
    return localStorage.getItem(DEVICE_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export async function getOrRegisterDevice(): Promise<DeviceInfo> {
  let deviceId = readStoredDeviceId();
  if (!deviceId) {
    deviceId = `POS-${crypto.randomUUID()}`;
    try {
      localStorage.setItem(DEVICE_STORAGE_KEY, deviceId);
    } catch {}
  }

  const now = new Date().toISOString();
  const existing = await db.devices.get(deviceId);
  if (existing) {
    existing.last_seen = now;
    await db.devices.put(existing);
    return existing;
  }

  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
  const isTablet = /ipad|android(?!.*mobile)/i.test(userAgent);
  const isMobile = /iphone|android.*mobile/i.test(userAgent);
  const deviceType: DeviceInfo['device_type'] = isTablet ? 'tablet' : isMobile ? 'mobile' : 'desktop';

  const device: DeviceInfo = {
    id: deviceId,
    name: `Register Terminal (${deviceType})`,
    device_type: deviceType,
    app_version: '1.0.0-pwa',
    first_registered: now,
    last_seen: now,
  };
  await db.devices.put(device);
  return device;
}

export async function getDeviceId(): Promise<string> {
  return (await getOrRegisterDevice()).id;
}

export async function updateDeviceLastSync(syncedAt: string = new Date().toISOString()): Promise<void> {
  const device = await db.devices.get(readStoredDeviceId());
  if (device) {
    device.last_synced_at = syncedAt;
    device.last_seen = new Date().toISOString();
    await db.devices.put(device);
  }
}
