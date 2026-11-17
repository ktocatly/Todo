// Karen's List service worker: shows reminder notifications pushed by the reminder server.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

// Always ask GitHub Pages whether a file changed before using a saved copy, so updates show up
// the next time the app is opened instead of up to 10 minutes later. Unchanged files still load
// from the saved copy, and the saved copy is used if there's no connection.
self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(fetch(req, { cache: "no-cache" }).catch(() => fetch(req)));
});

self.addEventListener("push", event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data && event.data.text() }; }
  event.waitUntil((async () => {
    await self.registration.showNotification(d.title || "Karen's List", {
      body: d.body || "You have a reminder.",
      tag: d.id || "karens-list",
      icon: "assets/icon-192.png",
      badge: "assets/icon-192.png",
      data: { id: d.id },
    });
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    windows.forEach(w => w.postMessage({ type: "reminder", id: d.id }));
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.id;
  const url = new URL(id && id !== "test" ? "./?reminder=" + encodeURIComponent(id) : "./", self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of windows) {
      if ("focus" in w) { w.postMessage({ type: "reminder", id }); return w.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
