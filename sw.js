// LS Maps service worker — network-first for everything same-origin, cache as
// fallback. Network-first deliberately (ASCEND's cache-first SW served stale
// pages during updates); offline you get the app shell, though live tiles,
// routing and search still need a connection.
var CACHE = "lsmaps-v2";
var SHELL = [
  ".",
  "index.html",
  "css/app.css",
  "js/app.js",
  "js/gta-style.js",
  "vendor/maplibre-gl.js",
  "vendor/maplibre-gl.css",
  "vendor/qrcode.js",
  "manifest.webmanifest",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
  "icon-180.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        return c.add(u).catch(function () {}); // missing one file shouldn't kill install
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: req.mode === "navigate" });
    })
  );
});
