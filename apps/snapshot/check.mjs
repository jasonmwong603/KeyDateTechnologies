// Checks the one thing the illusion cannot survive being wrong about.
// Run with: node apps/snapshot/check.mjs
//
// A convincing card drawn on a screen fools nobody for more than a second,
// because the moment a finger lands on it the eye checks exactly one thing:
// does it stay put under the fingertip? A real object does. Anything that
// slides, lags, or drifts by a millimetre over a long drag reads as a graphic
// at once, and no amount of shadow or gloss gets it back.
//
// So that is what is proved here, across every pose and grab point, to the
// limit of floating point — and from a terminal, because geometry does not
// need a phone to be wrong.

import {
  homographyMatrix,
  applyMatrix,
  unapplyMatrix,
  dragTo,
  cardCorners,
  CARD_MM,
} from './public/card.mjs';

/** Deterministic, so a failure can be reproduced exactly. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const random = makeRandom(20261031);
const ELEMENT = { w: 254, h: 356 }; // The card element, at 4px per mm.

const problems = [];
const note = (line) => problems.push(line);

/** A plausible pose: somewhere on a phone screen, slightly turned and tilted. */
function randomPose() {
  return {
    x: 40 + random() * 310,
    y: 60 + random() * 680,
    scale: 2.5 + random() * 3,
    angle: (random() - 0.5) * 1.2,
    tilt: random() * 0.3,
  };
}

// --- 1. A point of the card, and the point of the screen it is under -------
//
// Forward and back must agree. If they do not, a touch resolves to the wrong
// part of the card and the drag has nothing honest to hold.
let roundTripWorst = 0;
for (let trial = 0; trial < 2000; trial += 1) {
  const matrix = homographyMatrix(cardCorners(randomPose()), ELEMENT.w, ELEMENT.h);
  if (matrix === null) {
    note(`trial ${trial}: no transform for a valid pose`);
    continue;
  }

  const local = { x: random() * ELEMENT.w, y: random() * ELEMENT.h };
  const screen = applyMatrix(matrix, local.x, local.y);
  const back = unapplyMatrix(matrix, screen.x, screen.y);
  if (back === null) {
    note(`trial ${trial}: transform could not be inverted`);
    continue;
  }
  roundTripWorst = Math.max(roundTripWorst, Math.hypot(back.x - local.x, back.y - local.y));
}

// --- 2. The grabbed point stays under the finger ---------------------------
//
// The whole illusion, stated as a number. Grab the card anywhere, drag
// anywhere, and the material point that was under the fingertip must still be.
let dragWorst = 0;
for (let trial = 0; trial < 2000; trial += 1) {
  const pose = randomPose();
  let corners = cardCorners(pose);
  const matrix = homographyMatrix(corners, ELEMENT.w, ELEMENT.h);
  if (matrix === null) continue;

  // A finger lands somewhere on the card.
  const touch = applyMatrix(matrix, random() * ELEMENT.w, random() * ELEMENT.h);
  const grabbed = unapplyMatrix(matrix, touch.x, touch.y);
  if (grabbed === null) continue;

  // And drags, in stages, as a hand actually moves.
  let pointer = touch;
  for (let step = 0; step < 12; step += 1) {
    pointer = { x: pointer.x + (random() - 0.5) * 90, y: pointer.y + (random() - 0.5) * 140 };
    corners = dragTo(corners, grabbed, pointer, ELEMENT.w, ELEMENT.h);

    const after = homographyMatrix(corners, ELEMENT.w, ELEMENT.h);
    const landed = applyMatrix(after, grabbed.x, grabbed.y);
    dragWorst = Math.max(dragWorst, Math.hypot(landed.x - pointer.x, landed.y - pointer.y));
  }
}

// --- 3. The card keeps its shape while it moves ----------------------------
//
// A drag must not stretch or straighten it. If the perspective changes as it
// slides, it stops being an object and becomes an animation.
let shapeWorst = 0;
for (let trial = 0; trial < 500; trial += 1) {
  const pose = randomPose();
  const start = cardCorners(pose);
  const sides = (c) =>
    [0, 1, 2, 3].map((i) => Math.hypot(c[i].x - c[(i + 1) % 4].x, c[i].y - c[(i + 1) % 4].y));
  const before = sides(start);

  const matrix = homographyMatrix(start, ELEMENT.w, ELEMENT.h);
  const grabbed = unapplyMatrix(matrix, start[0].x, start[0].y);
  const moved = dragTo(
    start,
    grabbed,
    { x: random() * 400, y: random() * 800 },
    ELEMENT.w,
    ELEMENT.h,
  );

  const after = sides(moved);
  for (let i = 0; i < 4; i += 1) shapeWorst = Math.max(shapeWorst, Math.abs(after[i] - before[i]));
}

// --- 4. The card is the size of a card -------------------------------------
//
// People have held thousands of these. A card rendered the wrong size is wrong
// in a way everyone can see and nobody can name.
let sizeWorst = 0;
for (const scale of [2, 3.5, 4.77, 6]) {
  const corners = cardCorners({ x: 200, y: 400, scale, angle: 0, tilt: 0 });
  const width = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
  const height = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y);
  sizeWorst = Math.max(
    sizeWorst,
    Math.abs(width / scale - CARD_MM.width),
    Math.abs(height / scale - CARD_MM.height),
  );
}

// --- Report ---------------------------------------------------------------
console.log(`round trip        worst ${roundTripWorst.toExponential(1)}px over 2000 poses`);
console.log(`stays under finger worst ${dragWorst.toExponential(1)}px over 24000 drag steps`);
console.log(`keeps its shape   worst ${shapeWorst.toExponential(1)}px over 500 drags`);
console.log(`card size         worst ${sizeWorst.toExponential(1)}mm off`);

// Budgets are floating-point slack, not tolerances. Every one of these is an
// exact identity; anything above noise means the maths is wrong, not imprecise.
const BUDGET = 1e-6;
if (roundTripWorst > BUDGET) note(`round trip off by ${roundTripWorst.toExponential(1)}px`);
if (dragWorst > BUDGET) note(`card slips under the finger by ${dragWorst.toExponential(1)}px`);
if (shapeWorst > BUDGET)
  note(`card changes shape by ${shapeWorst.toExponential(1)}px while dragged`);
if (sizeWorst > BUDGET) note(`card is ${sizeWorst.toExponential(1)}mm from card-sized`);

if (problems.length > 0) {
  console.log(`\nFAILED:`);
  for (const line of problems.slice(0, 8)) console.log(`  ${line}`);
  process.exit(1);
}
console.log('\nIt stays under the finger.');
