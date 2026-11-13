// Fish Tracker service worker: makes the app installable and lets it open without a connection.
// The page itself is fetched fresh when online (so updates arrive immediately); libraries are cached.
const CACHE = "ft-shell-v10";
const SHELL = ["./", "./index.html", "./adapter.js", "./manifest.json", "./icons/icon-192.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co")) return;                       // never cache lab data here
  const isLib = url.hostname === "cdn.jsdelivr.net" || url.hostname.endsWith("gstatic.com") || url.hostname.endsWith("googleapis.com");
  if (isLib){ e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; }))); return; }
  if (url.origin === location.origin){
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; }).catch(() => caches.match(req).then(hit => hit || caches.match("./index.html"))));
  }
});

// Weekly summary notifications
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Fish Tracker", { body: d.body || "", icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { url: d.url || "./" } }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => { for (const c of list) { if ("focus" in c) return c.focus(); } return clients.openWindow(url); }));
});
