// ══════════════════════════════════════════════════════════════════════════════
//  DAVINCII QUADRAX — SERVICE WORKER
//  Cache-first for app shell, network-first for live data
//  Bump CACHE_VERSION on every deploy to force update
// ══════════════════════════════════════════════════════════════════════════════

const CACHE_VERSION = 'qx-v42';
const SHELL_CACHE  = `${CACHE_VERSION}-shell`;
const FONT_CACHE   = `${CACHE_VERSION}-fonts`;

// ── App shell — cached on install ────────────────────────────────────────────
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// ── Domains that should ALWAYS hit network (live data, auth) ─────────────────
const NETWORK_ONLY = [
  'firestore.googleapis.com',
  'firebaseio.com',
  'firebase.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'api.tradingeconomics.com',
  'trading-economics',
  'newsapi.org',
  'frankfurter.app',
  'api.exchangerate',
  'open.er-api.com',
  'cdn.jsdelivr.net/npm/firebase',
  'www.gstatic.com/firebasejs'
];

// ── Cacheable font domains ───────────────────────────────────────────────────
const FONT_DOMAINS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

// ══════════════════════════════════════════════════════════════════════════════
//  INSTALL — pre-cache app shell
// ══════════════════════════════════════════════════════════════════════════════
self.addEventListener('install', event => {
  console.log(`[SW] Installing ${CACHE_VERSION}`);
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()) // activate immediately
  );
});

// ══════════════════════════════════════════════════════════════════════════════
//  ACTIVATE — clean old caches
// ══════════════════════════════════════════════════════════════════════════════
self.addEventListener('activate', event => {
  console.log(`[SW] Activating ${CACHE_VERSION}`);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== SHELL_CACHE && k !== FONT_CACHE)
          .map(k => {
            console.log(`[SW] Purging old cache: ${k}`);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim()) // take control of all tabs
  );
});

// ══════════════════════════════════════════════════════════════════════════════
//  FETCH — routing strategy
// ══════════════════════════════════════════════════════════════════════════════
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET requests (Firebase auth POST, etc.)
  if (event.request.method !== 'GET') return;

  // Skip chrome-extension, blob, etc.
  if (!url.protocol.startsWith('http')) return;

  // ── Network-only: live data & auth ──
  if (NETWORK_ONLY.some(d => url.hostname.includes(d) || url.href.includes(d))) {
    return; // let browser handle normally — no caching
  }

  // ── Cache-first: Google Fonts (rarely change) ──
  if (FONT_DOMAINS.some(d => url.hostname.includes(d))) {
    event.respondWith(
      caches.open(FONT_CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(response => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          });
        })
      )
    );
    return;
  }

  // ── Stale-while-revalidate: app shell ──
  // Serve from cache immediately, then update cache in background
  event.respondWith(
    caches.open(SHELL_CACHE).then(cache =>
      cache.match(event.request).then(cached => {
        const fetchPromise = fetch(event.request).then(response => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        }).catch(() => cached); // offline fallback

        return cached || fetchPromise;
      })
    )
  );
});

// ══════════════════════════════════════════════════════════════════════════════
//  NOTIFICATIONS — ready for future Firestore-triggered alerts
// ══════════════════════════════════════════════════════════════════════════════
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Focus existing QuadraX tab or open new one
      for (const client of clients) {
        if (client.url.includes('index.html') && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow('./index.html');
    })
  );
});

// Message handler — allows main app to trigger SW actions
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
  if (event.data === 'clearCache') {
    caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
  }
});
