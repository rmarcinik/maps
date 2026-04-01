const CACHE = 'map-tiles-v1';

const ORIGINS = [
  'https://tiles.openfreemap.org',
  'https://fonts.openmaptiles.org',
];

self.addEventListener('fetch', event => {
  if (!ORIGINS.some(o => event.request.url.startsWith(o))) return;

  event.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        });
      })
    )
  );
});
