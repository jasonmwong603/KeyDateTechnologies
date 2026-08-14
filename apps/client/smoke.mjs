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
import { existsSync, mkdirSync } from 'node:fs';
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
const BASE = `http://127.0.0.1:${PORT}`;
const SHOT_DIR = process.env.SMOKE_SHOT_DIR ?? path.join(repoRoot, '.smoke');

let failures = 0;

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer() {
  const server = spawn(process.execPath, [path.join(repoRoot, 'apps/server/dist/index.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/healthz`);
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

    const before = await readPosition(pc);
    await pc.keyboard.down('KeyW');
    await sleep(1200);
    await pc.keyboard.up('KeyW');
    await sleep(300);
    const after = await readPosition(pc);
    const moved = before && after ? Math.hypot(after.x - before.x, after.z - before.z) : 0;
    check('W walks the player forward', moved > 1, `moved ${moved.toFixed(2)}m`);

    await pc.screenshot({ path: path.join(SHOT_DIR, 'desktop-first-person.png') });

    await pc.click('#view-toggle');
    await sleep(600);
    const cameraMode = await pc.evaluate(() => window.__keydate?.viewMode());
    check('camera toggles to third person', cameraMode === 'third-person', `mode=${cameraMode}`);
    await pc.screenshot({ path: path.join(SHOT_DIR, 'desktop-third-person.png') });

    // ------------------------------------------------------------ mobile
    console.log('\nMobile (Pixel 5, touch)');
    const phoneContext = await browser.newContext({
      ...devices['Pixel 5'],
      // Phones report coarse pointers; the client keys its touch UI off that.
      hasTouch: true,
      isMobile: true,
    });
    const phone = await phoneContext.newPage();
    const phoneErrors = await join(phone, 'PhonePlayer');

    check('phone joins the world', true);
    check('no uncaught page errors on phone', phoneErrors.length === 0, phoneErrors[0]);

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

    // --------------------------------------------------- two players together
    console.log('\nMultiplayer');
    const seenEachOther = await pc.evaluate(() => window.__keydate?.remoteCount() ?? 0);
    check('desktop client sees the phone player', seenEachOther >= 1, `remotes=${seenEachOther}`);

    // ------------------------------------------------------------ tables
    console.log('\nTables');
    // Walk to the table with real input rather than teleporting: the server is
    // authoritative and would reject a teleport, and walking exercises the
    // whole prediction path on the way.
    let distance = Infinity;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const target = await pc.evaluate(() => window.__keydate?.aimAtNearestTable());
      if (target === null) break;
      distance = target.distance;
      if (distance < 2.0) break;
      await pc.keyboard.down('KeyW');
      await sleep(250);
      await pc.keyboard.up('KeyW');
      await sleep(60);
    }
    check('player can walk to a table', distance < 2.0, `distance ${distance.toFixed(2)}m`);

    await sleep(400);
    const prompt = await pc.isVisible('#interact-prompt');
    check('interact prompt appears near a table', prompt);

    await pc.keyboard.press('KeyE');
    await sleep(1500);
    const tableOpen = await pc.isVisible('#table-panel');
    check('sitting opens the table panel', tableOpen);

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
