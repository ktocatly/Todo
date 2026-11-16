// Karen's List reminder server (Cloudflare Worker + D1).
// Stores the to-do list for the page, and once a minute sends a push notification
// for every to-do whose reminder is due. Daily reminders repeat until checked off.

import { sendPush, vapidKeys } from "./webpush.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...CORS } });
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function authorized(req, env) {
  const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const want = env.API_KEY || "";
  if (!want || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

function cleanTask(id, t) {
  if (!t || typeof t !== "object" || t.id !== id) return null;
  if (typeof t.text !== "string" || !t.text.trim() || t.text.length > 500) return null;
  const due = t.done ? null : (Number.isFinite(t.due) ? Math.round(t.due) : null);
  return { ...t, due, done: !!t.done };
}

/** Next time the clock in `tz` reads hh:mm, strictly after `after` (ms). Handles daylight-saving changes. */
export function nextDaily(hhmm, tz, after) {
  const [h, m] = String(hhmm).split(":").map(Number);
  let fmt;
  try { fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }); }
  catch { fmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }); }
  const parts = ms => Object.fromEntries(fmt.formatToParts(new Date(ms)).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
  const offset = ms => { const p = parts(ms); return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000; };
  const today = parts(after);
  for (let k = 0; k <= 2; k++) {
    const wall = Date.UTC(today.year, today.month - 1, today.day + k, h, m);
    let utc = wall - offset(wall);
    utc = wall - offset(utc);
    if (utc > after) return utc;
  }
  return after + 864e5;
}

async function allSubscriptions(env) {
  const { results } = await env.DB.prepare("SELECT endpoint, data FROM subscriptions").all();
  return results.map(r => JSON.parse(r.data));
}

async function notifyAll(env, data, topic) {
  const subs = await allSubscriptions(env);
  if (!subs.length || !env.VAPID_PRIVATE_JWK) return { sent: 0, failed: 0, devices: subs.length };
  const keys = await vapidKeys(env.VAPID_PRIVATE_JWK);
  const subject = env.VAPID_SUBJECT || "https://ktocatly.github.io/Todo/";
  let sent = 0, failed = 0;
  await Promise.all(subs.map(async sub => {
    try {
      const status = await sendPush(sub, data, keys, subject, { topic });
      if (status >= 200 && status < 300) sent++;
      else {
        failed++;
        if (status === 404 || status === 410) await env.DB.prepare("DELETE FROM subscriptions WHERE endpoint = ?").bind(sub.endpoint).run();
      }
    } catch { failed++; }
  }));
  return { sent, failed, devices: subs.length };
}

/** Send every reminder that is due, then move each one to its next time. */
export async function runDue(env, now = Date.now()) {
  const { results } = await env.DB.prepare("SELECT id, data, due FROM tasks WHERE done = 0 AND due IS NOT NULL AND due <= ?").bind(now).all();
  for (const row of results) {
    const t = JSON.parse(row.data);
    const daily = t.remind && t.remind.mode === "daily";
    await notifyAll(env, { title: "Karen's List", body: t.text, id: t.id, daily }, t.id);
    const next = { ...t, snoozed: false, lastFired: now, due: daily ? nextDaily(t.remind.time, t.remind.tz, now) : null };
    // Only move it on if the page hasn't changed this to-do in the meantime.
    await env.DB.prepare("UPDATE tasks SET data = ?, due = ?, updated_at = ? WHERE id = ? AND due = ?")
      .bind(JSON.stringify(next), next.due, now, t.id, row.due).run();
  }
  return results.length;
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "");
    try {
      if (path === "" || path === "/api/health") return json({ ok: true, name: "Karen's List reminders" });
      if (path === "/api/vapid" && req.method === "GET") {
        if (!env.VAPID_PRIVATE_JWK) return json({ error: "Notifications aren't set up on the server yet." }, 503);
        return json({ publicKey: (await vapidKeys(env.VAPID_PRIVATE_JWK)).publicKey });
      }
      if (!authorized(req, env)) return json({ error: "That key isn't right." }, 401);

      if (path === "/api/tasks" && req.method === "GET") {
        const { results } = await env.DB.prepare("SELECT data FROM tasks").all();
        return json({ tasks: results.map(r => JSON.parse(r.data)) });
      }
      const m = path.match(/^\/api\/tasks\/([^/]+)$/);
      if (m && req.method === "PUT") {
        const id = decodeURIComponent(m[1]);
        if (!ID.test(id)) return json({ error: "Bad id." }, 400);
        const t = cleanTask(id, await req.json().catch(() => null));
        if (!t) return json({ error: "That to-do is missing its text." }, 400);
        await env.DB.prepare("INSERT OR REPLACE INTO tasks (id, data, due, done, updated_at) VALUES (?, ?, ?, ?, ?)")
          .bind(id, JSON.stringify(t), t.due, t.done ? 1 : 0, Date.now()).run();
        return json({ task: t });
      }
      if (m && req.method === "DELETE") {
        await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(decodeURIComponent(m[1])).run();
        return json({ ok: true });
      }
      if (path === "/api/subscribe" && req.method === "POST") {
        const sub = await req.json().catch(() => null);
        if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth)
          return json({ error: "That isn't a push subscription." }, 400);
        const clean = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
        await env.DB.prepare("INSERT OR REPLACE INTO subscriptions (endpoint, data, created_at) VALUES (?, ?, ?)")
          .bind(clean.endpoint, JSON.stringify(clean), Date.now()).run();
        return json({ ok: true });
      }
      if (path === "/api/unsubscribe" && req.method === "POST") {
        const sub = await req.json().catch(() => null);
        if (sub && sub.endpoint) await env.DB.prepare("DELETE FROM subscriptions WHERE endpoint = ?").bind(sub.endpoint).run();
        return json({ ok: true });
      }
      if (path === "/api/test" && req.method === "POST") {
        const r = await notifyAll(env, { title: "Karen's List", body: "Notifications are working. Frosty says hi!", id: "test" }, "test");
        return json(r);
      }
      return json({ error: "Not found." }, 404);
    } catch (e) {
      return json({ error: "Something went wrong on the server." }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDue(env, Date.now()));
  },
};
