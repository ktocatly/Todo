// Web Push for Cloudflare Workers with no dependencies:
// VAPID signing (RFC 8292) and aes128gcm payload encryption (RFC 8291 / RFC 8188), using WebCrypto.

const enc = new TextEncoder();

export function b64u(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64u(str) {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** The VAPID key pair: the private key signs, the raw public key goes to browsers. */
export async function vapidKeys(privateJwkJson) {
  const jwk = typeof privateJwkJson === "string" ? JSON.parse(privateJwkJson) : privateJwkJson;
  const privateKey = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y, ext: true },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const publicKey = b64u(concat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y)));
  return { privateKey, publicKey };
}

async function vapidAuth(endpoint, keys, subject) {
  const header = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const unsigned = `${header}.${claims}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${keys.publicKey}`;
}

/** Encrypt a payload for one subscription (aes128gcm, a single record). */
export async function encryptPayload(payload, p256dh, auth) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plaintext = concat(typeof payload === "string" ? enc.encode(payload) : payload, new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext));

  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

/** Send one notification. Resolves with the push service's HTTP status (201 = accepted, 404/410 = gone). */
export async function sendPush(subscription, data, keys, subject, { topic, ttl = 86400 } = {}) {
  const body = await encryptPayload(JSON.stringify(data), subscription.keys.p256dh, subscription.keys.auth);
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Encoding": "aes128gcm",
    TTL: String(ttl),
    Urgency: "high",
    Authorization: await vapidAuth(subscription.endpoint, keys, subject),
  };
  if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const res = await fetch(subscription.endpoint, { method: "POST", headers, body });
  return res.status;
}
