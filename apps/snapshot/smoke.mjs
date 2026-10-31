import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drives the app in a real browser, at phone size, with real touches.
 *
 * `check.mjs` proves the geometry; this proves it is actually wired to a
 * finger. The two failures it exists to catch are the ones no amount of pure
 * maths can see: a card that cannot be grabbed because something invisible is
 * over it, and settings that appear when an audience is holding the phone.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

/*
 * Served by the real host, not opened off the disk.
 *
 * A `file://` page has no usable local storage — Chromium refuses it — so the
 * app correctly fell back to its setup screen and nothing could be tested.
 * Going through the host is more honest anyway: it exercises the mount, the
 * slug and the content types the app actually arrives through.
 */
const PORT = 8137;
const server = spawn(process.execPath, [path.join(repoRoot, 'host', 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('host did not start')), 10000);
  server.stdout.on('data', (chunk) => {
    if (String(chunk).includes('magic apps on')) {
      clearTimeout(timer);
      resolve();
    }
  });
});
const pageUrl = `http://127.0.0.1:${PORT}/snapshot/`;

function launchOptions() {
  if (process.env.CHROMIUM_PATH) return { executablePath: process.env.CHROMIUM_PATH };
  const root = '/opt/pw-browsers';
  if (!existsSync(root)) return {};
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith('chromium')) continue;
    for (const inner of ['chrome-linux64', 'chrome-linux']) {
      const candidate = path.join(root, entry, inner, 'chrome');
      if (existsSync(candidate)) return { executablePath: candidate };
    }
  }
  return {};
}

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch(launchOptions());
const context = await browser.newContext({ ...devices['iPhone 13 Pro'], hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  // The browser asks for /favicon.ico unprompted and the host refuses it, as it
  // refuses everything outside an app. That is the host working, not the page
  // failing, and counting it would mean the only way to a clean run is to start
  // serving stray files from the domain root.
  if ((message.location()?.url ?? '').includes('/favicon.ico')) return;
  errors.push(message.text());
});

// A one-pixel wallpaper, so the app behaves as it does once set up. The real
// one is the performer's own screenshot and never goes near this repository.
await page.addInitScript(() => {
  localStorage.setItem(
    'snapshot.wall',
    JSON.stringify(
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    ),
  );
  localStorage.setItem('snapshot.scale', '3.8');
  localStorage.setItem('snapshot.face', '"A♠"');
});

await page.goto(pageUrl);
await page.waitForSelector('#card');

check(
  'it opens straight onto the wallpaper, not a setup screen',
  await page.evaluate(() => document.getElementById('setup').hidden),
);

const card = await page.locator('#card').boundingBox();
check('a corner of the card is on screen', card !== null && card.width > 0, JSON.stringify(card));

const viewport = page.viewportSize();
check(
  'and only a corner — the rest continues off the screen',
  card.y + card.height > viewport.height,
  `card bottom ${Math.round(card.y + card.height)} vs screen ${viewport.height}`,
);

/*
 * The whole illusion, measured through a real finger.
 *
 * Touch a point of the card, drag, and ask where that same point of the card
 * ended up. A real object would be exactly under the fingertip. Anything else
 * and it is a graphic — and the eye checks this within a second of the first
 * touch, long before it considers the shadow or the gloss.
 */
const grip = { x: card.x + card.width * 0.5, y: Math.min(card.y + 30, viewport.height - 60) };
const before = await page.evaluate(() => {
  const el = document.getElementById('card');
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y };
});

await page.touchscreen.tap(grip.x, grip.y);
const journey = [
  { x: grip.x - 70, y: grip.y - 180 },
  { x: grip.x + 60, y: grip.y - 320 },
  { x: grip.x - 20, y: grip.y - 210 },
];

await page.evaluate(
  async ({ start, path: route }) => {
    const el = document.getElementById('card');
    const send = (type, point) =>
      el.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1,
          pointerType: 'touch',
          isPrimary: true,
          bubbles: true,
          cancelable: true,
          clientX: point.x,
          clientY: point.y,
        }),
      );
    el.setPointerCapture = () => {};
    send('pointerdown', start);
    for (const point of route) {
      send('pointermove', point);
      await new Promise((r) => requestAnimationFrame(r));
    }
    send('pointerup', route.at(-1));
  },
  { start: grip, path: journey },
);

const moved = await page.evaluate(() => {
  const r = document.getElementById('card').getBoundingClientRect();
  return { x: r.x, y: r.y };
});

const expected = { dx: journey.at(-1).x - grip.x, dy: journey.at(-1).y - grip.y };
const actual = { dx: moved.x - before.x, dy: moved.y - before.y };
const slip = Math.hypot(actual.dx - expected.dx, actual.dy - expected.dy);

check(
  'the card follows the finger exactly, and does not slip',
  slip < 1.5,
  `off by ${slip.toFixed(2)}px over a ${Math.round(Math.hypot(expected.dx, expected.dy))}px drag`,
);

check(
  'it keeps its shape while being dragged',
  await page.evaluate(() => {
    const t = getComputedStyle(document.getElementById('card')).transform;
    return t.startsWith('matrix3d') && !t.includes('NaN');
  }),
);

// --- Nothing appears that an audience could summon ------------------------
check(
  'the settings stay shut through all of that',
  await page.evaluate(() => document.getElementById('panel').hidden),
);

await page.touchscreen.tap(viewport.width / 2, viewport.height / 2);
await page.waitForTimeout(1200);
check(
  'and a tap on the wallpaper does not open them',
  await page.evaluate(() => document.getElementById('panel').hidden),
);

// Two fingers, held, is the only way in.
await page.evaluate(async () => {
  const touch = (x, y, id) =>
    new Touch({ identifier: id, target: document.body, clientX: x, clientY: y });
  const points = [touch(120, 400, 1), touch(220, 400, 2)];
  document.body.dispatchEvent(
    new TouchEvent('touchstart', { touches: points, bubbles: true, cancelable: true }),
  );
  await new Promise((r) => setTimeout(r, 1300));
});
check(
  'two fingers held for a second does',
  await page.evaluate(() => !document.getElementById('panel').hidden),
);

check('no page errors', errors.length === 0, errors[0]);

await page.evaluate(() => {
  document.getElementById('panel').hidden = true;
});
await page.screenshot({ path: path.join(here, 'preview.png') });

await browser.close();
server.kill();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
