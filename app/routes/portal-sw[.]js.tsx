// Minimal service worker for the installable team portal: network-first, so
// bookings are always live, with an offline note when there's no connection.
const SW = `
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(
    fetch(e.request).catch(() =>
      new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:40px;text-align:center;color:#201f3d"><h2>You are offline</h2><p>Connect to the internet to see your bookings.</p></body>', { headers: { "Content-Type": "text/html" } })
    )
  );
});`;

export const loader = () =>
  new Response(SW, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Service-Worker-Allowed": "/portal/", "Cache-Control": "no-cache" } });
