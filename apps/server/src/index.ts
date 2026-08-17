import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TICK_DT } from '@keydate/sim';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { Gateway } from './gateway.js';
import { SessionRegistry } from './sessionRegistry.js';
import { StaticFileServer } from './staticFiles.js';

/**
 * Process entry point: HTTP + WebSocket on one port, plus the master tick loop.
 *
 * Sharing a port keeps deployment to a single service and means the client is
 * always served by the server it will connect back to — no CORS, no separate
 * origin to configure.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/ -> apps/server -> apps -> repo root
const repoRoot = path.resolve(here, '../../..');

/**
 * Everything the game serves lives under this prefix.
 *
 * The whole game is one mount point, so it can sit beside other properties on
 * the same host — `play.keydate.ca/the-floor` — without owning the domain root.
 * Renaming the game is a change to `GAME_SLUG` and nothing else.
 */
const base = config.basePath;

const staticServer = new StaticFileServer(
  [
    { urlPrefix: `${base}/js`, directory: path.join(repoRoot, 'apps/client/src') },
    { urlPrefix: `${base}/assets`, directory: path.join(repoRoot, 'apps/client/assets') },
    {
      urlPrefix: `${base}/pkg/protocol`,
      directory: path.join(repoRoot, 'packages/protocol/dist'),
    },
    { urlPrefix: `${base}/pkg/netcode`, directory: path.join(repoRoot, 'packages/netcode/dist') },
    { urlPrefix: `${base}/pkg/sim`, directory: path.join(repoRoot, 'packages/sim/dist') },
    {
      urlPrefix: `${base}/vendor/three`,
      directory: path.join(repoRoot, 'node_modules/three/build'),
    },
  ],
  path.join(repoRoot, 'apps/client/index.html'),
  base,
);

/**
 * Fail loudly at boot if the client's dependencies are not on disk.
 *
 * Without this, a production install that skipped `three` (because the platform
 * set NODE_ENV=production and it was a devDependency) starts perfectly and then
 * serves a page whose module graph 404s. The player sees a blank screen and the
 * server log says nothing at all.
 */
function checkClientAssets(): void {
  const required = [
    path.join(repoRoot, 'node_modules/three/build/three.module.js'),
    path.join(repoRoot, 'apps/client/index.html'),
    path.join(repoRoot, 'packages/sim/dist/index.js'),
  ];

  const missing = required.filter((file) => !existsSync(file));
  if (missing.length === 0) return;

  process.stderr.write(
    `\n  Cannot serve the client — these files are missing:\n` +
      missing.map((file) => `    ${file}\n`).join('') +
      `\n  Run \`npm ci --include=dev && npm run build\`. A plain \`npm ci\` under\n` +
      `  NODE_ENV=production skips devDependencies and will not build.\n\n`,
  );
  process.exit(1);
}

checkClientAssets();

const registry = new SessionRegistry();
const gateway = new Gateway(registry);

const httpServer = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');

  // Health checks stay at the domain root: platform probes hit `/healthz` and
  // should not have to know where the game happens to be mounted.
  if (url.pathname === '/healthz' || url.pathname === `${base}/healthz`) {
    const worlds = registry.all;
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        status: 'ok',
        game: config.gameSlug,
        basePath: base,
        worlds: worlds.length,
        players: worlds.reduce((sum, world) => sum + world.playerCount, 0),
        tickRate: 1 / TICK_DT,
      }),
    );
    return;
  }

  // `/the-floor` without the trailing slash, and the host root, both land on
  // the game. A 301 rather than serving the page directly keeps exactly one
  // canonical URL, so relative asset paths cannot resolve one level too high.
  if (base !== '' && (url.pathname === base || url.pathname === '/')) {
    response.writeHead(301, { location: `${base}/` }).end();
    return;
  }

  // A previous name for this game. Redirect rather than 404 so links shared
  // before the rename, and apps built against the old address, keep working.
  for (const legacy of config.legacySlugs) {
    if (url.pathname !== legacy && !url.pathname.startsWith(`${legacy}/`)) continue;
    const remainder = url.pathname.slice(legacy.length);
    response.writeHead(301, { location: `${base}${remainder === '' ? '/' : remainder}` }).end();
    return;
  }

  void staticServer.handle(request, response).then((handled) => {
    if (!handled) response.writeHead(404).end('Not found');
  });
});

const wss = new WebSocketServer({
  server: httpServer,
  // Mounted alongside the client so one reverse-proxy rule covers both.
  path: `${base}/ws`,
  // Input frames are tiny; anything large is either a bug or an attack.
  maxPayload: 16 * 1024,
});

wss.on('connection', (socket) => gateway.handleConnection(socket));

/**
 * The master tick.
 *
 * `setInterval` drifts, so each tick recomputes how many whole ticks are due
 * from wall-clock elapsed time and runs exactly that many. Without this the
 * simulation slowly falls behind real time under load and every client's
 * prediction runs ahead of the server.
 */
const tickIntervalMs = TICK_DT * 1000;
let lastTickAt = Date.now();
let accumulator = 0;
/** Ceiling on catch-up ticks per timer fire, so a stall cannot freeze the loop. */
const MAX_CATCHUP_TICKS = 5;

const loop = setInterval(() => {
  const now = Date.now();
  accumulator += now - lastTickAt;
  lastTickAt = now;

  let ticks = 0;
  while (accumulator >= tickIntervalMs && ticks < MAX_CATCHUP_TICKS) {
    accumulator -= tickIntervalMs;
    ticks += 1;
    registry.update();
  }
  if (ticks === MAX_CATCHUP_TICKS) accumulator = 0;
}, tickIntervalMs);

/** Housekeeping runs far less often than the simulation. */
const housekeeping = setInterval(() => {
  gateway.sweepIdle();
  registry.collectEmpty();
}, 5_000);

/**
 * Every address this machine can be reached on.
 *
 * Printing these is the difference between "it runs" and "my friend can join
 * from their phone": the loopback address in the log is useless to anyone
 * holding a different device, and finding the LAN IP by hand is the single most
 * common thing that stops someone trying a local multiplayer build.
 */
function localAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

httpServer.listen(config.port, config.host, () => {
  const rate = Math.round(1 / TICK_DT);
  const lines = [
    '',
    `  ${config.gameTitle} — world server running at ${rate}Hz`,
    '',
    `  On this computer:   http://localhost:${config.port}${base}/`,
  ];

  const lan = localAddresses();
  if (lan.length > 0) {
    lines.push('', '  On your phone or another device (same Wi-Fi):');
    for (const address of lan) lines.push(`    http://${address}:${config.port}${base}/`);
  } else {
    lines.push('', '  No LAN address detected — other devices cannot reach this server.');
  }

  lines.push('', '  Press Ctrl+C to stop.', '');
  process.stdout.write(`${lines.join('\n')}\n`);
});

function shutdown(signal: string): void {
  process.stdout.write(`\n${signal} received, shutting down.\n`);
  clearInterval(loop);
  clearInterval(housekeeping);
  for (const client of wss.clients) client.close(1001, 'Server shutting down');
  wss.close();
  httpServer.close(() => process.exit(0));
  // Do not let a stuck socket hold the process open forever.
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
