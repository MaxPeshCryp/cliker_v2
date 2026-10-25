// Bump the cache version whenever the offline page or bundled icons change.
const CACHE_NAME = "clicker-pwa-v1"
const OFFLINE_URL = "/offline.html"
const OFFLINE_ASSETS = [
    OFFLINE_URL,
    "/assets/icons/icon-192.png",
    "/assets/icons/icon-512.png",
    "/assets/icons/icon-maskable-512.png",
    "/assets/icons/apple-touch-icon.png"
]

self.addEventListener("install", event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(OFFLINE_ASSETS)))
    // Updates wait until the player chooses to apply them or closes all game windows.
})

self.addEventListener("activate", event => {
    event.waitUntil((async () => {
        const names = await caches.keys()
        await Promise.all(names.filter(name => name.startsWith("clicker-pwa-") && name !== CACHE_NAME).map(name => caches.delete(name)))
        await self.clients.claim()
    })())
})

self.addEventListener("message", event => {
    if (event.data?.type === "SKIP_WAITING") self.skipWaiting()
})

self.addEventListener("fetch", event => {
    const request = event.request
    const url = new URL(request.url)
    // Never cache accounts, balances, avatars, API responses or the admin panel.
    // The game always comes from the server; only the disconnected screen is offline.
    if (request.method !== "GET" || url.origin !== self.location.origin) return
    if (OFFLINE_ASSETS.includes(url.pathname) && !url.search) {
        event.respondWith(caches.match(request).then(cached => cached || fetch(request)))
        return
    }
    if (request.mode !== "navigate" || url.pathname !== "/") return
    event.respondWith((async () => {
        try {
            const response = await fetch(request)
            if (response.status < 500) return response
        } catch (_) { /* Show the same useful screen for network failures. */ }
        return (await caches.match(OFFLINE_URL)) || Response.error()
    })())
})
