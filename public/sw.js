// public/sw.js

const CACHE_NAME = "sulama-asistani-v2";
const OFFLINE_URLS = [
  "/",              // ana sayfa
  "/index.html",
  "/manifest.json"
  // İstersen css/js dosyalarını da buraya ekleriz
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(OFFLINE_URLS);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Basit cache-first stratejisi
self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Sadece GET isteklerini cache’le
  if (request.method !== "GET") return;

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request)
        .then((networkResponse) => {
          // Response geçerliyse cache'e koy
          if (
            !networkResponse ||
            networkResponse.status !== 200 ||
            networkResponse.type === "opaque"
          ) {
            return networkResponse;
          }

          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          });

          return networkResponse;
        })
        .catch(() => {
          // İnternet yoksa ve cache’de de yoksa, istersen
          // burada bir offline sayfası dönebiliriz.
          return caches.match("/");
        });
    })
  );
});
