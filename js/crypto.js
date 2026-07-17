// js/crypto.js — passphrase-based encryption of the roads library so the file
// committed to the (public) GitHub repo is unreadable gibberish without the
// passphrase. AES-256-GCM with a PBKDF2-derived key. Uses Web Crypto, which is
// available both in browsers and in Node 18+ (global `crypto`).

const enc = new TextEncoder();
const dec = new TextDecoder();
const PBKDF2_ITERATIONS = 150000;

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64ToBytes(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

async function deriveKey(passphrase, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
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
export async function encryptData(dataObj, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(dataObj)));
  return { tougemap_encrypted: 1, salt: bufToB64(salt), iv: bufToB64(iv), ct: bufToB64(ct) };
}

// Decrypt an envelope back to the plain data object. Throws on the wrong
// passphrase (AES-GCM authentication fails), which the caller turns into a
// "wrong passphrase" prompt.
export async function decryptData(envelope, passphrase) {
  const salt = b64ToBytes(envelope.salt);
  const iv = b64ToBytes(envelope.iv);
  const key = await deriveKey(passphrase, salt);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64ToBytes(envelope.ct));
  return JSON.parse(dec.decode(pt));
}
