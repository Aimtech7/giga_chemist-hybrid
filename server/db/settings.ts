import { pgPool, isLocalMode, supabaseAdmin, isSupabaseConfigured } from './client';
import { serverDb } from '../db';
import type { PharmacySettings } from '../../src/types';

export async function getPharmacySettings(): Promise<PharmacySettings> {
  try {
    const res = await pgPool.query(`SELECT value FROM settings WHERE key = 'pharmacy_settings' LIMIT 1;`);
    if (res.rows && res.rows.length > 0 && res.rows[0].value) {
      const val = res.rows[0].value;
      return typeof val === 'string' ? JSON.parse(val) : val;
    }
  } catch (err) {}

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      const { data, error } = await supabaseAdmin
        .from('settings')
        .select('*')
        .single();
      if (!error && data) return data as PharmacySettings;
    } catch (err) {
      console.warn('[Server DB] Supabase settings query failed:', err);
    }
  }
  return serverDb.get().settings;
}

export async function updatePharmacySettings(settings: Partial<PharmacySettings>): Promise<PharmacySettings> {
  const store = serverDb.get();
  const updated: PharmacySettings = {
    ...store.settings,
    ...settings,
    updated_at: new Date().toISOString(),
  };

  try {
    await pgPool.query(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ('pharmacy_settings', $1::jsonb, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = CURRENT_TIMESTAMP
    `, [JSON.stringify(updated)]);
  } catch (pgErr) {}

  if (!isLocalMode && isSupabaseConfigured) {
    try {
      await supabaseAdmin.from('settings').upsert({
        branch_id: '00000000-0000-0000-0000-000000000000',
        pharmacy_name: updated.pharmacy_name,
        tagline: updated.tagline,
        address: updated.address,
        phone: updated.phone,
        email: updated.email,
        currency: updated.currency,
        tax_rate: updated.tax_rate,
        tax_enabled: updated.tax_enabled,
        receipt_header: updated.receipt_header,
        receipt_footer: updated.receipt_footer,
        printer_type: updated.printer_type,
        auto_print_receipt: updated.auto_print_receipt,
        low_stock_threshold: updated.low_stock_threshold,
        expiry_warning_days: updated.expiry_warning_days,
        version: updated.version,
        updated_at: updated.updated_at,
      });
    } catch (err) {
      console.warn('[Server DB] Supabase update settings failed:', err);
    }
  }

  store.settings = updated;
  serverDb.persist();
  return updated;
}
