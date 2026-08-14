import { createServer } from 'node:http';
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

const staticServer = new StaticFileServer(
  [
    { urlPrefix: '/js', directory: path.join(repoRoot, 'apps/client/src') },
    { urlPrefix: '/assets', directory: path.join(repoRoot, 'apps/client/assets') },
    { urlPrefix: '/pkg/protocol', directory: path.join(repoRoot, 'packages/protocol/dist') },
    { urlPrefix: '/pkg/netcode', directory: path.join(repoRoot, 'packages/netcode/dist') },
    { urlPrefix: '/pkg/sim', directory: path.join(repoRoot, 'packages/sim/dist') },
    { urlPrefix: '/vendor/three', directory: path.join(repoRoot, 'node_modules/three/build') },
  ],
  path.join(repoRoot, 'apps/client/index.html'),
);

const registry = new SessionRegistry();
const gateway = new Gateway(registry);

const httpServer = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (url.pathname === '/healthz') {
    const worlds = registry.all;
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        status: 'ok',
        worlds: worlds.length,
        players: worlds.reduce((sum, world) => sum + world.playerCount, 0),
        tickRate: 1 / TICK_DT,
      }),
    );
    return;
  }

  void staticServer.handle(request, response).then((handled) => {
    if (!handled) response.writeHead(404).end('Not found');
  });
});

const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
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

httpServer.listen(config.port, config.host, () => {
  process.stdout.write(
    `keydate world server listening on http://${config.host}:${config.port} ` +
      `(${Math.round(1 / TICK_DT)}Hz)\n`,
  );
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
