importScripts('version.js');
const CACHE = `rice-water-monitor-app-${self.RICE_APP_VERSION}`;
const ASSETS = ['./', 'index.html', 'styles.css', 'version.js', 'app.js', 'manifest.webmanifest', 'icon.svg'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS))));
self.addEventListener('activate', (event) => event.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim())
));
self.addEventListener('fetch', (event) => event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request))));
