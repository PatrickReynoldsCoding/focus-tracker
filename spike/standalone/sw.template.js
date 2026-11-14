// SPIKE, throwaway. Generated into dist/sw.js by build.js. Precaches the whole app, so it starts with no network.
var VERSION = '__VERSION__';
var CACHE = 'ft-standalone-' + VERSION;
var FILES = __FILES__;
self.addEventListener('install', function (e) {
  // No skipWaiting here: a new version waits until the page says so (or every tab is closed), so a page never
  // runs old front-end code against a new service worker cache halfway through.
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('ft-standalone-') === 0 && k.indexOf(CACHE) !== 0; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('message', function (e) { if (e.data === 'skipWaiting') self.skipWaiting(); });
self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.origin === location.origin && (url.pathname.indexOf('/v4/') === 0 || url.pathname.indexOf('/__fake') === 0)) return; // data: never cached here
  if (url.origin === location.origin) {
    // App files: cache first. A navigation to any page path gets the app page.
    var key = req.mode === 'navigate' ? 'index.html' : req;
    e.respondWith(caches.open(CACHE).then(function (c) { return c.match(key, { ignoreSearch: true }).then(function (hit) { return hit || fetch(req); }); }));
    return;
  }
  // CDN files (GridStack, Sortable, fonts): versioned URLs, so cache first and fill the cache on first use.
  e.respondWith(caches.open(CACHE + '-cdn').then(function (c) {
    return c.match(req).then(function (hit) {
      return hit || fetch(req).then(function (r) { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; });
    });
  }));
});
