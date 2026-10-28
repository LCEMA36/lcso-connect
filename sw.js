// LCSO Connect — background helper (service worker) v0.4
// Shows notifications when the app is closed and opens the right group on tap.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = { body: event.data && event.data.text() }; }
  const title = d.title || "LCSO Connect";
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || "New message",
    tag: d.tag || "lcso",
    renotify: true,
    requireInteraction: !!d.urgent,
    icon: "icon-192.png",
    badge: "icon-192.png",
    data: { url: d.url || "./" },
    vibrate: d.urgent ? [300, 120, 300, 120, 300] : [150],
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "./", self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        w.postMessage({ type: "open", url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
