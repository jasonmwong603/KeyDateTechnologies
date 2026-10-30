import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverApps, mountsFor, RESERVED_SLUGS } from './apps.mjs';
import { StaticHost } from './staticHost.mjs';

/**
 * Serves the magic apps, and gives nothing else away.
 *
 * This replaced a game server that happened to have the calculator bolted to
 * the side of it. What is left is the part that was doing the work: static
 * files, correct types, one folder per app.
 *
 * Run with: npm start
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const apps = await discoverApps(path.join(repoRoot, 'apps'));
// Only ever `public/` — see mountsFor, which is where that boundary lives.
const host = new StaticHost(mountsFor(apps));

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');

  /*
   * The health check says whether the process is up, and how many apps it
   * found. It does not say what they are.
   *
   * Naming them would publish the one thing worth not publishing. The slug IS
   * the address, so a `/healthz` listing them is a directory of every trick on
   * the host, reachable by anyone who guesses one obvious URL. The count is
   * enough to tell a misconfigured deploy (0 apps) from a healthy one.
   */
  if (RESERVED_SLUGS.includes(url.pathname)) {
    response
      .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify({ status: 'ok', apps: apps.length }));
    return;
  }

  host.handle(request, response).then(
    (handled) => {
      /*
       * Everything else is a flat 404, the domain root included.
       *
       * No index, no listing, no "nothing here yet" page with a name on it.
       * Someone who types the bare domain should learn nothing at all, because
       * the alternative is a page that invites them to look for what is.
       */
      if (!handled) response.writeHead(404).end('Not found');
    },
    (error) => {
      console.error('request failed', error);
      if (!response.headersSent) response.writeHead(500).end('Server error');
      else response.end();
    },
  );
});

const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => {
  console.log(`magic apps on :${port}`);
  for (const app of apps) console.log(`  ${app.slug}/  ${app.name}`);
  if (apps.length === 0) console.log('  (no apps found — is apps/*/app.json missing?)');
});
