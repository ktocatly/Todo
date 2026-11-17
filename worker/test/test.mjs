// Tests for the reminder server. Run with `node test/test.mjs` (Node 22+).
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker, { nextDaily, nextRepeat, runDue } from "../src/index.js";
import { encryptPayload, unb64u, b64u } from "../src/webpush.js";

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

// A browser's side of a push subscription, made with node:crypto (independent of the code under test).
function fakeBrowser() {
  const ecdh = nodeCrypto.createECDH("prime256v1"); ecdh.generateKeys();
  const auth = nodeCrypto.randomBytes(16);
  return {
    sub: { endpoint: "https://web.push.apple.com/QTest" + nodeCrypto.randomBytes(4).toString("hex"), keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } },
    decrypt(body) { // RFC 8291 decryption, written against node:crypto
      body = Buffer.from(body);
      const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
      assert.equal(rs, 4096);
      const shared = ecdh.computeSecret(asPub);
      const info = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPub]);
      const ikm = Buffer.from(nodeCrypto.hkdfSync("sha256", shared, auth, info, 32));
      const cek = Buffer.from(nodeCrypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
      const nonce = Buffer.from(nodeCrypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
      const d = nodeCrypto.createDecipheriv("aes-128-gcm", cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
      const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      assert.equal(pt[pt.length - 1], 2, "last-record delimiter");
      return JSON.parse(pt.subarray(0, pt.length - 1).toString());
    },
  };
}

// D1 stand-in backed by SQLite.
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
  });
  return { prepare: sql => stmt(sql) };
}

const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
const env = { DB: fakeD1(), API_KEY: "test-key-123", VAPID_PRIVATE_JWK: JSON.stringify(jwk), VAPID_SUBJECT: "https://ktocatly.github.io/Todo/" };
const call = (method, path, body, key = env.API_KEY) => worker.fetch(new Request("https://w.example" + path, {
  method, headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
}), env);

// Capture outgoing pushes.
const sent = [];
let pushStatus = 201;
globalThis.fetch = async (url, init) => { sent.push({ url, init }); return new Response(null, { status: pushStatus }); };

await test("payload encryption round-trips", async () => {
  const b = fakeBrowser();
  const body = await encryptPayload(JSON.stringify({ hello: "Frosty" }), b.sub.keys.p256dh, b.sub.keys.auth);
  assert.deepEqual(b.decrypt(body), { hello: "Frosty" });
});

await test("daily times follow the local clock across daylight saving", () => {
  const ny = "America/New_York";
  assert.equal(new Date(nextDaily("09:00", ny, Date.parse("2026-11-16T15:00:00Z"))).toISOString(), "2026-11-17T14:00:00.000Z");
  assert.equal(new Date(nextDaily("09:00", ny, Date.parse("2026-11-16T13:00:00Z"))).toISOString(), "2026-11-16T14:00:00.000Z");
  assert.equal(new Date(nextDaily("09:00", ny, Date.parse("2026-03-07T15:00:00Z"))).toISOString(), "2026-03-08T13:00:00.000Z");
  assert.equal(new Date(nextDaily("09:00", ny, Date.parse("2026-10-31T14:00:00Z"))).toISOString(), "2026-11-01T14:00:00.000Z");
  assert.equal(new Date(nextDaily("23:30", "Asia/Kolkata", Date.parse("2026-11-16T18:30:00Z"))).toISOString(), "2026-11-17T18:00:00.000Z");
});

await test("weekly and monthly times land on the right local day", () => {
  const ny = "America/New_York", iso = ms => new Date(ms).toISOString();
  // Tue 17 Nov 2026, 10:00 New York. Every Friday 9:00 -> Fri 20 Nov 14:00Z
  const tue = Date.parse("2026-11-17T15:00:00Z");
  assert.equal(iso(nextRepeat({ every: "week", weekday: 5, time: "09:00" }, ny, tue)), "2026-11-20T14:00:00.000Z");
  // Every Tuesday 9:00, already past today -> next Tuesday
  assert.equal(iso(nextRepeat({ every: "week", weekday: 2, time: "09:00" }, ny, tue)), "2026-11-24T14:00:00.000Z");
  // Every Tuesday 11:00, still ahead today -> today
  assert.equal(iso(nextRepeat({ every: "week", weekday: 2, time: "11:00" }, ny, tue)), "2026-11-17T16:00:00.000Z");
  // Monthly on the 1st 8:00 -> 1 Dec
  assert.equal(iso(nextRepeat({ every: "month", monthday: 1, time: "08:00" }, ny, tue)), "2026-12-01T13:00:00.000Z");
  // Monthly on the 31st -> 30 Nov (last day), then 31 Dec
  assert.equal(iso(nextRepeat({ every: "month", monthday: 31, time: "09:00" }, ny, tue)), "2026-11-30T14:00:00.000Z");
  assert.equal(iso(nextRepeat({ every: "month", monthday: 31, time: "09:00" }, ny, Date.parse("2026-11-30T14:00:00Z"))), "2026-12-31T14:00:00.000Z");
  // February in a non-leap year -> 28th
  assert.equal(iso(nextRepeat({ every: "month", monthday: 30, time: "09:00" }, ny, Date.parse("2027-02-01T00:00:00Z"))), "2027-02-28T14:00:00.000Z");
  // Weekly across the March DST change keeps 9:00 local
  assert.equal(iso(nextRepeat({ every: "week", weekday: 1, time: "09:00" }, ny, Date.parse("2027-03-09T15:00:00Z"))), "2027-03-15T13:00:00.000Z");
});

