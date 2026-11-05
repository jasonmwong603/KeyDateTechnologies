// Checks the trick's arithmetic, and the room the performer has to work in.
// Run with: node apps/clockwork/check.mjs
//
// The routine is now: four numbers the audience gives you, three
// multiplications in plain sight, and one blind addition at the end. Only the
// addend is fed in, so only one thing has to be exact:
//
//     running total + D = the clock
//
// But giving the multiplications away buys a constraint that did not exist
// when the multiplier was forced too: **the running total has to come in under
// the clock.** Over it and no addition reaches the target. That failure is in
// the performer's hands, not the maths — it is a matter of how big the numbers
// are — so the second half of this file measures how much room each shape of
// numbers leaves, and does it month by month, because the target in January is
// a tenth of the one in December.

const LEAD_MINUTES = 1;

function stamp(now) {
  const when = new Date(now.getTime() + LEAD_MINUTES * 60_000);
  const pad = (value) => String(value).padStart(2, '0');
  return Number(
    `${pad(when.getMonth() + 1)}${pad(when.getDate())}${pad(when.getHours())}${pad(when.getMinutes())}`,
  );
}

/** Deterministic, so a failure can be reproduced exactly. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const random = makeRandom(20261105);
const problems = [];
const note = (line) => problems.push(line);

/** A number of the requested number of digits, never with a leading zero. */
const draw = (digits) => {
  const low = 10 ** (digits - 1);
  const high = 10 ** digits - 1;
  return digits === 1
    ? 1 + Math.floor(random() * 9)
    : low + Math.floor(random() * (high - low + 1));
};

// Every month, several days, a spread of times across the day.
const targets = [];
for (let month = 1; month <= 12; month += 1) {
  for (const day of [1, 14, 28]) {
    for (const hour of [0, 9, 15, 23]) {
      for (const minute of [0, 17, 41, 58]) {
        targets.push({
          month,
          target: stamp(new Date(2027, month - 1, day, hour, minute)),
        });
      }
    }
  }
}

// --- 1. The arithmetic, wherever it is workable ----------------------------
//
// Whenever the running total lands under the clock, the addend must close the
// gap exactly. This is the part that cannot ever be wrong: if it is, the room's
// calculators disagree with the phone.
let checked = 0;
let exact = 0;
let overshot = 0;

/*
 * A shape is what you ask the room for.
 *
 * `sum` is an opening addition — two numbers added and settled with `=` before
 * anything is multiplied — and `mul` is what the total is then multiplied by.
 * The opening sum is worth having for its own sake: two four-digit numbers
 * read as generous, where four small ones read as careful, and the maths does
 * not mind which.
 */
/*
 * Birthdays are not four-digit numbers, and the difference is the routine.
 *
 * Asked for a birthday as MMDD, a person can only give you 101 to 1231 — and
 * three digits of it between January and September, where the leading zero
 * drops. A "four-digit number" reaches 9999. That gap is why eight birthdays
 * fit where two free four-digit numbers would not, and it is worth modelling
 * properly rather than approximating: the ceiling is the whole argument.
 */
const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const BIRTHDAYS = [];
for (let month = 1; month <= 12; month += 1) {
  for (let day = 1; day <= DAYS_IN[month - 1]; day += 1) BIRTHDAYS.push(month * 100 + day);
}
const BIRTHDAY_MAX = Math.max(...BIRTHDAYS);
const drawBirthday = () => BIRTHDAYS[Math.floor(random() * BIRTHDAYS.length)];

const SHAPES = [
  { birthdays: 8, mul: [2] },
  { birthdays: 4, mul: [2] },
  { birthdays: 9, mul: [2] },
  { birthdays: 1, mul: [4] },
  { sum: [4, 4], mul: [1] },
  { sum: [4, 4], mul: [2] },
  { sum: [4, 4], mul: [4] },
  { mul: [2, 2, 1, 1] },
  { mul: [3, 1, 1, 1] },
  { mul: [3, 2, 1, 1] },
  { mul: [3, 2, 2, 1] },
  { mul: [3, 3, 2, 1] },
];

const label = (shape) => {
  if (shape.birthdays !== undefined) return `${shape.birthdays} bdays·${shape.mul.join('·')}`;
  return shape.sum === undefined
    ? shape.mul.join('·')
    : `(${shape.sum.join('+')})·${shape.mul.join('·')}`;
};

/** What the room's numbers come to, before the forced addition. */
const runningTotal = (shape) => {
  let opening = 1;
  if (shape.birthdays !== undefined) {
    opening = 0;
    for (let i = 0; i < shape.birthdays; i += 1) opening += drawBirthday();
  } else if (shape.sum !== undefined) {
    opening = shape.sum.map(draw).reduce((a, b) => a + b, 0);
  }
  return shape.mul.map(draw).reduce((a, b) => a * b, opening);
};

