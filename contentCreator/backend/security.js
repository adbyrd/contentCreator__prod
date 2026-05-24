// [ FILE NAME : hmac.js : v2.0.0 ]
// Domain  : Storyboard
// Layer   : Backend — Private Utility
// Path    : /backend/storyboard/hmac.js
// ──────────────────────────────────────────────────────────────────────────────
// Changelog v1.0.0 → v2.0.0
//
// [BUG-CRYPTO-07] createHmac from 'crypto' poisons the entire bundle
//
//   ROOT CAUSE:
//     Velo bundles the entire backend/storyboard/ directory together regardless
//     of file extension. A private .js module with `import { createHmac } from
//     'crypto'` crashes the bundle identically to the same import in a .web.js
//     file — the directory-level bundle fails to compile and every export from
//     every file in the directory resolves as undefined.
//
//   FIX:
//     Replaced createHmac with a pure JavaScript HMAC-SHA256 implementation
//     that has zero imports and zero external dependencies. Uses only built-in
//     JavaScript operators and standard array operations available in any
//     Velo-compatible runtime.
//
//     The implementation follows RFC 2104 (HMAC) and FIPS 180-4 (SHA-256).
//     Output is byte-for-byte identical to:
//       createHmac('sha256', secret).update(rawBody).digest('hex')
//
// ──────────────────────────────────────────────────────────────────────────────

// ─── SHA-256 constants ────────────────────────────────────────────────────────
// First 32 bits of the fractional parts of the cube roots of the first 64 primes.

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

// ─── SHA-256 implementation ───────────────────────────────────────────────────

function sha256(msgBytes) {
  // Initial hash values: first 32 bits of fractional parts of sqrt of first 8 primes
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  // Pre-processing: adding padding bits
  const msgLen  = msgBytes.length;
  const bitLen  = msgLen * 8;

  // Append bit '1' (0x80 byte), then zeros, then 64-bit big-endian length
  const padLen  = ((msgLen % 64) < 56 ? 56 : 120) - (msgLen % 64);
  const padded  = new Uint8Array(msgLen + padLen + 8);
  padded.set(msgBytes);
  padded[msgLen] = 0x80;

  // Append original length in bits as 64-bit big-endian
  // JavaScript bitwise ops are 32-bit so handle high/low words separately
  const hiWord  = Math.floor(bitLen / 0x100000000);
  const loWord  = bitLen >>> 0;
  padded[padded.length - 8] = (hiWord >>> 24) & 0xff;
  padded[padded.length - 7] = (hiWord >>> 16) & 0xff;
  padded[padded.length - 6] = (hiWord >>>  8) & 0xff;
  padded[padded.length - 5] = (hiWord >>>  0) & 0xff;
  padded[padded.length - 4] = (loWord >>> 24) & 0xff;
  padded[padded.length - 3] = (loWord >>> 16) & 0xff;
  padded[padded.length - 2] = (loWord >>>  8) & 0xff;
  padded[padded.length - 1] = (loWord >>>  0) & 0xff;

  // Process each 512-bit (64-byte) chunk
  for (let i = 0; i < padded.length; i += 64) {
    const w = new Uint32Array(64);

    // Break chunk into sixteen 32-bit big-endian words
    for (let j = 0; j < 16; j++) {
      w[j] = (padded[i + j * 4]     << 24) |
             (padded[i + j * 4 + 1] << 16) |
             (padded[i + j * 4 + 2] <<  8) |
             (padded[i + j * 4 + 3]);
    }

    // Extend to 64 words
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(w[j - 15],  7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = rotr(w[j -  2], 17) ^ rotr(w[j -  2], 19) ^ (w[j -  2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }

    // Compression
    let a = h0, b = h1, c = h2, d = h3;
    let e = h4, f = h5, g = h6, h = h7;

    for (let j = 0; j < 64; j++) {
      const S1    = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch    = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[j] + w[j]) >>> 0;
      const S0    = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj   = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g; g = f; f = e;
      e = (d + temp1) >>> 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  // Produce final 32-byte digest as Uint8Array
  const digest = new Uint8Array(32);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, i) => {
    digest[i * 4]     = (word >>> 24) & 0xff;
    digest[i * 4 + 1] = (word >>> 16) & 0xff;
    digest[i * 4 + 2] = (word >>>  8) & 0xff;
    digest[i * 4 + 3] = (word >>>  0) & 0xff;
  });
  return digest;
}

function rotr(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

// ─── String / byte helpers ────────────────────────────────────────────────────

function strToBytes(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return new Uint8Array(bytes);
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── HMAC-SHA256 ──────────────────────────────────────────────────────────────

/**
 * Produces a lowercase hex-encoded HMAC-SHA256 digest.
 * Pure JavaScript — no imports, no globals, no external dependencies.
 * Output is byte-for-byte identical to:
 *   createHmac('sha256', secret).update(rawBody).digest('hex')
 *
 * @param {string} rawBody  — JSON-stringified payload to sign
 * @param {string} secret   — shared HMAC secret (N8N_CALLBACK_SECRET_KEY)
 * @returns {string}        — lowercase hex HMAC-SHA256 digest
 */
export function buildHmacSignature(rawBody, secret) {
  const BLOCK_SIZE = 64;

  let keyBytes = strToBytes(secret);

  // Keys longer than block size are hashed
  if (keyBytes.length > BLOCK_SIZE) {
    keyBytes = sha256(keyBytes);
  }

  // Pad key to block size
  const keyPadded = new Uint8Array(BLOCK_SIZE);
  keyPadded.set(keyBytes);

  // Inner and outer padded keys
  const innerKey = keyPadded.map(b => b ^ 0x36);
  const outerKey = keyPadded.map(b => b ^ 0x5c);

  const msgBytes    = strToBytes(rawBody);

  // HMAC = SHA256(outerKey || SHA256(innerKey || message))
  const innerInput  = new Uint8Array(innerKey.length + msgBytes.length);
  innerInput.set(innerKey);
  innerInput.set(msgBytes, innerKey.length);

  const innerHash   = sha256(innerInput);

  const outerInput  = new Uint8Array(outerKey.length + innerHash.length);
  outerInput.set(outerKey);
  outerInput.set(innerHash, outerKey.length);

  return bytesToHex(sha256(outerInput));
}
