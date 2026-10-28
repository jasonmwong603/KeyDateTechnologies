/*
 * Makes the calculator work with no signal at all — without it being a version
 * behind when there is signal.
 *
 * The offline part is not a nicety. Adding a page to the iOS home screen saves
 * a bookmark, not the page — tap it in a basement with no bars and you get an
 * error, in front of an audience, holding a dead prop. The only thing that
 * actually puts the files on the phone is a service worker.
 *
 * The staleness part is not a nicety either, and cost a day to learn. The first
 * version of this served the cache first for everything, including the page.
 * A change shipped, the phone kept running the copy it already had, and the
 * screenshots that came back were of code that had been replaced — bugs fixed
 * days earlier, still on the prop. A cache that cannot be got out of the way is
 * worse than no cache, because you stop being able to trust what you are
 * looking at.
 *
 * So: the page itself is fetched fresh when the network answers quickly, and
 * comes from the cache the moment it does not. Everything else — icons, the
 * manifest — is cache-first, because those do not change and are not worth a
 * round trip.
 */

// Bumping this name is what makes a phone throw away the previous copy. Change
// it whenever anything in FILES changes; it is also the one byte in this file
// that guarantees the browser notices there is a new worker at all.
const CACHE = 'calc-v2';

const FILES = ['./', './index.html', './manifest.webmanifest', './icon-180.png', './icon-512.png'];

/** How long the page waits on a slow network before giving up and using the cache. */
const PATIENCE = 1200;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // `reload` bypasses the HTTP cache on the way in. Without it an install
      // can "succeed" having stored the same stale bytes it was meant to
      // replace, which is the failure that is hardest to see.
      .then((cache) => cache.addAll(FILES.map((file) => new Request(file, { cache: 'reload' }))))
      // Take over immediately rather than waiting for the old worker to be
      // released. There is no old page worth protecting here, and the
      // alternative is an update that lands one launch later than you think.
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

/** The network, but never for longer than it is worth waiting. */
function racedFetch(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('slow')), PATIENCE);
    fetch(request).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // The page: fresh if the network is there and quick, cached otherwise. A
  // basement fails in milliseconds, so this costs nothing where it matters; a
  // hotel captive portal that hangs costs PATIENCE and no more.
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      racedFetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
          }
          return response;
        })
        .catch(() =>
          caches
            .match(request)
            .then((hit) => hit ?? caches.match('./index.html'))
            .then((hit) => hit ?? Response.error()),
        ),
    );
    return;
  }

  // Everything else: straight from the phone, refreshed quietly for next time.
  event.respondWith(
    caches.match(request).then((hit) => {
      const fresh = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        // Being offline is the expected case here, not an error worth surfacing.
        .catch(() => hit);

      return hit ?? fresh;
    }),
  );
});
