/*
 * A card lying on the glass, and the finger that moves it.
 *
 * The illusion is not the picture. A convincing card drawn on a screen is easy
 * and fools nobody for more than a second, because the moment a finger touches
 * it the eye checks one thing: does it stay put under the fingertip? A real
 * object does. Anything that slides, lags or drifts by a millimetre reads as a
 * graphic instantly, and no amount of shadow or gloss recovers it.
 *
 * So the one property this file exists to guarantee is that the point of the
 * card you touched stays exactly under the point you are touching, through any
 * drag, at any perspective. It is pure geometry, which means `check.mjs` can
 * prove it from a terminal rather than anyone squinting at a phone.
 *
 * The camera-based version of this trick — finding a real card in a video
 * frame — is parked at commit 68a3d0a, tested and working, if it is ever wanted
 * back. The perspective maths below is the part that survived the change of
 * direction unchanged.
 */

/** A playing card is 63.5mm by 88.9mm. Poker size, not bridge. */
export const CARD_MM = { width: 63.5, height: 88.9 };

/**
 * The CSS transform that lays a `w` by `h` element onto four corners.
 *
 * `matrix3d` rather than anything canvas can do: canvas transforms are affine,
 * so a tilted card's far edge stays as wide as its near edge and the thing
 * looks painted on. The compositor does the perspective properly, on the GPU,
 * which also means the card keeps up with a fast drag instead of smearing.
 *
 * Corners are clockwise from the top left.
 */
export function homographyMatrix(corners, w, h) {
  const [p0, p1, p2, p3] = corners;

  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;

  let a;
  let b;
  let c;
  let d;
  let e;
  let f;
  let g;
  let i;

  if (dx3 === 0 && dy3 === 0) {
    // A parallelogram: no perspective term, and the general solution below
    // divides by zero rather than saying so.
    a = p1.x - p0.x;
    b = p2.x - p1.x;
    c = p0.x;
    d = p1.y - p0.y;
    e = p2.y - p1.y;
    f = p0.y;
    g = 0;
    i = 0;
  } else {
    const den = dx1 * dy2 - dy1 * dx2;
    if (den === 0) return null;
    g = (dx3 * dy2 - dy3 * dx2) / den;
    i = (dx1 * dy3 - dy1 * dx3) / den;
    a = p1.x - p0.x + g * p1.x;
    b = p3.x - p0.x + i * p3.x;
    c = p0.x;
    d = p1.y - p0.y + g * p1.y;
    e = p3.y - p0.y + i * p3.y;
    f = p0.y;
  }

  // Fold in the element's own size so it can be styled in pixels and the
  // unit-square maths above still holds.
  return [a / w, d / w, 0, g / w, b / h, e / h, 0, i / h, 0, 0, 1, 0, c, f, 0, 1];
}

/** Where the transform actually puts a point of the element, on screen. */
export function applyMatrix(matrix, x, y) {
  const [m0, m1, , m3, m4, m5, , m7, , , , , m12, m13] = matrix;
  const w = m3 * x + m7 * y + 1;
  return { x: (m0 * x + m4 * y + m12) / w, y: (m1 * x + m5 * y + m13) / w };
}

/**
 * The reverse: which point of the card is under a given point of the screen.
 *
 * This is what makes a touch mean something. A finger lands at a screen
 * coordinate; the card has to know which part of *itself* was grabbed, or the
 * drag has nothing to hold on to and the card jumps to centre itself under the
 * finger — the single most obvious tell there is.
 */
export function unapplyMatrix(matrix, x, y) {
  const [m0, m1, , m3, m4, m5, , m7, , , , , m12, m13] = matrix;

  // The forward map as a 3x3 acting on (x, y, 1); invert it by the adjugate.
  const a = m0;
  const b = m4;
  const c = m12;
  const d = m1;
  const e = m5;
  const f = m13;
  const g = m3;
  const h = m7;

  const A = e - f * h;
  const B = c * h - b;
  const C = b * f - c * e;
  const D = f * g - d;
  const E = a - c * g;
  const F = c * d - a * f;
  const G = d * h - e * g;
  const H = b * g - a * h;
  const I = a * e - b * d;

  const det = a * A + b * D + c * G;
  if (det === 0 || !Number.isFinite(det)) return null;

  const w = G * x + H * y + I;
  if (w === 0 || !Number.isFinite(w)) return null;
  return { x: (A * x + B * y + C) / w, y: (D * x + E * y + F) / w };
}

/**
 * Moves the card so the grabbed point of it sits under the pointer.
 *
 * Translating all four corners by the same vector translates the whole
 * projective map by that vector — the perspective is untouched, so a tilted
 * card stays tilted while it slides, as a real one would. Solving for a new
 * pose from scratch each frame would not keep that promise, and would wobble.
 */
export function dragTo(corners, grabbed, pointer, w, h) {
  const matrix = homographyMatrix(corners, w, h);
  if (matrix === null) return corners;

  const now = applyMatrix(matrix, grabbed.x, grabbed.y);
  const dx = pointer.x - now.x;
  const dy = pointer.y - now.y;
  return corners.map((corner) => ({ x: corner.x + dx, y: corner.y + dy }));
}

/**
 * Where a card's corners sit for a given pose, in screen pixels.
 *
 * `scale` is pixels per millimetre, which is the number that decides whether
 * this is believable at all. A card rendered the wrong size is wrong in a way
 * everybody can see and nobody can name — they have held thousands of these.
 * The browser cannot be asked: CSS millimetres are a fiction mapped to 96dpi,
 * not to the glass. So it is measured once, against a real card, and kept.
 */
export function cardCorners({ x, y, scale, angle = 0, tilt = 0 }) {
  const w = CARD_MM.width * scale;
  const h = CARD_MM.height * scale;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // `tilt` leans the far edge away, between 0 (flat on the glass, seen square
  // on) and about 0.3. Without a little of it the card is a sticker; with too
  // much it is a billboard.
  const near = 1;
  const far = 1 - tilt;

  const place = (dx, dy, squeeze) => ({
    x: x + (dx * squeeze * cos - dy * sin),
    y: y + (dx * squeeze * sin + dy * cos),
  });

  return [
    place(-w / 2, -h / 2, far),
    place(w / 2, -h / 2, far),
    place(w / 2, h / 2, near),
    place(-w / 2, h / 2, near),
  ];
}
