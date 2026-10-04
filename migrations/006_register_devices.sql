-- Migration 006: Ensure standard terminal devices exist for foreign key integrity
INSERT INTO devices (id, name, device_type, app_version, status)
VALUES 
  ('SERVER', 'Local Server Backend', 'server', '1.0.0', 'active'),
  ('POS-TERMINAL-01', 'Main POS Terminal 1', 'desktop', '1.0.0', 'active'),
  ('SERVER-POS', 'Server POS Terminal', 'desktop', '1.0.0', 'active'),
  ('REMOTE-CLIENT', 'Remote Local Client', 'browser', '1.0.0', 'active')
ON CONFLICT (id) DO NOTHING;
