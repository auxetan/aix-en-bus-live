// Service Worker — Aix en Bus Live PWA
const CACHE_NAME = 'aix-bus-v1';
const STATIC_ASSETS = [
  './',
  './index.html',
  'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js',
  'https://unpkg.com/papaparse@5.4.1/papaparse.min.js'
];

// Install: cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Caching static assets');
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy: Network first for API/GTFS, Cache first for static
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // GTFS data and CORS proxies: network first, cache as fallback
  if (url.href.includes('transport.data.gouv.fr') ||
      url.href.includes('corsproxy.io') ||
      url.href.includes('allorigins.win') ||
      url.href.includes('codetabs.com') ||
      url.href.includes('cors.sh') ||
      url.href.includes('nominatim.openstreetmap.org') ||
      url.href.includes('router.project-osrm.org') ||
      url.href.includes('formsubmit.co') ||
      url.href.includes('emailjs.com') ||
      url.href.includes('cdn.jsdelivr.net/npm/@emailjs')) {
    // Don't cache API requests — let the app handle its own IndexedDB caching
    return;
  }

  // Map tiles: cache first with network fallback (long-lived cache)
  if (url.href.includes('basemaps.cartocdn.com') ||
      url.href.includes('tile.openstreetmap.org')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => new Response('', { status: 408 }));
      })
    );
    return;
  }

  // Static assets & fonts: stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then(cached => {
      const fetchPromise = fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback
        if (cached) return cached;
        // If requesting the main page, return cached index
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return new Response('Offline', { status: 503 });
      });

      return cached || fetchPromise;
    })
  );
});
