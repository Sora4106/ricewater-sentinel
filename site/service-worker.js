importScripts('version.js');
// Build marker changes with every App release so installed clients fetch the
// new worker even when only version.js or app.js changed.
const SERVICE_WORKER_BUILD = '0.6.1+14';
const CACHE = `rice-water-monitor-app-${self.RICE_APP_VERSION}`;
const ASSETS = ['index.html', 'styles.css', 'version.js', 'app.js', 'manifest.webmanifest', 'icon.svg'];
self.addEventListener('install', (event) => event.waitUntil(
  caches.open(CACHE)
    .then((cache) => cache.addAll(ASSETS))
    .then(() => self.skipWaiting())
));
self.addEventListener('activate', (event) => event.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim())
));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (event.request.mode === 'navigate') {
    // An update must never preserve an older cached homepage.  When online,
    // always load the newest page and use the cached page only offline.
    event.respondWith(fetch(event.request).catch(() => caches.match('index.html')));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
