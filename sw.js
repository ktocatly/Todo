// Karen's List service worker: shows reminder notifications pushed by the reminder server.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

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
