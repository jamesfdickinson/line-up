const CACHE = "coachjd-vite-v96";
const ROOT = new URL("./", self.registration.scope).href;

self.addEventListener("install", event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  const response = await fetch(ROOT, { cache: "reload" });
  const html = await response.clone().text();
  await cache.put(ROOT, response);
  const assets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map(match => new URL(match[1], ROOT).href)
    .filter(url => new URL(url).origin === self.location.origin);
  await cache.addAll([...new Set(assets)]);
  await self.skipWaiting();
})()));

self.addEventListener("activate", event => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith("coachjd-") && key !== CACHE).map(key => caches.delete(key)));
  await self.clients.claim();
})()));

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (event.request.mode === "navigate") {
      try {
        const response = await fetch(event.request);
        await cache.put(ROOT, response.clone());
        return response;
      } catch {
        return cache.match(ROOT);
      }
    }
    const cached = await cache.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok && new URL(event.request.url).origin === self.location.origin) await cache.put(event.request, response.clone());
    return response;
  })());
});
