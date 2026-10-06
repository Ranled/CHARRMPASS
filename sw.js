// ====================================================================
// CHARRMPASS PWA Service Worker (v1.0.0)
// High-performance caching for App Shell with bypass for Live Cloud APIs
// ====================================================================

const CACHE_NAME = 'charrmpass-cache-v1';
const APP_SHELL_ASSETS = [
    '/',
    '/index.html',
    '/admin-dashboard.html',
    '/guard-dashboard.html',
    '/entry-dashboard.html',
    '/exit-dashboard.html',
    '/styles.css',
    '/manifest.json',
    '/logocharrmpark.png',
    '/landingbg.jpg'
];

// Install: Cache core UI assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[PWA SW] Pre-caching offline app shell...');
            return cache.addAll(APP_SHELL_ASSETS).catch((err) => {
                console.warn('[PWA SW] Non-fatal caching warning:', err);
            });
        }).then(() => self.skipWaiting())
    );
});

// Activate: Clean up old cache versions
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) {
                        console.log('[PWA SW] Removing outdated cache:', key);
                        return caches.delete(key);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch: Network-first strategy with cache fallback (bypass Supabase API)
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Bypass caching for Supabase REST API, Auth, and WebSockets
    if (url.hostname.includes('supabase.co')) {
        return; // Normal network request
    }

    // Only handle GET requests
    if (event.request.method !== 'GET') {
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                // If valid response, clone and update cache
                if (networkResponse && networkResponse.status === 200) {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    });
                }
                return networkResponse;
            })
            .catch(() => {
                // Network failed (offline): serve from cache
                return caches.match(event.request).then((cachedResponse) => {
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    // Offline fallback for navigation
                    if (event.request.mode === 'navigate') {
                        return caches.match('/index.html');
                    }
                });
            })
    );
});
