import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Serves each app's folder, and nothing else.
 *
 * Every app here is plain files — HTML, a service worker, a manifest, a couple
 * of icons — so the host has one job: hand them over with the right type and
 * refuse to hand over anything outside the folder. There is no build step and
 * no framework, because an app that has to be compiled before it can be
 * performed is an app that can fail on the night.
 *
 * The traversal guard and the MIME table came from the game server this
 * replaced, where they were covered by tests. They are carried over rather than
 * rewritten: the one part of a static server that is genuinely easy to get
 * wrong is the part that decides a path is inside the folder.
 */

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Must be this exact type or browsers ignore the manifest, and an app that
  // cannot be installed to the home screen is an app with Safari's address bar
  // across the top of it.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export class StaticHost {
  /** @param {{urlPrefix: string, directory: string}[]} mounts */
  constructor(mounts) {
    this.mounts = mounts;
  }

  /** Serves the request, returning false when no mount claims it. */
  async handle(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;

    const url = new URL(request.url ?? '/', 'http://localhost');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      // A malformed escape sequence is not a path. Answering at all is more
      // than it deserves, but a 400 beats a stack trace.
      response.writeHead(400).end('Bad request');
      return true;
    }

    for (const mount of this.mounts) {
      /*
       * The mount's own front door redirects to its trailing slash, rather than
       * quietly serving the index in place.
       *
       * This matters more than it reads. Every URL inside these apps is
       * relative — `./sw.js`, `./manifest.webmanifest` — so at `/calc` the
       * browser resolves them against `/` and gets nothing, while at `/calc/`
       * it resolves them against the app and gets everything. Serving the page
       * at both addresses therefore produces a version of the app that looks
       * perfect and has no service worker and no manifest: no offline, and
       * Safari's chrome across the top once it is on the home screen. The old
       * server did exactly that, and it would have failed in a basement.
       */
      if (pathname === mount.urlPrefix) {
        response.writeHead(301, { location: `${mount.urlPrefix}/` }).end();
        return true;
      }

      if (!pathname.startsWith(`${mount.urlPrefix}/`)) continue;

      const relative = pathname.slice(mount.urlPrefix.length).replace(/^\//, '');
      // The mount itself, or any directory inside it, means that directory's
      // index page.
      const target = relative === '' || relative.endsWith('/') ? `${relative}index.html` : relative;
      const resolved = path.resolve(mount.directory, target);

      // Reject anything that escapes the folder. `path.resolve` has already
      // collapsed `..`, so a prefix check on the resolved path is sufficient
      // and cannot be fooled by encoded traversal sequences.
      const root = path.resolve(mount.directory);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        response.writeHead(403).end('Forbidden');
        return true;
      }

      const sent = await this.sendFile(response, resolved, request.method === 'HEAD');
      if (!sent) response.writeHead(404).end('Not found');
      return true;
    }

    return false;
  }

  async sendFile(response, filePath, headOnly) {
    let size;
    try {
      const stats = await stat(filePath);
      if (!stats.isFile()) return false;
      size = stats.size;
    } catch {
      return false;
    }

    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    response.writeHead(200, {
      'content-type': type,
      'content-length': size,
      /*
       * Never cached at the edge.
       *
       * Each app installs a service worker that decides for itself what to keep
       * and when to go to the network, and it is already cautious — the page is
       * fetched fresh when the network answers quickly. An HTTP cache in front
       * of that can only do one thing: hold a version back after the worker has
       * asked for a new one, which is the exact failure that had a fixed prop
       * running week-old code on a phone.
       */
      'cache-control': 'no-store',
    });

    if (headOnly) {
      response.end();
      return true;
    }

    await new Promise((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(response);
    });
    return true;
  }
}
