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
// A port picked per run, and a server that cannot outlive the run.
//
// A fixed port plus a test that only stops the host on success is a test that
// leaks a listener the first time a check throws — and every run after that
// fails to bind, for a reason that has nothing to do with the app.
const PORT = 8200 + Math.floor(Math.random() * 600);
const server = spawn(process.execPath, [path.join(repoRoot, 'host', 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
process.on('exit', () => server.kill());
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(1));

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

// Only the two settings the app actually keeps. There is nothing to set up.
await page.addInitScript(() => {
  localStorage.setItem('snapshot.scale', '3.8');
  localStorage.setItem('snapshot.face', '"A♠"');
});

await page.goto(pageUrl);
// `attached`, not visible: an empty screen is the opening, so waiting for the
// piece to be on it waits forever.
await page.waitForSelector('#card', { state: 'attached' });

check(
  'it opens with nothing on the screen at all',
  await page.evaluate(() => {
    const card = document.getElementById('card');
    return card.hidden || getComputedStyle(card).opacity === '0';
  }),
);

/*
 * The background has to be black, and has to stay black.
 *
 * On an OLED phone those pixels are off, so the screen is not showing black, it
 * is black — a phone that looks asleep rather than one running something. Any
 * drift towards a near-black grey gives that away in a dark room, which is
 * where this gets performed.
 */
const backdrop = await page.evaluate(() => {
  const wall = getComputedStyle(document.getElementById('wall'));
  const body = getComputedStyle(document.body);
  return { wall: wall.backgroundColor, image: wall.backgroundImage, body: body.backgroundColor };
});
check(
  'the background is true black, and is not an image that could drift',
  backdrop.wall === 'rgb(0, 0, 0)' && backdrop.image === 'none' && backdrop.body === 'rgb(0, 0, 0)',
  JSON.stringify(backdrop),
);

// --- It arrives because a finger arrived ---------------------------------
const viewport = page.viewportSize();
const touch = { x: viewport.width * 0.5, y: viewport.height * 0.55 };

const send = (type, point) =>
  page.evaluate(
    ({ type: kind, point: at }) => {
      const card = document.getElementById('card');
      card.setPointerCapture = () => {};
      const target = kind === 'pointerdown' ? window : window;
      target.dispatchEvent(
        new PointerEvent(kind, {
          pointerId: 1,
          pointerType: 'touch',
          isPrimary: true,
          bubbles: true,
          cancelable: true,
          clientX: at.x,
          clientY: at.y,
        }),
      );
    },
    { type, point },
  );

await send('pointerdown', touch);
await page.waitForTimeout(220);

check(
  'a touch on the black brings the piece out',
  await page.evaluate(() => {
    const card = document.getElementById('card');
    return !card.hidden && getComputedStyle(card).opacity === '1';
  }),
);

const piece = await page.evaluate(() => {
  const card = document.getElementById('card');
  return { clip: getComputedStyle(card).clipPath, rect: card.getBoundingClientRect().toJSON() };
});
check(
  'and it is a torn piece, not a whole card',
  piece.clip.startsWith('polygon(') && piece.clip.split(',').length >= 10,
  `${piece.clip.slice(0, 48)}…`,
);
check(
  'which appears under the finger that touched',
  Math.abs(piece.rect.x + piece.rect.width / 2 - touch.x) < piece.rect.width &&
    Math.abs(piece.rect.y + piece.rect.height / 2 - touch.y) < piece.rect.height,
  `piece at ${Math.round(piece.rect.x)},${Math.round(piece.rect.y)} for a touch at ${touch.x},${touch.y}`,
);

/*
 * The whole illusion, measured through a real finger.
 *
 * Touch a point of the card, drag, and ask where that same point of the card
 * ended up. A real object would be exactly under the fingertip. Anything else
 * and it is a graphic — and the eye checks this within a second of the first
 * touch, long before it considers the shadow or the gloss.
 */
const before = await page.evaluate(() => {
  const r = document.getElementById('card').getBoundingClientRect();
  return { x: r.x, y: r.y };
});

// The finger is still down from the touch that brought it out, which is how it
// is actually performed — touch, and draw it away without lifting.
const journey = [
  { x: touch.x - 60, y: touch.y - 140 },
  { x: touch.x + 50, y: touch.y - 260 },
  { x: touch.x - 15, y: touch.y - 175 },
];
for (const point of journey) {
  await send('pointermove', point);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
}

const moved = await page.evaluate(() => {
  const r = document.getElementById('card').getBoundingClientRect();
  return { x: r.x, y: r.y };
});

const expected = { dx: journey.at(-1).x - touch.x, dy: journey.at(-1).y - touch.y };
const actual = { dx: moved.x - before.x, dy: moved.y - before.y };
const slip = Math.hypot(actual.dx - expected.dx, actual.dy - expected.dy);

check(
  'the piece follows the finger exactly, and does not slip',
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

check(
  'and it is still there, well inside the screen',
  await page.evaluate(() => getComputedStyle(document.getElementById('card')).opacity === '1'),
);

// Taken here, with the piece in hand — the only moment worth a picture.
await page.screenshot({ path: path.join(here, 'preview.png') });

/*
 * Drawn out of the phone.
 *
 * Off the left edge, past the point where the middle of the piece has crossed
 * it. Checked as two separate things — still there a moment before, gone a
 * moment after — because a test that only looks at the end cannot tell a piece
 * that left when it should from one that was never there.
 */
await send('pointermove', { x: 40, y: viewport.height * 0.5 });
await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
check(
  'it survives being dragged near the edge',
  await page.evaluate(() => getComputedStyle(document.getElementById('card')).opacity === '1'),
);

await send('pointermove', { x: -140, y: viewport.height * 0.5 });
await page.waitForTimeout(320);
check(
  'and is gone once it is taken past it',
  await page.evaluate(() => {
    const card = document.getElementById('card');
    return card.hidden || getComputedStyle(card).opacity === '0';
  }),
);

await send('pointerup', { x: -140, y: viewport.height * 0.5 });

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

await browser.close();
server.kill();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
