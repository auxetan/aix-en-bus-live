// Service Worker — Aix en Bus Live PWA v2
const CACHE_NAME = 'aix-bus-v2';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './routes-cache.js',
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

// Fetch strategy
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // API / dynamic data: network only, no caching
  if (url.href.includes('transport.data.gouv.fr') ||
      url.href.includes('corsproxy.io') ||
      url.href.includes('allorigins.win') ||
      url.href.includes('codetabs.com') ||
      url.href.includes('cors.sh') ||
      url.href.includes('nominatim.openstreetmap.org') ||
      url.href.includes('router.project-osrm.org') ||
      url.href.includes('routing.openstreetmap.de') ||
      url.href.includes('formsubmit.co') ||
      url.href.includes('emailjs.com') ||
      url.href.includes('cdn.jsdelivr.net/npm/@emailjs') ||
      url.href.includes('googletagmanager.com') ||
      url.href.includes('google-analytics.com')) {
    return;
  }

  // Map tiles: cache first with network fallback
  if (url.href.includes('basemaps.cartocdn.com') ||
      url.href.includes('tile.openstreetmap.org') ||
      url.href.includes('stadiamaps.com') ||
      url.href.includes('tiles.stadiamaps.com')) {
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
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return new Response('Offline', { status: 503 });
      });

      return cached || fetchPromise;
    })
  );
});
