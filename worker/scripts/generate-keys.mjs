// Makes the two secrets the reminder server needs. Run once: `node scripts/generate-keys.mjs`
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
const apiKey = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
console.log("VAPID_PRIVATE_JWK (paste when `npx wrangler secret put VAPID_PRIVATE_JWK` asks):");
console.log(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y }));
console.log("\nAPI_KEY (paste when `npx wrangler secret put API_KEY` asks, and into Karen's List once on each device):");
console.log(apiKey);
