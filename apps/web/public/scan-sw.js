/* Scanner service worker: keeps the /scan shell and its assets so the app reloads with no network.
 * API calls are never cached (claims must always reach the server). Bump VERSION to drop old caches. */
const VERSION = "v1";
const SHELL = `scan-shell-${VERSION}`;
const ASSETS = `scan-assets-${VERSION}`;
const SHELL_URLS = [
  "/scan",
  "/scan/manifest.webmanifest",
  "/scan/icon-192.png",
  "/scan/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

/** Navigation to the scanner: fresh page when the network answers, the cached shell when not. */
async function navigate(request) {
  const cache = await caches.open(SHELL);
  try {
    const response = await Promise.race([fetch(request), timeout(4000)]);
    if (response.ok) cache.put("/scan", response.clone());
    return response;
  } catch {
    return (await cache.match("/scan")) ?? Response.error();
  }
}

/** Hashed build files never change, so the cache wins. */
async function asset(request) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    if (url.pathname === "/scan" || url.pathname === "/scan/") event.respondWith(navigate(request));
    return;
  }
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/scan/")) {
    event.respondWith(asset(request));
  }
});

/** The page lists the build files it loaded; keep any we do not have yet. */
self.addEventListener("message", (event) => {
  if (event.data?.type !== "cache-urls" || !Array.isArray(event.data.urls)) return;
  event.waitUntil(
    caches.open(ASSETS).then(async (cache) => {
      for (const path of event.data.urls) {
        if (typeof path !== "string" || !path.startsWith("/_next/static/")) continue;
        if (await cache.match(path)) continue;
        try {
          await cache.add(path);
        } catch {
          // fetched again on demand
        }
      }
    }),
  );
});
