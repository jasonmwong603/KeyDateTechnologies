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

/**
 * The clock as the prop reads it.
 *
 * The target is fixed at the instant the hold arms it, so a run that reads the
 * time once at the top and compares at the end disagrees by one whenever the
 * minute happens to turn in between — a failure that means nothing and shows up
 * about once in twelve runs. Every comparison brackets the arming instead.
 */
const clock = () =>
  page.evaluate(() => {
    // The lead, computed here independently of the page so the test is checking
    // the rule rather than echoing the code under test.
    const when = new Date(Date.now() + 60_000);
    const pad = (value) => String(value).padStart(2, '0');
    return Number(
      `${pad(when.getMonth() + 1)}${pad(when.getDate())}${pad(when.getHours())}${pad(when.getMinutes())}`,
    );
  });

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

await type('4827');
await tap('+');
await type('3915');
await tap('=');
check('the two spectators total correctly', (await shown()) === '8,742', await shown());

const box = page.viewportSize();

/** Press and hold an operator for long enough to arm it. */
const holdKey = async (label) => {
  const key = await page.locator(`.key:text-is("${label}")`).boundingBox();
  await page.mouse.move(key.x + key.width / 2, key.y + key.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  return page.evaluate(() => document.querySelector('.key.operator.armed')?.dataset.key ?? null);
};

/** A spectator tapping a screen she cannot see, nowhere near a key. */
const tapBlind = async (times) => {
  for (let i = 0; i < times; i += 1) {
    await page.mouse.click(
      box.width * (0.2 + Math.random() * 0.6),
      box.height * (0.2 + Math.random() * 0.6),
    );
    await page.waitForTimeout(15);
  }
};

/**
 * You take the phone back: press and hold anywhere.
 *
 * The wait afterwards is the failsafe, not padding. Every key is inert until
 * the screen has been left alone for most of a second, so that a spectator who
 * released the overlay by accident — by resting a finger, which is the same
 * gesture — cannot then reach the keypad. In the hand that second is already
 * gone by the time you have turned the phone over.
 */
const takeBack = async () => {
  await page.mouse.move(box.width * 0.5, box.height * 0.45);
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
  const free = await page.evaluate(() => document.getElementById('blind').hidden);
  await page.waitForTimeout(1100);
  return free;
};

// --- First half: hold the multiply, she taps the multiplier ---------------
check('holding the multiply arms the first taps', (await holdKey('×')) === '×');

await tapBlind(20);
const overrun = await shown();
check('extra taps cannot overrun the number', !overrun.includes('Error'), overrun);

/*
 * The failsafe, where it matters most.
 *
 * She cannot see the screen, so she cannot avoid the keys — and resting a
 * finger for half a second is the very gesture that drops the overlay. This
 * reproduces that: release it as she would, by accident, and then let her go on
 * tapping the most destructive keys on the pad. The force number and the
 * pending operator have to be exactly where they were.
 */
const releasedEarly = await page.evaluate(() => document.getElementById('blind').hidden);
await page.mouse.move(box.width * 0.5, box.height * 0.4);
await page.mouse.down();
await page.waitForTimeout(700);
await page.mouse.up();
check(
  'a rested finger does release the overlay, as it always did',
  !releasedEarly && (await page.evaluate(() => document.getElementById('blind').hidden)),
);

const guarded = { entry: await shown(), expression: await page.textContent('#expression') };
for (const key of ['AC', '7', '=', '÷', '%', '⌫']) {
  await page.click(`.key:text-is("${key}")`, { force: true });
  await page.waitForTimeout(40);
}
check(
  'her stray taps cannot touch the number — AC, digits, =, ÷, %, backspace',
  (await shown()) === guarded.entry &&
    (await page.textContent('#expression')) === guarded.expression,
  `${await page.textContent('#expression')} ${await shown()} — was ${guarded.expression} ${guarded.entry}`,
);

// And it lifts on its own once the screen is left alone, which is what happens
// the moment the phone is in your hand.
await page.waitForTimeout(1100);
await page.click('.key:text-is("⌫")');
check('the seal lifts once the tapping stops', (await shown()) !== guarded.entry, await shown());

// Put the digit back and carry on; the routine is unharmed by all of that.
await tap(guarded.entry.slice(-1));
check('and the force number is intact', (await shown()) === guarded.entry, await shown());

// The middle reveal: a real product, on screen, for the room to look at. Her
// number is in the readout and the sum is still above it, so both are showing
// at the moment you lift the phone — which is the point of stopping here.
const firstHalf = (await page.textContent('#expression')).trim();
const multiplier = Number((await shown()).replace(/,/g, ''));
await tap('=');
const product = Number((await shown()).replace(/,/g, ''));
check(
  'her number multiplies the sum, and the product is shown',
  firstHalf === '8,742 ×' && multiplier > 0 && product === 8742 * multiplier,
  `${firstHalf} ${multiplier} = ${product}`,
);

// --- Second half: hold the plus, a different spectator taps the addend ----
const armedAfter = await clock();
check('holding the plus arms the second taps', (await holdKey('+')) === '+');
const armedBefore = await clock();

await tapBlind(20);
check('and the keypad comes back the same way', await takeBack());

const expressionBefore = await page.textContent('#expression');

/**
 * What a readout is actually showing, versus what it holds.
 *
 * `over` is the part hanging outside the box — the number the audience cannot
 * see. Anything above zero is the bug this measures: it used to clip from the
 * left, so the digits lost were the ones that mattered and nothing on screen
 * admitted it. `inline` says whether the script had to shrink the text to get
 * there, which is the difference between a readout that fits and one that fits
 * comfortably.
 */
const readout = (selector) =>
  page.evaluate((sel) => {
    const element = document.querySelector(sel);
    return {
      over: element.scrollWidth - element.clientWidth,
      size: parseFloat(getComputedStyle(element).fontSize),
      inline: element.style.fontSize !== '',
      text: element.textContent,
    };
  }, selector);

const sumShown = await readout('#expression');
check(
  'the whole sum is visible, not clipped',
  sumShown.over <= 1,
  `${sumShown.over}px hidden of "${sumShown.text}"`,
);

await tap('=');
const result = Number((await shown()).replace(/,/g, ''));

check(
  'the total is the date and the time on the clock',
  result === armedAfter || result === armedBefore,
  `${result} vs ${armedAfter}`,
);

/*
 * And it is the minute ahead, not the one showing.
 *
 * Stated separately and against the bare clock, because the bracket above
 * carries the lead in it: if the lead were dropped from the page, that check
 * would notice but would report it as a mismatched time rather than as the
 * thing that actually changed. This says what the rule is.
 */
const rightNow = await page.evaluate(() => {
  const pad = (value) => String(value).padStart(2, '0');
  const now = new Date();
  return Number(
    `${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`,
  );
});
check(
  'and it reads a minute later than the clock does right now',
  result !== rightNow,
  `answer ${result}, clock ${rightNow}`,
);
check(
  'and the closing sum is on screen for the room to copy',
  expressionBefore.trim() === `${product.toLocaleString('en-US')} +`,
  expressionBefore,
);

// --- Every digit on screen, in both orientations --------------------------
//
// The reveal is eight digits and three commas and does not fit a phone held
// upright at full size. Portrait has to shrink it; landscape has to not need
// to. Either way nothing may be cut off — a number the room cannot read in
// full is a number it cannot check, which is the whole proof.
const portrait = await readout('#entry');
check(
  'the full eight-digit answer fits in portrait',
  portrait.over <= 1,
  `${portrait.over}px hidden of "${portrait.text}"`,
);
check('portrait gets there by shrinking', portrait.inline, `${portrait.size.toFixed(1)}px`);

await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(120);

const landscape = await page.evaluate(() => {
  const keys = [...document.querySelectorAll('.key')].map((key) => {
    const box = key.getBoundingClientRect();
    return { key: key.dataset.key, x: box.x, y: box.y, w: box.width, h: box.height };
  });
  // Reading order on screen, which is no longer the order in the document.
  keys.sort((a, b) => (Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x));
  return {
    order: keys.map((key) => key.key).join(' '),
    columns: new Set(keys.map((key) => Math.round(key.x))).size,
    pills: keys.every((key) => key.w > key.h + 2),
    smallest: Math.min(...keys.map((key) => key.h)),
  };
});

check(
  'landscape rearranges the keypad as the system one does',
  landscape.order === '7 8 9 back ÷ 4 5 6 ac × 1 2 3 percent − sign 0 . = +',
  landscape.order,
);
check('five columns of them', landscape.columns === 5, `${landscape.columns} columns`);
check('and the keys are pills, not circles', landscape.pills);
const wide = await readout('#entry');
check(
  'the full answer fits in landscape too',
  wide.over <= 1,
  `${wide.over}px hidden of "${wide.text}"`,
);
check(
  'and landscape does not have to shrink it',
  !wide.inline,
  `${wide.size.toFixed(1)}px, from the stylesheet`,
);

await page.screenshot({ path: path.join(here, 'preview-landscape.png') });

/*
 * The same, on every phone this might be performed on.
 *
 * Landscape is the tight one: the readout and four rows of keys divide what
 * used to be the phone's width, so the shortest handset is where the keypad
 * gets squeezed. One size proved nothing — at 390 tall everything looked fine
 * while a 13 mini was already down to 41pt keys, under Apple's minimum and
 * small enough to misfire on stage.
 */
for (const [name, width, height] of [
  ['SE', 667, 375],
  ['13 mini', 780, 360],
  ['14 Pro Max', 932, 430],
  ['16 Pro Max', 956, 440],
]) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(100);
  const fit = await page.evaluate(() => {
    const keys = [...document.querySelectorAll('.key')].map((key) => key.getBoundingClientRect());
    const entry = document.getElementById('entry');
    return {
      lowest: Math.max(...keys.map((key) => key.bottom)),
      shortest: Math.min(...keys.map((key) => key.height)),
      over: entry.scrollWidth - entry.clientWidth,
    };
  });
  check(
    `${name} (${width}×${height}) holds the whole layout`,
    fit.lowest <= height && fit.shortest >= 44 && fit.over <= 1,
    `bottom row ends at ${fit.lowest.toFixed(0)} of ${height}, keys ${fit.shortest.toFixed(0)}pt, ${fit.over}px hidden`,
  );
}

