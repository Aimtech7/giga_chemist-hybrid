/**
 * GIGA CHEMIST — Client-Side Cryptographic Credential Verification
 * Uses Web Crypto API (SubtleCrypto) to verify PBKDF2-SHA512 credentials in browser/online environments.
 * 100% compatible with backend server/auth.ts PBKDF2 (100,000 iterations, 64-byte SHA-512).
 */

export async function verifyBrowserCredential(
  secret: string,
  storedHash: string
): Promise<boolean> {
  if (!secret || !storedHash) return false;

  try {
    // Expected format: salt$hash
    if (!storedHash.includes('$')) return false;

    const parts = storedHash.split('$');
    const saltHex = parts.length >= 3 ? parts[parts.length - 2] : parts[0];
    const targetHashHex = parts[parts.length - 1];

    if (!saltHex || !targetHashHex) return false;

    // Use UTF-8 encoded bytes for salt to match Node crypto.pbkdf2Sync(secret, saltStr, ...)
    const saltBytes = new TextEncoder().encode(saltHex);

    // Import secret as PBKDF2 key
    const secretBytes = new TextEncoder().encode(secret);
    const keyMaterial = await window.crypto.subtle.importKey(
      'raw',
      secretBytes,
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );

    // Derive 64 bytes (512 bits) with 100,000 iterations of SHA-512
    const derivedBits = await window.crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: saltBytes,
        iterations: 100000,
        hash: 'SHA-512',
      },
      keyMaterial,
      64 * 8
    );

    // Convert derived bits to hex string
    const derivedHex = Array.from(new Uint8Array(derivedBits))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    return derivedHex.toLowerCase() === targetHashHex.toLowerCase();
  } catch (err) {
    console.error('[Crypto] PBKDF2 verification error:', err);
    return false;
  }
}
