import { supabaseAdmin, isSupabaseConfigured } from './client';

export interface DeviceRecord {
  id: string;
  name: string;
  device_type: string;
  app_version: string;
  first_registered: string;
  last_seen: string;
  last_synced_at?: string;
  status: 'active' | 'inactive';
}

const localDevices = new Map<string, DeviceRecord>();

export async function registerDevice(data: {
  device_id: string;
  name?: string;
  device_type?: string;
  app_version?: string;
}): Promise<DeviceRecord> {
  const id = data.device_id || `POS-DEVICE-${Date.now()}`;
  const now = new Date().toISOString();

  let existing = localDevices.get(id);
  const record: DeviceRecord = {
    id,
    name: data.name || existing?.name || `Terminal ${id.slice(-6)}`,
    device_type: data.device_type || existing?.device_type || 'desktop',
    app_version: data.app_version || existing?.app_version || '1.0.0-pwa',
    first_registered: existing?.first_registered || now,
    last_seen: now,
    status: 'active',
  };

  localDevices.set(id, record);

  if (isSupabaseConfigured) {
    try {
      await supabaseAdmin.from('devices').upsert({
        id: record.id,
        name: record.name,
        device_type: record.device_type,
        app_version: record.app_version,
        last_seen: record.last_seen,
        status: record.status,
      });
    } catch (e) {}
  }

  return record;
}

export async function getDevice(id: string): Promise<DeviceRecord | null> {
  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabaseAdmin.from('devices').select('*').eq('id', id).single();
      if (!error && data) return data as DeviceRecord;
    } catch (e) {}
  }
  return localDevices.get(id) || null;
}
