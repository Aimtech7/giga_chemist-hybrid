import type { DeviceInfo } from '../types';
import { db } from '../db/dexie';

const DEVICE_STORAGE_KEY = 'giga_chemist_device_id';

function generateDeviceId(): string {
  const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `POS-KITALE-01-${randomSuffix}`;
}

export async function getOrRegisterDevice(): Promise<DeviceInfo> {
  const existingRecord = await db.devices.get('current_device');
  if (existingRecord) {
    // Update last seen
    existingRecord.last_seen = new Date().toISOString();
    await db.devices.put(existingRecord);
    return existingRecord;
  }

  let localId = '';
  try {
    localId = localStorage.getItem(DEVICE_STORAGE_KEY) || '';
  } catch (e) {}

  const deviceId = localId || generateDeviceId();
  try {
    localStorage.setItem(DEVICE_STORAGE_KEY, deviceId);
  } catch (e) {}

  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
  const isTablet = /ipad|android(?!.*mobile)/i.test(userAgent);
  const isMobile = /iphone|android.*mobile/i.test(userAgent);
  const deviceType: DeviceInfo['device_type'] = isTablet ? 'tablet' : isMobile ? 'mobile' : 'desktop';

  const newDevice: DeviceInfo = {
    id: deviceId,
    name: `Register Terminal 01 (${deviceType})`,
    device_type: deviceType,
    app_version: '1.0.0-pwa',
    first_registered: new Date().toISOString(),
    last_seen: new Date().toISOString(),
  };

  await db.devices.put(newDevice);
  return newDevice;
}

export async function getDeviceId(): Promise<string> {
  const d = await getOrRegisterDevice();
  return d.id;
}

export async function updateDeviceLastSync(syncedAt: string = new Date().toISOString()): Promise<void> {
  const device = await db.devices.get('current_device');
  if (device) {
    device.last_synced_at = syncedAt;
    device.last_seen = new Date().toISOString();
    await db.devices.put(device);
  }
}
