importScripts('version.js');
// Build marker changes with every App release so installed clients fetch the
// new worker even when only version.js or app.js changed.
const SERVICE_WORKER_BUILD = '0.6.1+4';
const CACHE = `rice-water-monitor-app-${self.RICE_APP_VERSION}`;
const ASSETS = ['./', 'index.html', 'styles.css', 'version.js', 'app.js', 'manifest.webmanifest', 'icon.svg'];
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
self.addEventListener('fetch', (event) => event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request))));
