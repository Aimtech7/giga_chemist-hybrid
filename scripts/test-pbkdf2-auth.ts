import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import crypto from 'crypto';
dotenv.config();

const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const anonKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

const client = createClient(url, anonKey);

// Node.js PBKDF2 verify matching server/auth.ts
function verifyPbkdf2(storedHash: string, input: string): boolean {
  try {
    if (!storedHash || !storedHash.includes('$')) return false;
    const parts = storedHash.split('$');
    const salt = parts.length >= 3 ? parts[parts.length - 2] : parts[0];
    const key = parts[parts.length - 1];
    if (!salt || !key) return false;
    const derived = crypto.pbkdf2Sync(input, salt, 100000, 64, 'sha512').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(key, 'hex'));
  } catch (err) {
    return false;
  }
}

// Web Crypto API PBKDF2 verify matching UTF-8 string salt
async function verifyBrowserCredential(storedHash: string, input: string): Promise<boolean> {
  if (!storedHash || !storedHash.includes('$')) return false;
  const parts = storedHash.split('$');
  const saltStr = parts.length >= 3 ? parts[parts.length - 2] : parts[0];
  const originalKeyHex = parts[parts.length - 1];
  if (!saltStr || !originalKeyHex) return false;

  const enc = new TextEncoder();
  const passBuffer = enc.encode(input);
  const saltBytes = enc.encode(saltStr); // UTF-8 bytes of salt string

  const keyMaterial = await crypto.webcrypto.subtle.importKey(
    'raw',
    passBuffer,
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.webcrypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: 100000,
      hash: 'SHA-512',
    },
    keyMaterial,
    64 * 8
  );

  const derivedHex = Array.from(new Uint8Array(derivedBits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return derivedHex.toLowerCase() === originalKeyHex.toLowerCase();
}

async function runTests() {
  console.log('Testing PBKDF2 credential verification against Supabase users...');
  const { data: users, error } = await client
    .from('users')
    .select('*')
    .eq('active', true);

  if (error || !users) {
    console.error('Failed to fetch users:', error);
    return;
  }

  const admin = users.find((u) => u.email === 'admin@gigachemist.co.ke');
  const cashier = users.find((u) => u.email === 'cashier@gigachemist.co.ke');

  console.log('\n--- ADMIN VERIFICATION ---');
  if (admin) {
    const pwNode = verifyPbkdf2(admin.password_hash, 'admingiga1234');
    const pwWeb = await verifyBrowserCredential(admin.password_hash, 'admingiga1234');
    const pinNode = verifyPbkdf2(admin.pin_hash, '1234');
    const pinWeb = await verifyBrowserCredential(admin.pin_hash, '1234');
    const wrongPw = await verifyBrowserCredential(admin.password_hash, 'wrongpass');

    console.log(`Password 'admingiga1234' (Node)      : ${pwNode ? 'PASS' : 'FAIL'}`);
    console.log(`Password 'admingiga1234' (WebCrypto) : ${pwWeb ? 'PASS' : 'FAIL'}`);
    console.log(`PIN '1234' (Node)                    : ${pinNode ? 'PASS' : 'FAIL'}`);
    console.log(`PIN '1234' (WebCrypto)               : ${pinWeb ? 'PASS' : 'FAIL'}`);
    console.log(`Wrong password rejected              : ${!wrongPw ? 'PASS' : 'FAIL'}`);
  }

  console.log('\n--- CASHIER VERIFICATION ---');
  if (cashier) {
    const pwNode = verifyPbkdf2(cashier.password_hash, 'Cashier2026');
    const pwWeb = await verifyBrowserCredential(cashier.password_hash, 'Cashier2026');
    const pinNode = verifyPbkdf2(cashier.pin_hash, '2026');
    const pinWeb = await verifyBrowserCredential(cashier.pin_hash, '2026');
    const wrongPw = await verifyBrowserCredential(cashier.password_hash, 'wrongpass');

    console.log(`Password 'Cashier2026' (Node)        : ${pwNode ? 'PASS' : 'FAIL'}`);
    console.log(`Password 'Cashier2026' (WebCrypto)   : ${pwWeb ? 'PASS' : 'FAIL'}`);
    console.log(`PIN '2026' (Node)                    : ${pinNode ? 'PASS' : 'FAIL'}`);
    console.log(`PIN '2026' (WebCrypto)               : ${pinWeb ? 'PASS' : 'FAIL'}`);
    console.log(`Wrong password rejected              : ${!wrongPw ? 'PASS' : 'FAIL'}`);
  }
}

runTests().catch(console.error);
