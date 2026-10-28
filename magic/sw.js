/*
 * Makes the calculator work with no signal at all.
 *
 * This is not a nicety. Adding a page to the iOS home screen saves a bookmark,
 * not the page — tap it in a basement with no bars and you get an error, in
 * front of an audience, holding a dead prop. The only thing that actually puts
 * the files on the phone is a service worker, so this is the difference between
 * a trick that works and one that depends on the venue's wifi.
 *
 * Cache first, deliberately. The network is consulted afterwards and only to
 * refresh the cache for next launch, never to decide what to show now. A slow
 * or half-open connection — a hotel captive portal, say — can therefore delay
 * nothing: the phone already has everything and opens instantly.
 */

const CACHE = 'calc-v1';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon-180.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  // Take over immediately rather than waiting for the old worker to be released.
  // There is no old page to protect here, and the alternative is an install that
  // appears to have worked but has cached nothing until a second launch.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE).map((n) => caches.delete(n))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((hit) => {
      // Refresh in the background so a change reaches the phone on the next
      // launch. Failures here are silent and harmless by design: being offline
      // is the expected case, not an error worth surfacing.
      const fresh = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => hit);

      return hit ?? fresh;
    }),
  );
});