/** The largest total a shape can possibly reach — the number that decides it. */
const ceilingOf = (shape) => {
  const top = (d) => 10 ** d - 1;
  let opening = 1;
  if (shape.birthdays !== undefined) opening = shape.birthdays * BIRTHDAY_MAX;
  else if (shape.sum !== undefined) opening = shape.sum.reduce((a, d) => a + top(d), 0);
  return shape.mul.reduce((a, d) => a * top(d), opening);
};

for (const { target } of targets) {
  for (const shape of SHAPES) {
    for (let trial = 0; trial < 4; trial += 1) {
      const running = runningTotal(shape);
      checked += 1;

      const gap = target - running;
      if (gap < 0) {
        overshot += 1;
        continue;
      }
      if (running + gap === target) exact += 1;
      else note(`${label(shape)}: ${running} + ${gap} != ${target}`);
    }
  }
}

// --- 2. How much room each shape leaves ------------------------------------
//
// The number that actually decides whether a performance works. A shape that
// overshoots a third of the time is a shape that fails on stage a third of the
// time, however exact the arithmetic is when it does not.
const workable = new Map();
for (const shape of SHAPES) {
  const key = label(shape);
  const rows = { tried: 0, under: 0, taps: [], worstMonth: { month: 0, rate: 2 } };
  const byMonth = new Map();

  for (const { month, target } of targets) {
    for (let trial = 0; trial < 60; trial += 1) {
      const running = runningTotal(shape);
      rows.tried += 1;
      const month_ = byMonth.get(month) ?? { tried: 0, under: 0 };
      month_.tried += 1;
      if (running <= target) {
        rows.under += 1;
        month_.under += 1;
        rows.taps.push(String(target - running).length);
      }
      byMonth.set(month, month_);
    }
  }

  for (const [month, counts] of byMonth) {
    const rate = counts.under / counts.tried;
    if (rate < rows.worstMonth.rate) rows.worstMonth = { month, rate };
  }
  workable.set(key, rows);
}

// --- 3. The shape the handling recommends ----------------------------------
//
// One shape has to be good enough in January, which is the hard month: the
// clock reads about 1,010,000 there against about 12,310,000 in December, so a
// set of numbers that is comfortable at Christmas overshoots by ten times in
// the new year.
const RECOMMENDED = '8 bdays·2';
const recommended = workable.get(RECOMMENDED);

console.log(`combinations      ${checked}`);
console.log(
  `arithmetic exact  ${exact}/${checked - overshot} of the workable ones  (${((exact / Math.max(1, checked - overshot)) * 100).toFixed(2)}%)`,
);
/*
 * The decisive column is the ceiling, not the percentage.
 *
 * A shape whose largest possible product is below the smallest clock of the
 * year cannot overshoot — not usually, ever, including the one night a year
 * when four people all call out 99. Everything else is a shape that works
 * until it does not, and "usually" is not a property a prop can have.
 */
const minTarget = Math.min(...targets.map((t) => t.target));

console.log(`smallest clock    ${minTarget}  (the first minute of January)`);
console.log('');
console.log('shape        biggest total   safe?   worst month     taps for the addend');
for (const [key, rows] of workable) {
  const ceiling = ceilingOf(SHAPES.find((candidate) => label(candidate) === key));
  const safe = ceiling <= minTarget;
  const sorted = rows.taps.slice().sort((a, b) => a - b);
  const span =
    sorted.length === 0
      ? 'n/a'
      : `${sorted[0]}-${sorted.at(-1)} (median ${sorted[Math.floor(sorted.length / 2)]})`;
  const worst = `${String(rows.worstMonth.month).padStart(2, '0')} at ${(rows.worstMonth.rate * 100).toFixed(0)}%`;
  console.log(
    `${key.padEnd(12)} ${String(ceiling).padStart(13)}   ${(safe ? 'always' : 'no').padEnd(7)} ${worst.padEnd(15)} ${span}`,
  );
}

// --- The two things that must hold -----------------------------------------
if (exact !== checked - overshot) {
  note(`${checked - overshot - exact} workable combinations did not add up`);
}

/*
 * The recommended shape has to be safe in every month, not on average.
 * "Usually works" is not a property a prop can have: the month it fails in is
 * a month of performances, not a rounding error.
 */
if (recommended === undefined) {
  note(`no measurements for the recommended shape ${RECOMMENDED}`);
} else if (recommended.worstMonth.rate < 1) {
  note(
    `${RECOMMENDED} overshoots in month ${recommended.worstMonth.month} ` +
      `(${(recommended.worstMonth.rate * 100).toFixed(0)}% workable)`,
  );
} else if (ceilingOf(SHAPES.find((candidate) => label(candidate) === RECOMMENDED)) > minTarget) {
  // Sampling can miss the worst draw. The ceiling cannot.
  note(`${RECOMMENDED} can in principle exceed the smallest clock of the year`);
}

if (problems.length > 0) {
  console.log('\nFAILED:');
  for (const line of problems.slice(0, 8)) console.log(`  ${line}`);
  process.exit(1);
}

console.log(`\nExact wherever it fits, and ${RECOMMENDED} always fits.`);
