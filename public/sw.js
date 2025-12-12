// public/sw.js
// Sulama Asistanı - Service Worker (safe cache strategy)
// - HTML (navigation) => NETWORK FIRST (eski index.html sorununu bitirir)
// - Static (css/js/img/fonts) => STALE-WHILE-REVALIDATE
// - API (/api/*) => NO CACHE

const CACHE_VERSION = "v4";
const STATIC_CACHE = `sulama-static-${CACHE_VERSION}`;

// İstersen buraya sadece gerçekten "sabit" dosyaları ekle.
// index.html'yi bilerek eklemiyoruz.
const PRECACHE_URLS = [
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
].filter(Boolean);

// --- Install: static precache ---
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

// --- Activate: eski cache'leri temizle ---
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("sulama-") && k !== STATIC_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Yardımcı: statik mi?
function isStaticAsset(request) {
  const url = new URL(request.url);
  const path = url.pathname.toLowerCase();

  // Aynı origin dışını cache’leme
  if (url.origin !== self.location.origin) return false;

  // API asla cache'lenmesin
  if (path.startsWith("/api/")) return false;

  // Statik uzantılar
  return (
    path.endsWith(".css") ||
    path.endsWith(".js") ||
    path.endsWith(".png") ||
    path.endsWith(".jpg") ||
    path.endsWith(".jpeg") ||
    path.endsWith(".webp") ||
    path.endsWith(".svg") ||
    path.endsWith(".gif") ||
    path.endsWith(".ico") ||
    path.endsWith(".woff") ||
    path.endsWith(".woff2") ||
    path.endsWith(".ttf") ||
    path.endsWith(".eot") ||
    path.endsWith(".json")
  );
}

// --- Fetch: stratejiler ---
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Sadece GET
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Aynı origin değilse karışma
  if (url.origin !== self.location.origin) return;

  // API: no cache
  if (url.pathname.startsWith("/api/")) {
    // İstersen burada offline için özel mesaj döndürebilirsin, şimdilik direkt network
    return;
  }

  // 1) HTML navigasyon: NETWORK FIRST
  // (index.html eski sürüm sorunu burada çözülüyor)
  if (req.mode === "navigate" || req.headers.get("accept")?.includes("text/html")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // İstersen son başarılı HTML'i ayrı cache’e koyabiliriz (offline fallback için),
          // ama şu an ana hedef: eski sürüm göstermeyi bitirmek.
          return res;
        })
        .catch(() => {
          // Offline ise root'u cache’te bulabilirsek göster (varsa)
          return caches.match("/").then((r) => r || new Response(
            "<h3>Offline</h3><p>İnternet bağlantısı yok. Lütfen tekrar deneyin.</p>",
            { headers: { "Content-Type": "text/html; charset=utf-8" } }
          ));
        })
    );
    return;
  }

  // 2) Statikler: STALE-WHILE-REVALIDATE
  if (isStaticAsset(req)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const networkFetch = fetch(req)
          .then((res) => {
            // başarılı response’u cache’e yaz
            if (res && res.status === 200 && res.type !== "opaque") {
              const copy = res.clone();
              caches.open(STATIC_CACHE).then((cache) => cache.put(req, copy));
            }
            return res;
          })
          .catch(() => cached); // network yoksa cache’i dön

        // cache varsa hemen dön, arkada güncelle
        return cached || networkFetch;
      })
    );
    return;
  }

  // 3) Diğer her şey: NETWORK FIRST (güvenli)
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});
