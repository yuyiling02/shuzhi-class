const CACHE_PREFIX = 'huishi-public-assets-';
const CACHE_NAME = `${CACHE_PREFIX}v2`;
const LEGACY_CACHE_PREFIX = '3d-assets-cache-';

const isManagedCache = (cacheName) => (
  cacheName.startsWith(CACHE_PREFIX) || cacheName.startsWith(LEGACY_CACHE_PREFIX)
);

const isPublicAssetRequest = (request, url) => {
  if (request.method !== 'GET' || request.headers.has('range')) return false;
  if (url.origin !== self.location.origin) return false;

  return url.pathname.startsWith('/models/')
    || url.pathname.startsWith('/mediapipe/')
    || url.pathname.startsWith('/draco/');
};

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (isManagedCache(name) && name !== CACHE_NAME) {
            console.log('[SW] 清理旧缓存:', name);
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!isPublicAssetRequest(event.request, url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(event.request);

    // Revalidate against the network in the background and refresh the cache
    // so model updates propagate without manual cache clearing. On a network
    // failure, fall back to the cached copy.
    const revalidate = () =>
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            event.waitUntil(cache.put(event.request, networkResponse.clone()));
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

    if (cachedResponse) {
      event.waitUntil(revalidate());
      return cachedResponse;
    }
    return revalidate();
  })());
});
