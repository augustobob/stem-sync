/* Stem Sync · service worker: guarda o app para funcionar offline.
   Rede primeiro (com revalidação) para tudo do app, então atualizações chegam na hora;
   sem rede, usa a cópia guardada. As stems NÃO passam por aqui (ficam no IndexedDB). */
const VERSION = "v2.0";
const CACHE = "stem-sync-" + VERSION;
const SHELL = [
  "./",
  "index.html",
  "css/app.css?v=2.0",
  "js/db.js?v=2.0",
  "js/tags.js?v=2.0",
  "js/engine.js?v=2.0",
  "js/app.js?v=2.0",
  "js/stem-processor.js?v=" + VERSION,
  "manifest.webmanifest"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.indexOf("stem-sync-") === 0 && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const isNav = req.mode === "navigate";
  const isCheck = url.searchParams.has("nc");
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const net = fetch(req, { cache: isCheck ? "no-store" : "no-cache" });
    try {
      const res = await Promise.race([net, timeout(isNav ? 4000 : 8000)]);
      if (res && res.ok && !isCheck) cache.put(isNav ? "index.html" : req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      if (isCheck) return new Response("", { status: 504 });
      const hit = (isNav && (await cache.match("index.html"))) || (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true })) || (isNav && (await cache.match("./")));
      if (hit) return hit;
      return net; // sem cópia guardada: espera a rede mesmo
    }
  })());
});