await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(100);

/*
 * The two ways the routine used to fail without saying so.
 *
 * Both end with a number that is not the time, and nothing on screen admits it
 * — which is the worst shape a bug can take in a prop, because the first person
 * to notice is in the audience.
 */
const perform = async ({ settle = true, taps = 20 } = {}) => {
  await page.click('.key:text-is("AC")');
  await page.setViewportSize(devices['iPhone 13 Pro'].viewport);
  await page.waitForTimeout(80);

  await type('4827');
  await tap('+');
  await type('3915');
  if (settle) await tap('=');

  const size = page.viewportSize();

  const half = async (label, count) => {
    const key = await page.locator(`.key:text-is("${label}")`).boundingBox();
    await page.mouse.move(key.x + key.width / 2, key.y + key.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();

    for (let i = 0; i < count; i += 1) {
      await page.mouse.click(size.width * 0.5, size.height * 0.4);
      await page.waitForTimeout(15);
    }

    // You take the phone back.
    await page.mouse.move(size.width * 0.5, size.height * 0.45);
    await page.mouse.down();
    await page.waitForTimeout(800);
    await page.mouse.up();

    // If the overlay is still up the prop is dead in the hand — every key is
    // behind it. Say so here rather than letting the click on `=` hang for
    // thirty seconds and report a timeout instead of a diagnosis.
    const free = await page.evaluate(() => document.getElementById('blind').hidden);
    // The seal: keys stay inert until the screen has been quiet. Real handling
    // spends far longer than this turning the phone over.
    await page.waitForTimeout(1100);
    return free;
  };

  if (!(await half('×', taps))) {
    return { total: 0, sum: '', ok: false, want: await clock(), stuck: true };
  }
  const sum = (await page.textContent('#expression')).trim();
  await tap('=');

  // The target is fixed the instant the second half is armed, and the minute
  // can turn while the test is still clicking — so bracket it rather than guess.
  const before = await clock();
  const free = await half('+', taps);
  const after = await clock();
  if (!free) return { total: 0, sum, ok: false, want: before, stuck: true };

  await tap('=');
  const total = Number((await shown()).replace(/,/g, ''));
  return { total, sum, ok: total === before || total === after, want: before };
};

// She stops tapping long before the number is finished. "As many times as you
// like" has to mean too few as well as too many — you cannot count her taps
// while the phone is face down and you are talking to the room.
const short = await perform({ taps: 3 });
check(
  'stopping her early still lands on the clock',
  short.ok,
  short.stuck
    ? 'the keypad never came back — every key is behind the overlay'
    : `${short.total} vs ${short.want} — ${short.sum}`,
);

// The `=` after the addition is forgotten. One keystroke, in the middle of
// talking, and it used to arm against the second spectator's number alone.
const unsettled = await perform({ settle: false });
check(
  'forgetting the = after the addition still lands on the clock',
  unsettled.ok,
  `${unsettled.total} vs ${unsettled.want} — ${unsettled.sum}`,
);
check(
  'and the sum on screen is the one that was evaluated',
  unsettled.sum.startsWith('8,742 ×'),
  unsettled.sum,
);

await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(100);

// The crib is on the prop, behind a hold — and must never show up on its own.
await page.waitForTimeout(1100); // out from under the seal left by the last release
check('the crib stays shut', await page.evaluate(() => document.getElementById('crib').hidden));
const icon = await page.locator('#mode').boundingBox();
await page.mouse.move(icon.x + icon.width / 2, icon.y + icon.height / 2);
await page.mouse.down();
await page.waitForTimeout(1000);
await page.mouse.up();
check(
  'holding the keypad icon opens it',
  await page.evaluate(() => !document.getElementById('crib').hidden),
);
// A tap closes it — it has to be a tap and not the same hold, because the card
// covers the icon that opened it.
await page.mouse.click(422, 320);
check(
  'and a tap anywhere closes it again',
  await page.evaluate(() => document.getElementById('crib').hidden),
);

await page.setViewportSize(devices['iPhone 13 Pro'].viewport);
await page.waitForTimeout(120);

check('no page errors', errors.length === 0, errors[0]);

await page.click('.key:text-is("AC")');
await page.screenshot({ path: path.join(here, 'preview.png') });

await browser.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
