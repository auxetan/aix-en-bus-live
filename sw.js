// Service Worker — Aix en Bus Live PWA v4
const CACHE_NAME = 'aix-bus-v4';
const TILES_CACHE = 'aix-tiles-v1';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

const TILE_HOSTS = [
  'basemaps.cartocdn.com',
  'tile.openstreetmap.org'
];
const MAX_TILE_CACHE = 600;

// Install: cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Caching static assets');
      return Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(err => console.warn('[SW] Failed to cache:', url, err.message))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME && k !== TILES_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Helper: is this a map tile request?
function isTileRequest(url) {
  return TILE_HOSTS.some(h => url.hostname.includes(h));
}

// Helper: trim tile cache to max size
async function trimTileCache() {
  const cache = await caches.open(TILES_CACHE);
  const keys = await cache.keys();
  if (keys.length > MAX_TILE_CACHE) {
    const toDelete = keys.slice(0, keys.length - MAX_TILE_CACHE);
    await Promise.all(toDelete.map(k => cache.delete(k)));
  }
}

// Fetch strategy
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Map tiles: cache-first with network fallback, separate cache
  if (isTileRequest(url)) {
    event.respondWith(
      caches.open(TILES_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(response => {
            if (response.ok) {
              cache.put(event.request, response.clone());
              trimTileCache();
            }
            return response;
          }).catch(() => new Response('', { status: 408 }));
        })
      )
    );
    return;
  }

  // CDN libraries (fonts, leaflet, etc): cache-first
  if (url.origin !== self.location.origin &&
      (url.hostname.includes('fonts.googleapis.com') ||
       url.hostname.includes('fonts.gstatic.com') ||
       url.hostname.includes('unpkg.com') ||
       url.hostname.includes('cdnjs.cloudflare.com'))) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(response => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          }).catch(() => cached || new Response('', { status: 503 }));
        })
      )
    );
    return;
  }

  // Other cross-origin (GTFS proxies, APIs): network only
  if (url.origin !== self.location.origin) return;

  // Same-origin navigation: network first, cache fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match('./index.html').then(r => r || new Response(
        '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aix en Bus — Hors ligne</title></head><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#F47920;color:white;text-align:center;padding:20px"><div><h1 style="font-size:24px;margin-bottom:12px">Pas de connexion</h1><p style="opacity:.8">Vérifie ta connexion et recharge la page.</p><button onclick="location.reload()" style="margin-top:20px;padding:12px 24px;border:none;border-radius:12px;background:white;color:#F47920;font-weight:bold;font-size:16px;cursor:pointer">Réessayer</button></div></body></html>',
        { status: 503, headers: { 'Content-Type': 'text/html' } }
      )))
    );
    return;
  }

  // Same-origin static: stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then(cached => {
      const fetchPromise = fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached || new Response('Offline', { status: 503 }));

      return cached || fetchPromise;
    })
  );
});
