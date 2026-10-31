// Checks the two things the effect cannot survive being wrong about.
// Run with: node apps/snapshot/check.mjs
//
//   1. The corners. If they are off, the replacement face sits beside the card.
//   2. The transform. If it is off, the face sits on the card but skewed, and a
//      rectangle that is not quite a rectangle is the most obvious thing on a
//      screen somebody is already staring at.
//
// Neither needs a camera, a phone or a browser, so both can be hammered across
// thousands of positions on every commit. That is the whole reason the geometry
// was kept as pure functions: the parts that must be exact are the parts that
// can be proved from a terminal.

import { findCard, homographyMatrix, applyMatrix, CARD_RATIO } from './public/detect.mjs';

const WIDTH = 160;
const HEIGHT = 120;

/** A deterministic generator, so a failure can be reproduced exactly. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Renders a pale quadrilateral on a dark background, as a camera would see it. */
function drawCard(corners, { noise = 0, background = 40, card = 230 } = {}, random = Math.random) {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);

  const inside = (x, y) => {
    // Winding test against the four edges. A point is inside a convex quad when
    // it is on the same side of every edge.
    let sign = 0;
    for (let i = 0; i < 4; i += 1) {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (cross === 0) continue;
      const here = cross > 0 ? 1 : -1;
      if (sign === 0) sign = here;
      else if (sign !== here) return false;
    }
    return true;
  };

  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const base = inside(x + 0.5, y + 0.5) ? card : background;
      const value = Math.max(0, Math.min(255, base + (random() - 0.5) * 2 * noise));
      const o = (y * WIDTH + x) * 4;
      data[o] = value;
      data[o + 1] = value;
      data[o + 2] = value;
      data[o + 3] = 255;
    }
  }
  return { data, width: WIDTH, height: HEIGHT };
}

/** A card of a plausible size, somewhere in frame, rotated and tilted a little. */
function randomCard(random) {
  const height = 40 + random() * 55;
  const width = height * CARD_RATIO;
  const cx = WIDTH / 2 + (random() - 0.5) * 30;
  const cy = HEIGHT / 2 + (random() - 0.5) * 20;
  const angle = (random() - 0.5) * 0.5;

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const corner = (dx, dy) => ({
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  });

  // A slight perspective squeeze on one edge, as a hand-held card always has.
  const squeeze = 1 - random() * 0.18;
  return [
    corner(-width / 2, -height / 2),
    corner(width / 2, (-height / 2) * squeeze),
    corner(width / 2, (height / 2) * squeeze),
    corner(-width / 2, height / 2),
  ];
}

const report = [];
const fail = (line) => report.push(line);

// --- 1. The corners -------------------------------------------------------
let found = 0;
let worst = 0;
let totalError = 0;
const TRIALS = 600;
const random = makeRandom(20261031);

for (let trial = 0; trial < TRIALS; trial += 1) {
  const truth = randomCard(random);
  const frame = drawCard(truth, { noise: 18 }, random);
  const result = findCard(frame);

  if (result === null) {
    fail(`  trial ${trial}: no card found`);
    continue;
  }
  found += 1;

  for (let i = 0; i < 4; i += 1) {
    const error = Math.hypot(result.corners[i].x - truth[i].x, result.corners[i].y - truth[i].y);
    totalError += error;
    worst = Math.max(worst, error);
  }
}

// --- 2. The transform -----------------------------------------------------
//
// The claim is exact, not approximate: the matrix must map the element's own
// four corners onto the detected four corners. Anything above a fraction of a
// pixel is visible as a misaligned edge.
let matrixWorst = 0;
let matrixChecked = 0;
const ELEMENT = { w: 120, h: 168 };

for (let trial = 0; trial < 400; trial += 1) {
  const corners = randomCard(random);
  const matrix = homographyMatrix(corners, ELEMENT.w, ELEMENT.h);
  if (matrix === null) {
    fail(`  trial ${trial}: no transform for a valid quad`);
    continue;
  }
  matrixChecked += 1;

  const source = [
    { x: 0, y: 0 },
    { x: ELEMENT.w, y: 0 },
    { x: ELEMENT.w, y: ELEMENT.h },
    { x: 0, y: ELEMENT.h },
  ];
  for (let i = 0; i < 4; i += 1) {
    const landed = applyMatrix(matrix, source[i].x, source[i].y);
    const error = Math.hypot(landed.x - corners[i].x, landed.y - corners[i].y);
    matrixWorst = Math.max(matrixWorst, error);
  }
}

// --- 3. Things that are not a card ---------------------------------------
//
// A confident overlay on the wrong object is worse than none: it tracks a hand
// or a beer mat around the screen, announcing that the phone is doing something.
const rejects = [
  [
    'an empty frame',
    [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ],
  ],
  [
    'a wide shape, like a phone held sideways',
    [
      { x: 20, y: 40 },
      { x: 140, y: 40 },
      { x: 140, y: 80 },
      { x: 20, y: 80 },
    ],
  ],
  [
    'a square, like a beer mat',
    [
      { x: 50, y: 30 },
      { x: 110, y: 30 },
      { x: 110, y: 90 },
      { x: 50, y: 90 },
    ],
  ],
  [
    'something tiny and far away',
    [
      { x: 78, y: 58 },
      { x: 82, y: 58 },
      { x: 82, y: 63 },
      { x: 78, y: 63 },
    ],
  ],
];

let rejected = 0;
for (const [label, quad] of rejects) {
  const result = findCard(drawCard(quad, { noise: 10 }, random));
  if (result === null) rejected += 1;
  else fail(`  accepted ${label} as a card (ratio ${result.ratio.toFixed(2)})`);
}

// --- Report ---------------------------------------------------------------
const meanError = totalError / Math.max(1, found * 4);
console.log(`frames            ${TRIALS}`);
console.log(`card found        ${found}  (${((found / TRIALS) * 100).toFixed(2)}%)`);
console.log(`corner error      mean ${meanError.toFixed(2)}px, worst ${worst.toFixed(2)}px`);
console.log(`transform error   worst ${matrixWorst.toExponential(1)}px over ${matrixChecked} quads`);
console.log(`rejected          ${rejected}/${rejects.length} things that are not cards`);

/*
 * The corner budget is in detector pixels, on a 160-wide frame. Two of those is
 * roughly a millimetre of card at arm's length — under the overlay's own edge,
 * and well under what anyone can see on a phone screen from across a table.
 */
const CORNER_BUDGET = 2.5;
const MATRIX_BUDGET = 1e-6;

const problems = [];
if (found < TRIALS) problems.push(`${TRIALS - found} frames with no card`);
if (worst > CORNER_BUDGET) problems.push(`corner error ${worst.toFixed(2)}px over ${CORNER_BUDGET}px`);
if (matrixWorst > MATRIX_BUDGET) problems.push(`transform error ${matrixWorst.toExponential(1)}px`);
if (rejected < rejects.length) problems.push(`${rejects.length - rejected} false positives`);

if (problems.length > 0) {
  console.log(`\nFAILED: ${problems.join('; ')}`);
  for (const line of report.slice(0, 8)) console.log(line);
  process.exit(1);
}
console.log('\nGeometry is exact.');
