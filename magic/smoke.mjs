import { chromium, devices } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const page_url = `file://${path.join(here, 'index.html')}`;

/**
 * Finds the preinstalled Chromium.
 *
 * Its directory carries a build number that moves whenever the image is
 * rebuilt, so this looks rather than hardcoding — a pinned path works right up
 * until the day it silently does not.
 */
function launchOptions() {
  if (process.env.CHROMIUM_PATH) return { executablePath: process.env.CHROMIUM_PATH };
  const root = '/opt/pw-browsers';
  if (!existsSync(root)) return {};
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith('chromium')) continue;
    // The inner folder has been `chrome-linux` and is now `chrome-linux64`.
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
const context = await browser.newContext(devices['iPhone 13 Pro']);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

await page.goto(page_url);
await page.waitForSelector('#keys');

// --- It has to pass for the real thing before it has to do anything clever ---
const layout = await page.evaluate(() =>
  [...document.querySelectorAll('.key')].map((key) => key.dataset.key),
);
check(
  'keypad matches the iPhone layout',
  layout.join(' ') === 'back ac percent ÷ 7 8 9 × 4 5 6 − 1 2 3 + sign 0 . =',
  layout.join(' '),
);

const shading = await page.evaluate(() => {
  const fill = (key) =>
    getComputedStyle(document.querySelector(`[data-key="${key}"]`)).backgroundColor;
  return { ac: fill('ac'), seven: fill('7'), sign: fill('sign'), plus: fill('+') };
});
check(
  'the sign key is shaded like a digit, not a function',
  shading.sign === shading.seven && shading.sign !== shading.ac,
  `sign=${shading.sign} digit=${shading.seven} function=${shading.ac}`,
);
check('operators are orange', shading.plus === 'rgb(255, 159, 10)', shading.plus);

const tap = async (label) => {
  await page.click(`.key:text-is("${label}")`);
  await page.waitForTimeout(25);
};
const type = async (text) => {
  for (const character of text) await tap(character);
};
const shown = () => page.textContent('#entry');

// Ordinary arithmetic, including the precedence that decides whether the
// audience's own calculators agree with the phone.
await type('12');
await tap('+');
await type('3');
await tap('×');
check(
  'an ordinary multiply does not arm anything',
  await page.evaluate(() => document.getElementById('blind').hidden),
);
await type('4');
await tap('=');
check('respects precedence — 12 + 3 × 4', (await shown()) === '24', await shown());

await page.click('.key:text-is("AC")');
check('AC clears', (await shown()) === '0', await shown());

await type('50');
await tap('%');
check('percent divides by a hundred', (await shown()) === '0.5', await shown());

await page.click('.key:text-is("AC")');
await type('1234567');
check('groups thousands like the real one', (await shown()) === '1,234,567', await shown());

// --- The trick ------------------------------------------------------------
await page.click('.key:text-is("AC")');

const expected = await page.evaluate(() => {
  const pad = (value) => String(value).padStart(2, '0');
  const now = new Date();
  return Number(
    `${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`,
  );
});

await type('4827');
await tap('+');
await type('3915');
await tap('=');
check('the two spectators total correctly', (await shown()) === '8,742', await shown());

// Hold the multiply. That is the whole secret move — and the hold performs the
// multiply itself, so it is the only press the expression ever sees.
const multiply = await page.locator('.key:text-is("×")').boundingBox();
await page.mouse.move(multiply.x + multiply.width / 2, multiply.y + multiply.height / 2);
await page.mouse.down();
await page.waitForTimeout(700);
await page.mouse.up();

const armedAfterHold = await page.evaluate(
  () => document.querySelector('.key.operator.armed')?.dataset.key ?? null,
);
check('holding the multiply arms the taps', armedAfterHold === '×', `armed=${armedAfterHold}`);

// She taps blind, far more times than the number needs, nowhere near a key.
const box = page.viewportSize();
for (let i = 0; i < 20; i += 1) {
  await page.mouse.click(
    box.width * (0.2 + Math.random() * 0.6),
    box.height * (0.2 + Math.random() * 0.6),
  );
  await page.waitForTimeout(15);
}

const overrun = await shown();
check('extra taps cannot overrun the number', !overrun.includes('Error'), overrun);

// You take the phone back and end it with a press and hold.
await page.mouse.move(box.width * 0.5, box.height * 0.45);
await page.mouse.down();
await page.waitForTimeout(800);
await page.mouse.up();
check(
  'a press and hold releases the keypad',
  await page.evaluate(() => document.getElementById('blind').hidden),
);

const expressionBefore = await page.textContent('#expression');
await tap('=');
const result = Number((await shown()).replace(/,/g, ''));

check(
  'the total is the date and the time on the clock',
  result === expected,
  `${result} vs ${expected}`,
);
check(
  'and the sum is on screen for the room to copy',
  /8,742 × [\d,]+ \+/.test(expressionBefore),
  expressionBefore,
);
check('no page errors', errors.length === 0, errors[0]);

await page.click('.key:text-is("AC")');
await page.screenshot({ path: path.join(here, 'preview.png') });

await browser.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
