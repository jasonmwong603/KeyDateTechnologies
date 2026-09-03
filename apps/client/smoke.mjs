/**
 * Client smoke test.
 *
 * The unit suite covers the simulation, the protocol and the game rules, because
 * those are pure and headless. It cannot catch the class of break that actually
 * stops someone playing: a broken import map, a WebGL context that never comes
 * up, or a HUD element that silently swallows every touch on a phone.
 *
 * So this drives a real browser against a real server, on both a desktop
 * viewport and an emulated phone, and asserts the things a player would notice
 * within ten seconds of loading the page.
 *
 * Run with: npm run test:client
 */

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

/**
 * Some environments ship a preinstalled Chromium whose build number does not
 * match the one this Playwright release expects. Point at it explicitly rather
 * than downloading a second copy.
 */
function launchOptions() {
  const override = process.env.CHROMIUM_PATH;
  const candidates = [
    override,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return { executablePath: candidate };
  }
  return {};
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const PORT = Number(process.env.SMOKE_PORT ?? 8099);
/**
 * The game runs under a path prefix here on purpose.
 *
 * Production serves it at play.keydate.ca/<slug>, and a client that only works
 * at a domain root breaks in ways that never appear when testing at `/`.
 */
const SLUG = process.env.SMOKE_SLUG ?? 'beer-bets';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/${SLUG}/`;
const SHOT_DIR = process.env.SMOKE_SHOT_DIR ?? path.join(repoRoot, '.smoke');

let failures = 0;

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls a page until `probe` returns something truthy, or the budget runs out.
 *
 * For anything whose answer comes back from the server. A fixed sleep is the
 * wrong tool there: it is either longer than it needs to be on every run, or
 * too short on the one run where the machine is busy — and both of those were
 * real flakes here before this existed.
 */
async function waitFor(page, probe, budgetMs = 8000, stepMs = 200) {
  for (let waited = 0; waited <= budgetMs; waited += stepMs) {
    const value = await page.evaluate(probe);
    if (value) return value;
    await sleep(stepMs);
  }
  return null;
}

/**
 * Walks the player toward something, steering around whatever is in the way.
 *
 * `aim` points the camera at the target and returns its distance. Holding W at
 * a fixed heading is not enough now that the floor has furniture on it: walk
 * head-on into a stool and collision refuses the move outright, with no
 * sideways component to slide on, so a naive loop presses W forever against a
 * chair. A person would step around it, so this does too.
 */
async function walkTowards(page, aim, stopWithin, attempts = 90) {
  let distance = Infinity;
  let stalledFor = 0;
  let sidestep = 'KeyD';

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const target = await page.evaluate(aim);
    if (target === null || target === undefined) break;
    if (target.distance < stopWithin) return target.distance;

    // No progress since last time means something solid is in front.
    stalledFor = target.distance < distance - 0.05 ? 0 : stalledFor + 1;
    distance = Math.min(distance, target.distance);

    if (stalledFor >= 2) {
      await page.keyboard.down(sidestep);
      await page.keyboard.down('KeyW');
      await sleep(320);
      await page.keyboard.up('KeyW');
      await page.keyboard.up(sidestep);
      // Alternate, so a stool wedged between two others cannot trap the loop
      // by always being stepped around the same way.
      sidestep = sidestep === 'KeyD' ? 'KeyA' : 'KeyD';
      stalledFor = 0;
    } else {
      await page.keyboard.down('KeyW');
      await sleep(250);
      await page.keyboard.up('KeyW');
    }
    await sleep(60);
  }
  const final = await page.evaluate(aim);
  return final?.distance ?? distance;
}

async function startServer() {
  const server = spawn(process.execPath, [path.join(repoRoot, 'apps/server/dist/index.js')], {
    env: { ...process.env, PORT: String(PORT), GAME_SLUG: SLUG },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${ORIGIN}/healthz`);
      if (response.ok) return server;
    } catch {
      // Not up yet.
    }
    await sleep(250);
  }
  throw new Error('Server did not become healthy');
}

/** Joins the world and waits until the player is actually in it. */
async function join(page, name, sessionCode = '') {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#name-input', name);
  if (sessionCode) await page.fill('#code-input', sessionCode);
  await page.click('#join-button');

  // The join overlay hides only once `welcome` has been processed.
  await page.waitForSelector('#join-screen', { state: 'hidden', timeout: 15_000 });
  return errors;
}

/** Reads the local player's position out of the running client. */
function readPosition(page) {
  return page.evaluate(() => window.__keydate?.position() ?? null);
}

/**
 * Serves a directory over HTTP, standing in for an app's local file store.
 *
 * The packaged-client check needs the page to come from somewhere that is *not*
 * the game server, because that is the whole situation a packaged app is in:
 * the HTML is local, the server is elsewhere.
 */
