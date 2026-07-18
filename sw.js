// ════════════════════════════════════════════════════════
//  KEEPO — Service Worker
//  Gère : installation PWA, push notifications, offline fallback
// ════════════════════════════════════════════════════════

const CACHE_NAME = 'KEEPO-cache-v3';
const OFFLINE_ASSETS = ['/dashboard-client', '/css/style.css', '/img/icon-192.png'];

// ── Installation ──
self.addEventListener('install', e => {
    self.skipWaiting();
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            cache.addAll(OFFLINE_ASSETS).catch(() => {}) // ignore si ressource manquante
        )
    );
});

// ── Activation ──
self.addEventListener('activate', e => {
    e.waitUntil(
        Promise.all([
            clients.claim(),
            // Nettoie les anciens caches
            caches.keys().then(keys =>
                Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
            )
        ])
    );
});

// ── Push Notifications ──
self.addEventListener('push', e => {
    let data = {};
    try { data = e.data?.json?.() || {}; } catch {}

    const title   = data.title || 'KEEPO 🎉';
    const options = {
        body   : data.body  || 'Vous avez une mise à jour sur votre carte de fidélité.',
        icon   : '/img/icon-192.png',
        badge  : '/img/icon-192.png',
        tag    : data.tag   || 'KEEPO-notif',
        data   : { url: data.url || '/dashboard-client' },
        vibrate: [100, 50, 100],
        actions: [{ action: 'open', title: 'Voir mes points' }]
    };
    e.waitUntil(self.registration.showNotification(title, options));
});

// ── Clic sur notification ──
self.addEventListener('notificationclick', e => {
    e.notification.close();
    const url = e.notification.data?.url || '/dashboard-client';
    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
            const existing = wins.find(w => w.url.includes('/dashboard-client'));
            if (existing) return existing.focus();
            return clients.openWindow(url);
        })
    );
});

// ── Fetch — Network first, cache fallback ──
self.addEventListener('fetch', e => {
    // Ne gère que les requêtes GET same-origin, ignore API/Supabase
    if (e.request.method !== 'GET') return;
    const url = new URL(e.request.url);
    if (url.pathname.startsWith('/api/') || url.hostname !== self.location.hostname) return;

    e.respondWith(
        fetch(e.request)
            .then(res => {
                // Met en cache les assets statiques
                if (res.ok && (e.request.url.includes('/css/') || e.request.url.includes('/img/'))) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
                }
                return res;
            })
            .catch(() => caches.match(e.request))
    );
});