await test("wrong key is refused", async () => {
  assert.equal((await call("GET", "/api/tasks", null, "nope")).status, 401);
  assert.equal((await call("GET", "/api/vapid", null, "nope")).status, 200);
});

const phone = fakeBrowser();
await test("a device can subscribe", async () => {
  assert.equal((await call("POST", "/api/subscribe", phone.sub)).status, 200);
});

await test("due reminders are sent, signed and moved on", async () => {
  const now = Date.parse("2026-11-16T14:00:30Z");
  await call("PUT", "/api/tasks/t1", { id: "t1", text: "Call the vet", done: false, createdAt: 1, remind: { mode: "daily", time: "09:00", tz: "America/New_York" }, due: now - 30000 });
  await call("PUT", "/api/tasks/t2", { id: "t2", text: "Dry cleaning", done: false, createdAt: 2, remind: { mode: "once", at: now - 1000 }, due: now - 1000 });
  await call("PUT", "/api/tasks/t3", { id: "t3", text: "Later", done: false, createdAt: 3, remind: { mode: "once", at: now + 3600e3 }, due: now + 3600e3 });
  await call("PUT", "/api/tasks/t4", { id: "t4", text: "Already done", done: true, createdAt: 4, remind: { mode: "once", at: now - 1000 }, due: now - 1000 });
  sent.length = 0;
  assert.equal(await runDue(env, now), 2);
  assert.equal(sent.length, 2);
  const bodies = sent.map(s => phone.decrypt(s.init.body)).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(bodies.map(b => [b.id, b.body]), [["t1", "Call the vet"], ["t2", "Dry cleaning"]]);
  const h = sent[0].init.headers;
  assert.equal(h["Content-Encoding"], "aes128gcm");
  // VAPID: verify the JWT signature with node:crypto against the advertised public key.
  const [, t, k] = h.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  const [hd, cl, sig] = t.split(".");
  const claims = JSON.parse(Buffer.from(cl, "base64url"));
  assert.equal(claims.aud, "https://web.push.apple.com");
  assert.equal(claims.sub, "https://ktocatly.github.io/Todo/");
  const pub = nodeCrypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(unb64u(k).slice(1, 33)), y: b64u(unb64u(k).slice(33)) }, format: "jwk" });
  assert.ok(nodeCrypto.verify("sha256", Buffer.from(hd + "." + cl), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")));
  assert.equal(k, (await (await call("GET", "/api/vapid")).json()).publicKey);

  const tasks = Object.fromEntries((await (await call("GET", "/api/tasks")).json()).tasks.map(t => [t.id, t]));
  assert.equal(new Date(tasks.t1.due).toISOString(), "2026-11-17T14:00:00.000Z", "daily moves to tomorrow 9am");
  assert.equal(tasks.t2.due, null, "one-time reminder is used up");
  assert.equal(tasks.t3.due, now + 3600e3, "future reminder untouched");
  sent.length = 0;
  assert.equal(await runDue(env, now + 1000), 0, "nothing sent twice");
});

await test("checking off stops a daily reminder", async () => {
  const now = Date.parse("2026-11-17T14:00:10Z");
  const t1 = (await (await call("GET", "/api/tasks")).json()).tasks.find(t => t.id === "t1");
  await call("PUT", "/api/tasks/t1", { ...t1, done: true, doneAt: now - 5000 });
  sent.length = 0;
  await runDue(env, now);
  assert.ok(!sent.map(s => phone.decrypt(s.init.body).id).includes("t1"), "no reminder for a checked-off to-do");
});

await test("a repeating to-do comes back after being checked off", async () => {
  const now = Date.parse("2026-11-20T14:00:20Z"); // Friday 9:00 New York
  const r = { mode: "repeat", every: "week", weekday: 5, time: "09:00", tz: "America/New_York" };
  // checked off earlier in the week; the page kept its next time (this Friday 9:00)
  await call("PUT", "/api/tasks/r1", { id: "r1", text: "Take out recycling", done: true, doneAt: now - 3 * 864e5, createdAt: 9, remind: r, due: now - 20000 });
  const saved = (await (await call("GET", "/api/tasks")).json()).tasks.find(t => t.id === "r1");
  assert.equal(saved.due, now - 20000, "a checked-off repeating to-do keeps its next time");
  sent.length = 0;
  await runDue(env, now);
  assert.ok(sent.map(s => phone.decrypt(s.init.body)).some(b => b.id === "r1" && b.body === "Take out recycling"), "reminder sent");
  const back = (await (await call("GET", "/api/tasks")).json()).tasks.find(t => t.id === "r1");
  assert.equal(back.done, false, "it is back on the list");
  assert.equal(new Date(back.due).toISOString(), "2026-11-27T14:00:00.000Z", "next Friday 9:00");
  // ignoring it doesn't stop next week's reminder
  sent.length = 0;
  await runDue(env, Date.parse("2026-11-27T14:00:10Z"));
  assert.ok(sent.map(s => phone.decrypt(s.init.body)).some(b => b.id === "r1"));
});

await test("expired devices are forgotten", async () => {
  pushStatus = 410;
  const r = await (await call("POST", "/api/test")).json();
  assert.deepEqual([r.sent, r.failed], [0, 1]);
  pushStatus = 201;
  const r2 = await (await call("POST", "/api/test")).json();
  assert.equal(r2.devices, 0);
});

await test("bad input is refused", async () => {
  assert.equal((await call("PUT", "/api/tasks/x1", { id: "x1", text: "" })).status, 400);
  assert.equal((await call("PUT", "/api/tasks/x1", { id: "other", text: "hi" })).status, 400);
  assert.equal((await call("POST", "/api/subscribe", { endpoint: "http://insecure" })).status, 400);
});

console.log(`\n${passed} passed`);