function serveDirectory(directory, port) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const relative =
      url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
    const target = path.resolve(directory, relative);

    if (!target.startsWith(path.resolve(directory))) {
      response.writeHead(403).end();
      return;
    }
    try {
      if (!statSync(target).isFile()) throw new Error('not a file');
    } catch {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': types[path.extname(target)] ?? 'application/octet-stream',
    });
    createReadStream(target).pipe(response);
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/** Runs the client bundler into `outDir`, baking in `serverUrl`. */
function runBundler(outDir, serverUrl) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'scripts/bundle-client.mjs')], {
      env: { ...process.env, KEYDATE_BUNDLE_DIR: outDir, KEYDATE_SERVER_URL: serverUrl },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[bundler] ${chunk}`));
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function run() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch(launchOptions());

  try {
    // ---------------------------------------------------------------- desktop
    console.log('\nDesktop (1280x800, keyboard + mouse)');
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pc = await desktop.newPage();
    const pcErrors = await join(pc, 'DesktopPlayer');

    check('page loads and joins the world', true);
    check('no uncaught page errors', pcErrors.length === 0, pcErrors[0]);

    const hudVisible = await pc.isVisible('#hud');
    check('HUD is visible', hudVisible);

    const chips = await pc.textContent('#chips-value');
    check('chip balance is populated', chips && chips !== '0', `chips=${chips}`);

    // WebGL actually came up, rather than the canvas being a blank element.
    const rendering = await pc.evaluate(() => {
      const canvas = document.getElementById('viewport');
      return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0;
    });
    check('WebGL canvas is sized and rendering', rendering);

    // The environment is built from the world description at join. A silent
    // failure here — a bad `kind`, a throw partway through buildWorld — leaves
    // a room that still "works" but is missing its walls or columns.
    const stats = await pc.evaluate(() => window.__keydate?.sceneStats());
    check('walls built', stats?.walls > 0, `walls=${stats?.walls}`);
    check('columns built', stats?.columns === 16, `columns=${stats?.columns}`);
    check('bar built', stats?.bar > 0, `bar pieces=${stats?.bar}`);
    check('tables built', stats?.tables === 6, `tables=${stats?.tables}`);
    // Six stools at each of six tables. Seats used to be a disc painted on the
    // floor; they are furniture you cannot walk through now.
    check('seats built', stats?.seats === 36, `seats=${stats?.seats}`);

    const before = await readPosition(pc);
    await pc.keyboard.down('KeyW');
    await sleep(1200);
    await pc.keyboard.up('KeyW');
    await sleep(300);
    const after = await readPosition(pc);
    const moved = before && after ? Math.hypot(after.x - before.x, after.z - before.z) : 0;
    check('W walks the player forward', moved > 1, `moved ${moved.toFixed(2)}m`);

    // Direction, not just displacement. A negated strafe term moves the player
    // exactly as fast and collides exactly the same — it just sends them the
    // wrong way, which no distance-based check would ever notice.
    const facing = await pc.evaluate(() => window.__keydate?.yaw() ?? 0);
    const right = { x: -Math.sin(facing), z: Math.cos(facing) };
    const forward = { x: Math.cos(facing), z: Math.sin(facing) };
    const along = (from, to, axis) => (to.x - from.x) * axis.x + (to.z - from.z) * axis.z;

    const beforeStrafe = await readPosition(pc);
    await pc.keyboard.down('KeyD');
    await sleep(900);
    await pc.keyboard.up('KeyD');
    await sleep(250);
    const afterStrafe = await readPosition(pc);
    check(
      'D strafes right, not left',
      along(beforeStrafe, afterStrafe, right) > 0.5,
      `${along(beforeStrafe, afterStrafe, right).toFixed(2)}m to the right`,
    );

    const beforeBack = await readPosition(pc);
    await pc.keyboard.down('KeyS');
    await sleep(900);
    await pc.keyboard.up('KeyS');
    await sleep(250);
    const afterBack = await readPosition(pc);
    check(
      'S walks backward',
      along(beforeBack, afterBack, forward) < -0.5,
      `${along(beforeBack, afterBack, forward).toFixed(2)}m along facing`,
    );

    await pc.screenshot({ path: path.join(SHOT_DIR, 'desktop-first-person.png') });

    await pc.click('#view-toggle');
    await sleep(600);
    const cameraMode = await pc.evaluate(() => window.__keydate?.viewMode());
    check('camera toggles to third person', cameraMode === 'third-person', `mode=${cameraMode}`);

    /**
     * Top speed reached over a short burst, after turning to face `aim`.
     *
     * Speed rather than distance travelled, which is what this used to measure
     * and what made it flaky twice over. Distance across a fixed wall-clock
     * window is really a measurement of how many simulation ticks the machine
     * found time for — and it silently becomes a measurement of the furniture
     * the moment a run walks into a table, which is what three consecutive
     * runs at the same table did. Peak speed is neither: the simulation caps it
     * at the constant for the movement mode, so it reads the same on a busy
     * machine as an idle one, and re-aiming each burst keeps the player off the
     * woodwork.
     */
    async function topSpeed(keys, aim) {
      await pc.evaluate(aim);
      for (const key of keys) await pc.keyboard.down(key);
      let peak = 0;
      for (let sample = 0; sample < 10; sample += 1) {
        await sleep(50);
        peak = Math.max(peak, await pc.evaluate(() => window.__keydate.speed()));
      }
      for (const key of keys.slice().reverse()) await pc.keyboard.up(key);
      await sleep(200);
      return peak;
    }

    // Shuttled between two targets across the room, so no burst finishes up
    // against the same table the last one stopped at.
    const atTable = () => window.__keydate.aimAtNearestTable('wheel-of-fortune');
    const atBar = () => window.__keydate.aimAtBar();

    const walkSpeed = await topSpeed(['KeyW'], atBar);
    const shiftSpeed = await topSpeed(['ShiftLeft', 'KeyW'], atTable);

    check(
      'Shift sprints',
      shiftSpeed > walkSpeed * 1.3,
      `walk ${walkSpeed.toFixed(2)} vs sprint ${shiftSpeed.toFixed(2)} m/s`,
    );

    // Ctrl is checked at the input controller rather than through movement,
    // because Ctrl+W is the browser's own close-tab chord and synthesising it
    // is asking for trouble that has nothing to do with the game. What "Ctrl
    // sprints" means is that holding it sets the sprint button, and that is
    // exactly what this reads.
    await pc.keyboard.down('ControlLeft');
    await sleep(150);
    const ctrlSprints = await pc.evaluate(() => window.__keydate.sprinting());
    await pc.keyboard.up('ControlLeft');
    await sleep(150);
    const releasedCtrl = await pc.evaluate(() => window.__keydate.sprinting());

    check('Ctrl sets the sprint button, like Shift', ctrlSprints && !releasedCtrl);
    await pc.screenshot({ path: path.join(SHOT_DIR, 'desktop-third-person.png') });

    // ------------------------------------------------------------ mobile
    console.log('\nMobile (Pixel 5, touch)');
    // Landscape. The game asks for it in the manifest and shows a rotate notice
    // in portrait, so a portrait phone would be testing the notice rather than
    // the game — and that notice is itself checked, below.
    const phoneContext = await browser.newContext({
      ...devices['Pixel 5 landscape'],
      // Phones report coarse pointers; the client keys its touch UI off that.
      hasTouch: true,
      isMobile: true,
    });
    const phone = await phoneContext.newPage();
    const phoneErrors = await join(phone, 'PhonePlayer');

    check('phone joins the world', true);
    check('no uncaught page errors on phone', phoneErrors.length === 0, phoneErrors[0]);

    // Landscape is the supported orientation, so the notice must stay out of
    // the way in landscape and cover the screen in portrait.
    check(
      'the rotate notice stays hidden in landscape',
      !(await phone.isVisible('#rotate-notice')),
    );
    await phone.setViewportSize({ width: 393, height: 851 });
    await sleep(400);
    check(
      'turning the phone upright asks the player to rotate it',
      await phone.isVisible('#rotate-notice'),
    );
    await phone.setViewportSize({ width: 851, height: 393 });
    await sleep(400);
    check(
      'turning it back puts the game straight back',
      !(await phone.isVisible('#rotate-notice')),
    );

    const touchVisible = await phone.isVisible('#touch-controls');
    check('touch controls are shown on a coarse pointer', touchVisible);

    // The page must not scroll: a casino floor you can swipe off-screen is unplayable.
    const scrolls = await phone.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    check('page does not scroll horizontally', !scrolls);

    // THE important one. Drag on the left half of the screen and assert the
    // avatar actually moved. This is what a full-screen HUD overlay silently breaks.
    const phoneBefore = await readPosition(phone);
    const size = phone.viewportSize();
    const startX = size.width * 0.25;
    const startY = size.height * 0.6;

    await phone.touchscreen.tap(startX, startY);
    await phone.evaluate(
      ([x, y]) => {
        const canvas = document.getElementById('viewport');
        const touch = (id, cx, cy) =>
          new Touch({ identifier: id, target: canvas, clientX: cx, clientY: cy });
        const fire = (type, touches) =>
          canvas.dispatchEvent(
            new TouchEvent(type, {
              touches,
              changedTouches: touches,
              targetTouches: touches,
              bubbles: true,
              cancelable: true,
            }),
          );
        fire('touchstart', [touch(1, x, y)]);
        // Drag upward: forward on the movement stick.
        fire('touchmove', [touch(1, x, y - 80)]);
      },
      [startX, startY],
    );
    await sleep(1500);
    const phoneAfter = await readPosition(phone);
    const phoneMoved =
      phoneBefore && phoneAfter
        ? Math.hypot(phoneAfter.x - phoneBefore.x, phoneAfter.z - phoneBefore.z)
        : 0;
    check('touch drag walks the player', phoneMoved > 1, `moved ${phoneMoved.toFixed(2)}m`);

    // The element under the middle of the screen must be the canvas, not an
    // invisible overlay — otherwise look-drag never reaches the renderer.
    const topElement = await phone.evaluate(() => {
      const element = document.elementFromPoint(window.innerWidth * 0.75, window.innerHeight * 0.5);
      return element?.id || element?.tagName;
    });
    check(
      'canvas receives touches in the look area',
      topElement === 'viewport',
      `hit=${topElement}`,
    );

    await phone.screenshot({ path: path.join(SHOT_DIR, 'mobile-portrait.png') });

    // Seated, Jump and Use are two large buttons in the bottom-right corner of
    // a phone held sideways — which is exactly where the table panel and the
    // player's own cards are. Neither does anything useful at a table: jumping
    // is refused outright, and Use only stands you up, which the panel's own
    // button already does. So they go away.
    const phoneTable = await walkTowards(
      phone,
      () => window.__keydate?.aimAtNearestTable('roulette'),
      3.2,
    );
    let phoneSeated = false;
    if (phoneTable < 3.4) {
      await phone.tap('#touch-interact');
      await sleep(1500);
      phoneSeated = await phone.evaluate(() => window.__keydate?.seatedAt() !== null);
    }
    check(
      'phone player can sit down with the Use button',
      phoneSeated,
      `${phoneTable.toFixed(2)}m`,
    );
    check(
      'the touch buttons get out of the way once seated',
      !(await phone.isVisible('#touch-controls')),
    );

    // And the panel is what the corner is for now — a tap there has to reach it.
    const seatedHit = await phone.evaluate(() => {
      const panel = document.getElementById('table-panel').getBoundingClientRect();
      const element = document.elementFromPoint(panel.right - 40, panel.bottom - 20);
      return element?.closest('#table-panel') !== null;
    });
    check('the table panel owns that corner while seated', seatedHit);

    await phone.click('#leave-table');
    await sleep(1200);
    check('they come back when the player stands up', await phone.isVisible('#touch-controls'));

    // --------------------------------------------------- two players together
    console.log('\nMultiplayer');
    const seenEachOther = await pc.evaluate(() => window.__keydate?.remoteCount() ?? 0);
    check('desktop client sees the phone player', seenEachOther >= 1, `remotes=${seenEachOther}`);

    // The avatar is a figure, not a bollard: a body, a head and four limbs.
    const avatarParts = await pc.evaluate(() => window.__keydate?.avatarParts());
    check(
      'avatars have a head and limbs, not just a capsule',
      avatarParts >= 8,
      `${avatarParts} parts`,
    );

    // ------------------------------------------------------------ tables
    console.log('\nTables');
    // Walk to the table with real input rather than teleporting: the server is
    // authoritative and would reject a teleport, and walking exercises the
    // whole prediction path on the way.
    // Specifically the wheel: it runs with a single player, so betting opens
    // and a commitment is published. High Card Duel needs two and would sit
    // idle, which looks like a broken table rather than a waiting one.
    const distance = await walkTowards(
      pc,
      () => window.__keydate?.aimAtNearestTable('wheel-of-fortune'),
      3.2,
    );
    check('player can walk to a table', distance < 3.2, `distance ${distance.toFixed(2)}m`);

    await sleep(400);
    const prompt = await pc.isVisible('#interact-prompt');
    check('interact prompt appears near a table', prompt);

    await pc.keyboard.press('KeyE');
    await sleep(1500);
    const tableOpen = await pc.isVisible('#table-panel');
    check('sitting opens the table panel', tableOpen);

    // Sitting must not spin the room, and must not leave the player looking at
    // a wall. What carries over is the angle relative to the table: walk up
    // looking at the felt and you are still looking at it from the seat.
    const facingTable = await pc.evaluate(() => {
      const me = window.__keydate.position();
      const table = window.__keydate.seatedTable();
      if (table === null) return null;
      const toTable = Math.atan2(table.z - me.z, table.x - me.x);
      const delta = Math.atan2(
        Math.sin(window.__keydate.yaw() - toTable),
        Math.cos(window.__keydate.yaw() - toTable),
      );
      return Math.abs(delta);
    });
    check(
      'sitting leaves the player looking at the table',
      facingTable !== null && facingTable < 0.5,
      `${((facingTable ?? Math.PI) * 57.3).toFixed(0)}° off the table`,
    );

    const fairness = await pc.textContent('#fairness');
    check(
      'commitment is published before betting',
      fairness && fairness.includes('commitment'),
      fairness?.slice(0, 60),
    );

    await pc.screenshot({ path: path.join(SHOT_DIR, 'desktop-table.png') });

    const chipsBefore = await pc.textContent('#chips-value');
    await pc.click('.spot[data-spot-id="x2"]');
    await sleep(800);
    const chipsAfter = await pc.textContent('#chips-value');
    check(
      'placing a bet debits chips',
      chipsBefore !== chipsAfter,
      `${chipsBefore} -> ${chipsAfter}`,
    );

    // ---------------------------------------------------------- blackjack
    // The only game with a decision phase, and the only part of the client that
    // has to react to the server saying "it is your turn". Headless tests cover
    // the rules; what they cannot see is an action panel that never renders, or
    // buttons wired to a message the server rejects.
    console.log('\nBlackjack');
    await pc.click('#leave-table');
    await sleep(400);

    const bjDistance = await walkTowards(
      pc,
      () => window.__keydate?.aimAtNearestTable('blackjack'),
      3.2,
    );
    check(
      'player can walk to a blackjack table',
      bjDistance < 3.2,
      `distance ${bjDistance.toFixed(2)}m`,
    );

    await pc.keyboard.press('KeyE');
    await sleep(1200);
    check('sitting at blackjack opens the table panel', await pc.isVisible('#table-panel'));

    const bjTitle = await pc.textContent('#table-title');
    check(
      'the panel is labelled from the server, not a lookup table',
      bjTitle === 'Blackjack',
      `title=${bjTitle}`,
    );

    const anteVisible = await pc.isVisible('.spot[data-spot-id="box-1"]');
    check('blackjack offers its bet spot', anteVisible);

    // The panel is a bar along the foot of the screen, and has to stay one.
    //
    // Asserted as a shape rather than only as an area, because the ways it goes
    // wrong are shape problems: a control that wraps, or a row of six hands that
    // grows instead of scrolling, adds height without ever coming near a
    // quarter of the screen — and height is exactly what covers the table.
    const bar = await pc.evaluate(() => {
      const panel = document.getElementById('table-panel').getBoundingClientRect();
      return {
        widthShare: panel.width / window.innerWidth,
        heightShare: panel.height / window.innerHeight,
        share: (panel.width * panel.height) / (window.innerWidth * window.innerHeight),
        bottomGap: window.innerHeight - panel.bottom,
      };
    });
    check(
      'the table panel is a bar, not a column — it spans the width',
      bar.widthShare > 0.9,
      `${(bar.widthShare * 100).toFixed(0)}% of the width`,
    );
    check(
      'and it is slim — a strip of the height, not a slab of it',
      bar.heightShare > 0 && bar.heightShare < 0.15,
      `${(bar.heightShare * 100).toFixed(0)}% of the height`,
    );
    check(
      'the table panel leaves most of the view clear',
      bar.share > 0 && bar.share < 0.15,
      `${(bar.share * 100).toFixed(0)}% of the screen`,
    );
    check('it sits against the foot of the screen', bar.bottomGap < 40, `${bar.bottomGap}px clear`);

    // The bet box: any integer from the table minimum to the whole stack.
    const limits = await pc.evaluate(() => {
      const input = document.getElementById('stake-input');
      return {
        min: input.min,
        max: input.max,
        text: document.getElementById('stake-limits').textContent,
      };
    });
    const bankroll = Number((await pc.textContent('#chips-value')).replace(/[^0-9]/g, ''));
    check('the bet box floors at the table minimum', limits.min === '10', `min=${limits.min}`);
    check(
      'the bet box tops out at what the player actually holds',
      Number(limits.max) === bankroll,
      `max=${limits.max} chips=${bankroll}`,
    );

    // Nothing should happen on its own: this table waits to be asked.
    check(
      'no betting clock is shown before the deal is called',
      await pc.evaluate(() => document.getElementById('table-timer-bar').style.width === '0%'),
    );
    check(
      'the deal button refuses to arm without a bet',
      await pc.evaluate(() => document.getElementById('deal-button').disabled === true),
    );

    // Type an amount rather than picking one off a fixed list.
    await pc.fill('#stake-input', '137');
    await pc.press('#stake-input', 'Enter');
    await sleep(200);

    // The chip ladder itself, exercised over every amount a player could bet
    // rather than only the one this run happens to use.
    const ladder = await pc.evaluate(async () => {
      const { chipBreakdown, DENOMINATIONS } = await import('./js/chips3d.js');
      let exact = true;
      let mostChips = 0;
      for (let amount = 1; amount <= 3000; amount += 1) {
        const chips = chipBreakdown(amount);
        const total = chips.reduce((sum, chip) => sum + chip.value, 0);
        if (total !== amount) exact = false;
        mostChips = Math.max(mostChips, chips.length);
      }
      return {
        exact,
        mostChips,
        colours: DENOMINATIONS.map((d) => `${d.value}:${d.name}`).join(','),
        sample: chipBreakdown(1630)
          .map((d) => d.name)
          .join('+'),
      };
    });
    check('every bet breaks into chips that add up exactly', ladder.exact);
    check(
      'the chip colours are the standard ones',
      ladder.colours === '1000:gold,500:purple,100:black,25:green,5:red,1:white',
      ladder.colours,
    );
    check(
      'a large bet is a handful of chips, not a tower',
      ladder.mostChips <= 20,
      `worst case ${ladder.mostChips} chips`,
    );
    check(
      'chips are picked largest first',
      ladder.sample === 'gold+500' || ladder.sample.startsWith('gold'),
      `1630 = ${ladder.sample}`,
    );

    // Three boxes on the felt, so a player can take more than one hand.
    const boxSpots = await pc.evaluate(() =>
      [...document.querySelectorAll('#table-spots .spot')].map((spot) => spot.dataset.spotId),
    );
    check(
      'blackjack offers three boxes',
      boxSpots.join(',') === 'box-1,box-2,box-3',
      `spots=${boxSpots.join(',')}`,
    );

    const bjChipsBefore = await pc.textContent('#chips-value');
    await pc.click('.spot[data-spot-id="box-1"]');
    await sleep(700);
    const bjChipsAfter = await pc.textContent('#chips-value');
    const staked =
      Number(bjChipsBefore.replace(/[^0-9]/g, '')) - Number(bjChipsAfter.replace(/[^0-9]/g, ''));
    check('a typed bet is staked exactly as typed', staked === 137, `staked=${staked}`);

    // Chips on the felt: 137 is one black, one green, two red and two white.
    const feltChips = await pc.evaluate(() => window.__keydate?.feltChips());
    check('the bet is shown as chips on the felt', feltChips === 6, `chips=${feltChips}`);

    // Playing two hands means at least twice the minimum on each of them, so a
    // box opened at the single-box minimum is refused — with the number needed.
    const beforeRefusal = await pc.textContent('#chips-value');
    await pc.fill('#stake-input', '10');
    await pc.press('#stake-input', 'Enter');
    await pc.click('.spot[data-spot-id="box-2"]');
    await sleep(700);
    const notice = await pc.textContent('#table-notice');
    check(
      'a second box under twice the minimum is refused',
      /2 boxes needs 20 on each/.test(notice ?? ''),
      notice ?? '(no notice)',
    );
    check(
      'and nothing is taken for a refused bet',
      (await pc.textContent('#chips-value')) === beforeRefusal,
      `${beforeRefusal} -> ${await pc.textContent('#chips-value')}`,
    );

    // At twice the minimum it is accepted.
    await pc.fill('#stake-input', '25');
    await pc.press('#stake-input', 'Enter');
    await pc.click('.spot[data-spot-id="box-2"]');
    await sleep(700);
    const twoBoxStaked =
      Number(bjChipsBefore.replace(/[^0-9]/g, '')) -
      Number((await pc.textContent('#chips-value')).replace(/[^0-9]/g, ''));
    check('a second box costs a second bet', twoBoxStaked === 162, `staked=${twoBoxStaked}`);
    check(
      'the second bet gets its own chips',
      (await pc.evaluate(() => window.__keydate?.feltChips())) === 7,
      `chips=${await pc.evaluate(() => window.__keydate?.feltChips())}`,
    );

    // Ten seconds is a long time to leave a table idle if the deal never comes,
    // so prove it does not come on its own before pressing the button.
    await sleep(4_000);
    check(
      'the cards stay in the shoe until the deal is called',
      !(await pc.isVisible('#table-hand')),
    );

    check(
      'the deal button arms once a bet is down',
      await pc.evaluate(() => document.getElementById('deal-button').disabled === false),
    );

    await pc.click('#deal-button');
    await sleep(500);
    const lastCall = await pc.textContent('#deal-button');
    check('calling the deal starts a last call', /last call/i.test(lastCall ?? ''), lastCall);

    // The whole point of the ten seconds: everyone else can still get a bet down.
    check(
      'betting stays open during the last call',
      await pc.evaluate(
        () => document.querySelector('.spot[data-spot-id="box-1"]').disabled === false,
      ),
    );

    let dealt = false;
    for (let attempt = 0; attempt < 140; attempt += 1) {
      await sleep(150);
      if (await pc.isVisible('#table-hand')) {
        dealt = true;
        break;
      }
    }
    check('the hand is dealt once the last call runs out', dealt);

    // Sampled first and fast, because a deal is over in under a second and
    // everything else in this section takes longer than that to check.
    const felt = await pc.evaluate(() => window.__keydate?.feltCards());
    let sawFlight = felt?.dealing === true;
    for (let attempt = 0; attempt < 14 && !sawFlight; attempt += 1) {
      await sleep(60);
      sawFlight = (await pc.evaluate(() => window.__keydate?.feltCards().dealing)) === true;
    }

    /**
     * Waits for a dealt hand to either hand us a turn or resolve on its own.
     *
     * Reads the whole hand in the same evaluate that spots the turn. Checking
     * "is it my turn" and then reading the cards as two separate round trips
     * lets the fifteen-second decision clock expire in between, and the second
     * read comes back empty.
     *
     * "Resolved" is not only "a result is on screen". The result is shown for
     * six seconds and then the table opens the next round and clears it, so a
     * hand that ends without a decision — a dealer natural, which is one in
     * twenty — can be over and forgotten before this is even called. That used
     * to report `stuck`, because an on-demand table then sits in betting
     * forever waiting to be asked, and nothing ever appears. The phase is the
     * reliable signal: back in `betting` or `idle` after the cards were out
     * means the round finished, whether or not its result is still up.
     */
    async function awaitTurnOrResult() {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const seen = await pc.evaluate(() => {
          const phase = document.getElementById('table-phase').dataset.phase;
          const actions = [...document.querySelectorAll('#hand-actions .hand-action')].map(
            (button) => button.dataset.actionId,
          );
          if (actions.length === 0) {
            const shown = document.getElementById('table-result');
            return { phase, over: !shown.hidden || phase === 'betting' || phase === 'idle' };
          }
          return {
            actions,
            phase: document.getElementById('table-phase').textContent,
            dealerCards: document.querySelectorAll('#hand-dealer .card').length,
            facedown: document.querySelectorAll('#hand-dealer .card.facedown').length,
            mine: document.querySelectorAll('#hand-seats .hand-row.mine .card').length,
            myHands: document.querySelectorAll('#hand-seats .hand-row.mine').length,
          };
        });
        if (seen.actions !== undefined) return { kind: 'turn', live: seen };
        if (seen.over) return { kind: 'resolved' };
        await sleep(300);
      }
      return { kind: 'stuck' };
    }

    /** Bets and calls the deal once the table is taking bets again. */
    async function betAndDeal(amount, boxes = ['box-1', 'box-2']) {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const open = await pc.evaluate(
          () => document.querySelector('.spot[data-spot-id="box-1"]')?.disabled === false,
        );
        if (open) break;
        await sleep(500);
      }
      await pc.fill('#stake-input', String(amount));
      await pc.press('#stake-input', 'Enter');
      for (const box of boxes) await pc.click(`.spot[data-spot-id="${box}"]`);
      await sleep(400);
      await pc.click('#deal-button');
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await sleep(500);
        if (await pc.evaluate(() => document.querySelectorAll('#table-hand .card').length > 0)) {
          return true;
        }
      }
      return false;
    }

    // The deal animation. Asserted as "the cards were animated in", not by
    // watching pixels: what breaks in practice is a card element rebuilt every
    // frame (animating forever) or never given the class at all.
    const animated = await pc.evaluate(() => {
      const cards = [...document.querySelectorAll('#table-hand .card')];
      return {
        total: cards.length,
        dealing: cards.filter((card) => card.classList.contains('dealing')).length,
        staggered: new Set(cards.map((card) => card.style.animationDelay)).size,
      };
    });
    check(
      'every dealt card is animated in',
      animated.dealing === animated.total && animated.total >= 4,
      `${animated.dealing}/${animated.total} animated`,
    );
    check(
      'the cards are staggered rather than landing together',
      animated.staggered > 1,
      `${animated.staggered} distinct delays`,
    );

    // Cards must survive the 5Hz table refresh. If the rows were rebuilt each
    // time, these elements would be different objects a moment later — and the
    // animation would restart on every one.
    const cardIdentity = await pc.evaluate(() => {
      const first = document.querySelector('#hand-seats .card');
      window.__cardProbe = first;
      return first?.textContent ?? null;
    });
    await sleep(1_200);
    const cardStable = await pc.evaluate(
      () => window.__cardProbe === document.querySelector('#hand-seats .card'),
    );
    check('dealt cards are not rebuilt on every table update', cardStable, `card=${cardIdentity}`);

    // The cards on the actual table, not the panel. This is the check that would
    // have caught the first version of this feature, where the panel animated
    // beautifully and the felt in the world stayed bare.
    const settledFelt = await (async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const now = await pc.evaluate(() => window.__keydate?.feltCards());
        if (now?.dealing === false) return now;
        await sleep(150);
      }
      return null;
    })();
    check(
      'cards are dealt onto the table in the world',
      (settledFelt?.count ?? 0) >= 4,
      `${settledFelt?.count} card meshes on the felt`,
    );
    // If the deal were instant this would never be true, and if the meshes were
    // rebuilt on every table update it would never stop being true.
    check('the cards fly across the table rather than appearing', sawFlight);
    check('every card finishes its flight and settles', settledFelt !== null);

    await pc.screenshot({ path: path.join(SHOT_DIR, 'desktop-blackjack.png') });

    // About one hand in ten is a natural — the player's or the dealer's — and a
    // natural is settled before anybody gets a turn. That is correct blackjack,
    // so the test plays on until it draws a hand that actually needs deciding
    // rather than asserting that a decision phase always happens.
    let outcome = await awaitTurnOrResult();
    let hands = 1;
    while (outcome.kind === 'resolved' && hands < 5) {
      hands += 1;
      if (!(await betAndDeal(50))) break;
      outcome = await awaitTurnOrResult();
    }
    check(
      'a hand needing a decision is reached',
      outcome.kind === 'turn',
      `${hands} hand(s), ended ${outcome.kind}`,
    );

    const live = outcome.live ?? { dealerCards: 0, facedown: 0, mine: 0, actions: [] };
    check('the dealer shows two cards', live.dealerCards === 2, `cards=${live.dealerCards}`);
    check(
      'both boxes are dealt their own hand',
      live.myHands === 2,
      `${live.myHands} hands for one player`,
    );
    check('one dealer card is face down', live.facedown === 1, `facedown=${live.facedown}`);
    check('the player is dealt at least two cards', live.mine >= 2, `cards=${live.mine}`);
    check(
      'the table offers hit, stand and double',
      live.actions.includes('hit') && live.actions.includes('stand'),
      `actions=${live.actions.join(',')}`,
    );

    // Standing has to actually end the turn — a button that sends a message the
    // server rejects looks identical from the outside until you check this.
    // With two boxes in play it takes two: the turn passes to the next box
    // rather than to the dealer.
    let handOver = false;
    for (let attempt = 0; attempt < 40 && !handOver; attempt += 1) {
      const standing = await pc.$('.hand-action[data-action-id="stand"]');
      if (standing !== null) {
        await standing.click().catch(() => {});
      }
      await sleep(400);
      handOver = await pc.evaluate(
        () => document.querySelectorAll('#hand-actions button').length === 0,
      );
    }
    check('standing works through every box in play', handOver);

    // The end of the round, read in one go the moment it lands.
    //
    // The hand ending is not the round ending: the table plays the dealer out
    // for the camera first. And the round ending is not the end of the story
    // either — six seconds later the next round opens and clears both the
    // result and the fairness line. Reading them one after another can catch
    // the first and miss the second, so all three of the checks below come out
    // of a single snapshot taken while the payout is still on screen.
    const settled = await waitFor(
      pc,
      () => {
        const result = document.getElementById('table-result');
        if (result.hidden) return null;
        return {
          result: result.textContent,
          fairness: document.getElementById('fairness').textContent,
          dealerShown: document.querySelectorAll('#hand-dealer .card').length,
          dealerFacedown: document.querySelectorAll('#hand-dealer .card.facedown').length,
        };
      },
      20_000,
    );

    check('the hand reports a result', settled !== null, settled?.result?.slice(0, 60));

    // The dealer's hole card is the one thing kept back all hand. It has to be
    // turned over where the player can see it, not folded into a summary line.
    check(
      'the dealer turns the hole card over on screen',
      settled !== null && settled.dealerFacedown === 0 && settled.dealerShown >= 2,
      settled === null ? '' : `${settled.dealerShown} up, ${settled.dealerFacedown} down`,
    );

    check(
      'the interactive round verifies against its commitment',
      Boolean(settled?.fairness?.includes('Verified')),
      settled?.fairness?.slice(0, 70),
    );

    // ------------------------------------------------------------ insurance
    //
    // Insurance is a spot with real chips on the felt, but not one anybody bets
    // on before the deal: the table offers it against the dealer's upcard once
    // the cards are out. Both halves of that are deterministic and checked
    // here — no button, and no way round the missing button either.
    //
    // The live offer needs a dealer ace, which is one hand in thirteen. Waiting
    // for one would add ten minutes to this suite for a worse test than the
    // deterministic ones in `blackjack.test.ts`, so what happens below is
    // opportunistic: if an ace turns up while hunting for a pair, the whole
    // path gets exercised, and if it does not, nothing is claimed.
    const spotButtons = await pc.evaluate(() =>
      [...document.querySelectorAll('#table-spots .spot')].map((button) => button.dataset.spotId),
    );
    const spotsOffered = await pc.evaluate(() => window.__keydate?.tableSpots?.() ?? []);
    check(
      'the table publishes insurance as a spot',
      spotsOffered.includes('insurance'),
      spotsOffered.join(','),
    );
    check(
      'but never as a bet you can place',
      !spotButtons.includes('insurance'),
      spotButtons.join(','),
    );

    // And the missing button is not the only thing stopping you: a modified
    // client that sends the wager anyway is refused by the server.
    const chipsBeforeCheat = await pc.evaluate(() =>
      Number(document.getElementById('chips-value').textContent.replace(/[^0-9]/g, '')),
    );
    await pc.evaluate(() =>
      window.__keydate.send({ type: 'table:wager', spotId: 'insurance', amount: 50 }),
    );
    const refusal = await waitFor(pc, () => {
      const notice = document.getElementById('table-notice');
      return notice.hidden ? null : notice.textContent;
    });
    const chipsAfterCheat = await pc.evaluate(() =>
      Number(document.getElementById('chips-value').textContent.replace(/[^0-9]/g, '')),
    );
    check(
      'the server refuses an insurance bet sent straight at it',
      refusal !== null,
      refusal ?? 'no refusal came back',
    );
    check(
      'and takes nothing for it',
      chipsAfterCheat === chipsBeforeCheat,
      `${chipsBeforeCheat} -> ${chipsAfterCheat}`,
    );

    // ------------------------------------------------- splitting and folding
    //
    // Neither move comes up on demand: a split needs a pair, and surrender is
    // only offered on an untouched first decision. So the test deals hand after
    // hand and takes whichever of the two the table offers, rather than
    // asserting that a particular shoe produces one.
    //
    // What it is really checking is the end-to-end path — that the button the
    // server offers is a button the player can press and that the table accepts
    // it. A rule can be right in `blackjack.ts` and still be unreachable.
    //
    // Three boxes rather than one, and **every** decision inspected rather than
    // only the first. That second part is the whole reliability of this loop:
    // about one hand in seven is splittable, so three boxes should be three
    // chances a deal — but looking only at the opening decision means only box
    // one is ever examined, and the other two are stood on unseen. That is a
    // 15% chance of finding no pair in twelve deals, and it duly found none.
    const played = { insure: null, split: null, surrender: null };
    let handsDealt = 0;
    let decisions = 0;

    for (let hand = 0; hand < 12; hand += 1) {
      if (played.split !== null && played.surrender !== null) break;
      if (!(await betAndDeal(50, ['box-1', 'box-2', 'box-3']))) break;
      handsDealt += 1;

      // Walk the hand decision by decision to the end of the round.
      for (let step = 0; step < 40; step += 1) {
        const turn = await awaitTurnOrResult();
        if (turn.kind !== 'turn') break;
        decisions += 1;

        // Take whichever is still wanted. Insurance first, because it is the
        // rarest and has to be answered before anything else can be; a split is
        // the rarer of the remaining two.
        const wanted = ['insure', 'split', 'surrender'].find(
          (id) => played[id] === null && turn.live.actions.includes(id),
        );

        if (wanted !== undefined) {
          const chipsBefore = await pc.evaluate(() =>
            Number(document.getElementById('chips-value').textContent.replace(/[^0-9]/g, '')),
          );
          const handsBefore = turn.live.myHands;
          await pc.click(`.hand-action[data-action-id="${wanted}"]`).catch(() => {});
          await sleep(900);

          played[wanted] = await pc.evaluate(
            (before) => ({
              chips: Number(
                document.getElementById('chips-value').textContent.replace(/[^0-9]/g, ''),
              ),
              chipsBefore: before,
              rows: document.querySelectorAll('#hand-seats .hand-row.mine').length,
              felt: window.__keydate?.feltCards()?.count ?? 0,
              chipStacks: window.__keydate?.feltChips() ?? 0,
              notice: document.getElementById('table-notice').hidden
                ? ''
                : document.getElementById('table-notice').textContent,
            }),
            chipsBefore,
          );
          played[wanted].handsBefore = handsBefore;
          played[wanted].phaseBefore = turn.live.phase;
          continue;
        }

        // Nothing wanted here: take the least committal legal move and move on.
        // `decline` is for the insurance round, where a bare `stand` is not on
        // offer until every seat has answered.
        const fallback =
          ['stand', 'decline'].find((id) => turn.live.actions.includes(id)) ?? turn.live.actions[0];
        if (fallback === undefined) break;
        await pc.click(`.hand-action[data-action-id="${fallback}"]`).catch(() => {});
        await sleep(350);
      }

      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (await pc.isVisible('#table-result')) break;
        await sleep(400);
      }
    }

    // Opportunistic, for the reasons given above: a dealer ace is one hand in
    // thirteen, so this reports what it saw rather than demanding one.
    if (played.insure === null) {
      console.log('  --   no dealer ace came up; insurance play not exercised this run');
    } else {
      check(
        'the insurance round names itself in the panel',
        played.insure.phaseBefore.startsWith('Insurance?'),
        played.insure.phaseBefore,
      );
      check('the table accepts the insurance', played.insure.notice === '', played.insure.notice);
      check(
        'insurance costs half the stake',
        played.insure.chips === played.insure.chipsBefore - 25,
        `${played.insure.chipsBefore} -> ${played.insure.chips}`,
      );
      check(
        'the insurance chips go onto the felt',
        played.insure.chipStacks > 0,
        `${played.insure.chipStacks} stacks`,
      );
    }

    check(
      'a splittable pair comes up and the split is offered',
      played.split !== null,
      played.split === null
        ? `no pair across ${handsDealt} deals and ${decisions} decisions`
        : `${played.split.handsBefore} hand(s) before`,
    );
    if (played.split !== null) {
      check('the table accepts the split', played.split.notice === '', played.split.notice);
      check(
        'splitting turns one hand into two',
        played.split.rows > played.split.handsBefore,
        `${played.split.handsBefore} -> ${played.split.rows} rows`,
      );
      check(
        'the second hand costs a second stake',
        played.split.chips === played.split.chipsBefore - 50,
        `${played.split.chipsBefore} -> ${played.split.chips}`,
      );
      check(
        'both halves are dealt onto the felt',
        played.split.felt >= 6,
        `${played.split.felt} cards on the table`,
      );
    }

    check('surrender is offered on a fresh hand', played.surrender !== null);
    if (played.surrender !== null) {
      check(
        'the table accepts the surrender',
        played.surrender.notice === '',
        played.surrender.notice,
      );
      check(
        'surrendering costs nothing to declare',
        played.surrender.chips === played.surrender.chipsBefore,
        `${played.surrender.chipsBefore} -> ${played.surrender.chips}`,
      );
    }

    // ------------------------------------------------------------------ bar
    // The whole premise in one pass: walk to the bar, buy a drink, confirm it
    // costs chips and that the screen actually goes blurry.
    console.log('\nBar');
    await pc.click('#leave-table');
    await sleep(400);

    const barDistance = await walkTowards(pc, () => window.__keydate?.aimAtBar(), 2.0);
    check('player can walk to the bar', barDistance < 2.0, `distance ${barDistance.toFixed(2)}m`);

    // Pressing E is a round trip: the server checks the range against its own
    // copy of the position and sends the menu back. Waited for rather than
    // slept through, because on a loaded machine 800ms is not always enough and
    // the failure looks exactly like a broken bar.
    await pc.keyboard.press('KeyE');
    const menuOpened = await waitFor(pc, () => !document.getElementById('bar-panel').hidden);
    check('the bar menu opens', menuOpened === true);

    const chipsBeforeDrink = await pc.textContent('#chips-value');
    const soberBlur = await pc.evaluate(
      () => document.getElementById('viewport').style.filter || '',
    );
    check('vision is clear while sober', soberBlur === '', `filter="${soberBlur}"`);

    await pc.click('.drink[data-drink-id="whiskey"]');
    await sleep(900);

    const chipsAfterDrink = await pc.textContent('#chips-value');
    check(
      'a drink costs chips',
      chipsBeforeDrink !== chipsAfterDrink,
      `${chipsBeforeDrink} -> ${chipsAfterDrink}`,
    );

    const drunkLevel = await pc.evaluate(() => window.__keydate?.drunkenness());
    check('drinking makes you drunk', drunkLevel > 0, `drunkenness=${drunkLevel?.toFixed(2)}`);

    const drunkBlur = await pc.evaluate(
      () => document.getElementById('viewport').style.filter || '',
    );
    check('vision blurs once drunk', drunkBlur.includes('blur('), `filter="${drunkBlur}"`);
    check('the drunk meter is shown', await pc.isVisible('#drunk-row'));

    await pc.screenshot({ path: path.join(SHOT_DIR, 'bar-drunk.png') });

    // ------------------------------------------------- packaged app payload
    // Proves the scenario every native wrapper is in: the page loads from a
    // local origin with no server behind it, and reaches the world server only
    // because an endpoint was baked in at bundle time.
    console.log('\nPackaged client (served from a different origin)');

    // Both live pages are done being played by now, and this container renders
    // WebGL in software. A third page competing with two running render loops —
    // one of them applying a full-screen blur every frame, because that player
    // is drunk — takes longer to build its world than the join is willing to
    // wait, and the packaged check fails for a reason that has nothing to do
    // with packaging. Their error logs are already captured and are asserted
    // below, so closing them here costs the run nothing.
    await desktop.close();
    await phoneContext.close();
    // Bundle fresh, pointed at this test's server, so the check proves the real
    // wiring rather than whatever endpoint a previous manual bundle used.
    const bundleDir = path.join(SHOT_DIR, 'bundle');
    const bundled = await runBundler(bundleDir, `ws://127.0.0.1:${PORT}/${SLUG}`);
    check('bundler produces a client payload', bundled);

    if (!bundled) {
      console.log('  skip  bundling failed');
    } else {
      const staticPort = PORT + 1;
      const staticServer = await serveDirectory(bundleDir, staticPort);
      try {
        const appContext = await browser.newContext({ viewport: { width: 900, height: 600 } });
        const app = await appContext.newPage();
        const appErrors = [];
        app.on('pageerror', (error) => appErrors.push(String(error)));

        await app.goto(`http://127.0.0.1:${staticPort}/`, { waitUntil: 'domcontentloaded' });

        const endpoint = await app.evaluate(() => window.KEYDATE_SERVER_URL);
        check('bundle has a server endpoint baked in', Boolean(endpoint), `endpoint=${endpoint}`);

        await app.fill('#name-input', 'AppPlayer');
        await app.click('#join-button');
        await app.waitForSelector('#join-screen', { state: 'hidden', timeout: 15_000 });

        check('packaged client connects to a server on another origin', true);
        const appChips = await app.textContent('#chips-value');
        check('packaged client is in the world', appChips && appChips !== '0', `chips=${appChips}`);
        check('no page errors in the packaged client', appErrors.length === 0, appErrors[0]);

        await app.screenshot({ path: path.join(SHOT_DIR, 'packaged-client.png') });
        await appContext.close();
      } finally {
        staticServer.close();
      }
    }

    // Re-check errors at the end, not just after load. A render loop that
    // throws every frame still loads cleanly — checking only at startup is how
    // a completely broken third-person camera passed as healthy.
    console.log('\nRuntime health');
    check('no page errors accumulated during play', pcErrors.length === 0, pcErrors[0]);
    check('no page errors on the phone during play', phoneErrors.length === 0, phoneErrors[0]);

    console.log(`\nScreenshots written to ${SHOT_DIR}`);
  } finally {
    await browser.close();
    server.kill();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll client smoke checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
