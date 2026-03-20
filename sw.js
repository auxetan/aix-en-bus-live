// Service Worker — Aix en Bus Live PWA v5
const CACHE_NAME = 'aix-bus-v5';
const TILES_CACHE = 'aix-tiles-v1';
const GTFS_CACHE = 'aix-gtfs-offline-v1';
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
      console.log('[SW v5] Caching static assets');
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
  const keepCaches = [CACHE_NAME, TILES_CACHE];
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => !keepCaches.includes(k))
          .map(k => { console.log('[SW] Deleting old cache:', k); return caches.delete(k); })
      )
    ).then(() => self.clients.claim())
  );
});

// Helper: is this a map tile request?
function isTileRequest(url) {
  return TILE_HOSTS.some(h => url.hostname.includes(h));
}

// Helper: trim tile cache to max size (LRU)
async function trimTileCache() {
  const cache = await caches.open(TILES_CACHE);
  const keys = await cache.keys();
  if (keys.length > MAX_TILE_CACHE) {
    const toDelete = keys.slice(0, keys.length - MAX_TILE_CACHE);
    await Promise.all(toDelete.map(k => cache.delete(k)));
  }
}

// ═══════════════════════════════════════════
// BACKGROUND SYNC — refresh GTFS when back online
// ═══════════════════════════════════════════
self.addEventListener('sync', event => {
  if (event.tag === 'gtfs-refresh') {
    console.log('[SW] Background sync: refreshing GTFS');
    event.waitUntil(notifyClientsToRefresh());
  }
});

// Periodic Background Sync (if supported) — every 6 hours
self.addEventListener('periodicsync', event => {
  if (event.tag === 'gtfs-periodic-refresh') {
    console.log('[SW] Periodic sync: refreshing GTFS');
    event.waitUntil(notifyClientsToRefresh());
  }
});

// Notify all clients to refresh their GTFS data
async function notifyClientsToRefresh() {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) {
    client.postMessage({ type: 'GTFS_REFRESH_NEEDED' });
  }
}

// ═══════════════════════════════════════════
// MESSAGE HANDLER — communication with main thread
// ═══════════════════════════════════════════
self.addEventListener('message', event => {
  const { type, data } = event.data || {};

  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  // Store GTFS schedule data for offline use
  if (type === 'CACHE_GTFS_SCHEDULES') {
    event.waitUntil(
      caches.open(GTFS_CACHE).then(cache => {
        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        const response = new Response(blob, {
          headers: { 'Content-Type': 'application/json', 'X-Cached-At': new Date().toISOString() }
        });
        return cache.put('gtfs-schedules', response);
      }).then(() => console.log('[SW] GTFS schedules cached for offline use'))
        .catch(err => console.warn('[SW] Failed to cache GTFS schedules:', err))
    );
  }

  // Request cached GTFS schedules
  if (type === 'GET_GTFS_SCHEDULES') {
    event.waitUntil(
      caches.open(GTFS_CACHE).then(cache => cache.match('gtfs-schedules'))
        .then(response => response ? response.json() : null)
        .then(schedules => {
          event.source.postMessage({ type: 'GTFS_SCHEDULES_RESULT', data: schedules });
        })
        .catch(() => {
          event.source.postMessage({ type: 'GTFS_SCHEDULES_RESULT', data: null });
        })
    );
  }
});

// ═══════════════════════════════════════════
// FETCH STRATEGY
// ═══════════════════════════════════════════
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

  // Same-origin navigation: network first, cache fallback with offline page
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match('./index.html').then(r => r || new Response(
        `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aix en Bus — Hors ligne</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:linear-gradient(135deg,#F47920,#E8691A);color:white;text-align:center;padding:24px}h1{font-size:22px;margin-bottom:12px;font-weight:800}p{opacity:.85;font-size:15px;line-height:1.5;margin-bottom:20px}button{padding:14px 28px;border:none;border-radius:14px;background:white;color:#F47920;font-weight:800;font-size:16px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.15);transition:transform .15s}button:hover{transform:translateY(-2px)}.icon{width:64px;height:64px;margin-bottom:20px;opacity:.9}</style></head><body><div><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5"><path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.56 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/></svg><h1>Pas de connexion</h1><p>Les horaires en cache seront affichés dès que possible.<br>Vérifie ta connexion et réessaie.</p><button onclick="location.reload()">Réessayer</button></div></body></html>`,
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      )))
    );
    return;
  }

  // Same-origin: stale-while-revalidate
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
