/**
 * crypto.js
 * Low-level Web Crypto helpers.
 *
 * The vault no longer keeps a global CryptoKey in memory.
 * Instead, the master password (string) is passed explicitly to storage.js
 * which derives a fresh key per file-write using a per-file random salt.
 * This makes every .vault file independently decryptable and fully portable.
 */

/**
 * Derive a 256-bit AES-GCM key from a plaintext password and a salt
 * using PBKDF2 / SHA-256 with 100 000 iterations.
 *
 * @param {string}     password  Plain-text master password.
 * @param {Uint8Array} salt      16-byte random salt.
 * @returns {Promise<CryptoKey>}
 */
async function deriveMasterKey(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
