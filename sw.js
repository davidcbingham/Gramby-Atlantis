/* Monarch — service worker
   Offline for a field tool: cache the app shell so it opens with no signal,
   and cache basemap + historic-overlay tiles for the townsite when the user
   asks to "download this area". Cross-origin tiles come back opaque (no CORS);
   the Cache API stores and replays them fine for <img>-based tile display. */
"use strict";

const APP_CACHE  = "monarch-app-v2";
const TILE_CACHE = "monarch-tiles-v1";
const APP_SHELL  = ["./", "./index.html", "./sw.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(APP_CACHE)
      .then((c) => c.addAll(APP_SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== APP_CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Hosts whose responses are map tiles / dynamic map exports worth caching.
function isTile(url) {
  return /(server\.arcgisonline\.com|ngmdb\.usgs\.gov|basemap\.nationalmap\.gov|tiledbasemaps\.arcgis\.com)/.test(url);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  // Navigations: serve the cached shell first so the app opens offline.
  if (req.mode === "navigate") {
    e.respondWith(
      caches.match("./index.html").then((cached) => cached || fetch(req)).catch(() => caches.match("./index.html"))
    );
    return;
  }

  if (isTile(req.url)) {
    e.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const resp = await fetch(req);
          if (resp && (resp.ok || resp.type === "opaque")) cache.put(req, resp.clone());
          return resp;
        } catch (err) {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // Same-origin assets (Leaflet CSS/JS, etc.): cache-first, fall back to network.
  e.respondWith(caches.match(req).then((r) => r || fetch(req)));
});

// Pre-fetch a batch of tile URLs for offline use, reporting progress back.
self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type === "CACHE_AREA" && Array.isArray(d.urls)) {
    e.waitUntil(cacheArea(d.urls));
  }
});

async function cacheArea(urls) {
  const cache = await caches.open(TILE_CACHE);
  let done = 0, failed = 0;
  const report = async (type) => {
    const cs = await self.clients.matchAll();
    cs.forEach((c) => c.postMessage({ type, done, failed, total: urls.length }));
  };
  for (const u of urls) {
    try {
      const existing = await cache.match(u);
      if (!existing) {
        // no-cors: opaque response, still cacheable and displayable as an image.
        const resp = await fetch(u, { mode: "no-cors" });
        if (resp && (resp.ok || resp.type === "opaque")) await cache.put(u, resp.clone());
        else failed++;
      }
    } catch (err) {
      failed++;
    }
    done++;
    if (done % 10 === 0 || done === urls.length) await report("CACHE_PROGRESS");
  }
  await report("CACHE_DONE");
}
