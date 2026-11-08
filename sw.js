// ====================================================================
// CHARRMPASS PWA Service Worker (v3.0.0)
// High-performance caching for App Shell with bypass for Live Cloud APIs
// ====================================================================

const CACHE_NAME = 'charrmpass-cache-v3';
const APP_SHELL_ASSETS = [
    '/',
    '/index.html',
    '/admin-dashboard.html',
    '/guard-dashboard.html',
    '/entry-dashboard.html',
    '/exit-dashboard.html',
    '/register.html',
    '/settings.html',
    '/styles.css',
    '/supabase-config.js',
    '/guard-app.js',
    '/entry-app.js',
    '/exit-app.js',
    '/admin-app.js',
    '/register.js',
    '/manifest.json',
    '/icon-192.png',
    '/icon-512.png',
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

// Fetch: Network-first strategy with cache fallback (bypass non-HTTP & Supabase API)
self.addEventListener('fetch', (event) => {
    let url;
    try {
        url = new URL(event.request.url);
    } catch (e) {
        return;
    }

    // Ignore non-HTTP(S) schemes (e.g. chrome-extension://, data:, blob:)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return;
    }

    // Bypass caching for Supabase REST API, Auth, Storage, WebSockets, and video range requests
    if (
        url.hostname.includes('supabase.co') ||
        event.request.headers.has('range') ||
        url.pathname.endsWith('.mp4')
    ) {
        return;
    }

    // Only handle GET requests
    if (event.request.method !== 'GET') {
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200 && (networkResponse.type === 'basic' || networkResponse.type === 'cors')) {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone).catch(() => {});
                    });
                }
                return networkResponse;
            })
            .catch(() => {
                return caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    // Support Vercel cleanUrls (e.g. /admin-dashboard -> /admin-dashboard.html)
                    if (!url.pathname.includes('.') && url.pathname !== '/') {
                        return caches.match(url.pathname + '.html').then((cleanMatch) => {
                            if (cleanMatch) return cleanMatch;
                            if (event.request.mode === 'navigate') return caches.match('/index.html');
                        });
                    }
                    if (event.request.mode === 'navigate') {
                        return caches.match('/index.html');
                    }
                });
            })
    );
});
