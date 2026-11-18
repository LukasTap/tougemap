// js/crypto.js — passphrase-based encryption of the roads library so the file
// committed to the (public) GitHub repo is unreadable without the passphrase.
// AES-256-GCM with a PBKDF2-derived key. Uses Web Crypto + CompressionStream,
// both available in browsers and in Node 20+ (globals).
//
// Envelope fields:
//   tougemap_encrypted: 1     marks the file as encrypted
//   salt, iv, ct              base64
//   iter                      PBKDF2 iterations (absent = 150000, the original value)
//   z: 'gzip'                 plaintext was gzipped before encryption (absent = raw JSON)
// Old envelopes (no iter, no z) still decrypt; new ones are always written with both.

const enc = new TextEncoder();
const dec = new TextDecoder();
export const LEGACY_ITERATIONS = 150000;
// OWASP's current figure for PBKDF2-HMAC-SHA256. The ciphertext and its whole
// history are public, so offline guessing is the threat this slows down.
export const PBKDF2_ITERATIONS = 600000;

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBytes(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

async function pipeBytes(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
export const gzip = (bytes) => pipeBytes(bytes, new CompressionStream('gzip'));
export const gunzip = (bytes) => pipeBytes(bytes, new DecompressionStream('gzip'));

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Is this parsed JSON an encrypted envelope (vs a plaintext v2 roads object)?
export function isEncrypted(obj) {
  return !!obj && obj.tougemap_encrypted === 1 &&
    typeof obj.salt === 'string' && typeof obj.iv === 'string' && typeof obj.ct === 'string';
}

// Encrypt a plain data object → an envelope safe to commit to a public repo.
// Gzipped first: road geometry compresses ~6×, which keeps the file well under
// the GitHub API's 1 MB comfort zone.
export async function encryptData(dataObj, passphrase, { iterations = PBKDF2_ITERATIONS } = {}) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const packed = await gzip(enc.encode(JSON.stringify(dataObj)));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, packed);
  return { tougemap_encrypted: 1, iter: iterations, z: 'gzip', salt: bufToB64(salt), iv: bufToB64(iv), ct: bufToB64(ct) };
}

// Decrypt an envelope back to the plain data object. Throws on the wrong
// passphrase (AES-GCM authentication fails), which the caller turns into a
// "wrong passphrase" prompt.
export async function decryptData(envelope, passphrase) {
  const salt = b64ToBytes(envelope.salt);
  const iv = b64ToBytes(envelope.iv);
  const key = await deriveKey(passphrase, salt, envelope.iter || LEGACY_ITERATIONS);
  let pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64ToBytes(envelope.ct)));
  if (envelope.z === 'gzip') pt = await gunzip(pt);
  return JSON.parse(dec.decode(pt));
}
