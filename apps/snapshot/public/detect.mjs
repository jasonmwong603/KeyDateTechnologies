/*
 * Finding the card, and putting something else on top of it.
 *
 * The whole effect lives or dies on two numbers being right. If the corners
 * are wrong the replacement face sits beside the card instead of on it. If the
 * transform is wrong it sits on the card but skewed, and a rectangle that is
 * not quite a rectangle is the most obvious thing in the world on a screen
 * somebody is staring at.
 *
 * Both are pure functions of their input, which is the point: neither needs a
 * camera, a phone or a browser to be checked, so `check.mjs` can hammer them
 * across thousands of positions on every commit. The page imports this same
 * file, so there is one copy and it cannot drift from the one under test.
 */

/** A playing card is 2.5 by 3.5 inches — a hair under 0.715 wide for tall. */
export const CARD_RATIO = 2.5 / 3.5;

/**
 * Otsu's method: the brightness that best splits the frame into dark and light.
 *
 * A fixed threshold fails the moment the room changes — a card in stage light
 * and a card in a pub are different images, and there is no constant that
 * covers both. This picks the split that minimises the spread within each side,
 * so it adapts to whatever the camera is actually seeing. It is also about
 * fifteen lines, which is the other reason to prefer it to anything cleverer.
 */
export function otsuThreshold(histogram, total) {
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i];

  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let bestVariance = -1;

  for (let t = 0; t < 256; t += 1) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const between =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

    if (between > bestVariance) {
      bestVariance = between;
      best = t;
    }
  }
  return best;
}

/**
 * The four corners of the largest bright shape in the frame.
 *
 * Deliberately not card *recognition*. Working out which card is being held is
 * a hard problem and an unnecessary one — the trick never needs to know, it
 * only needs to know where the rectangle is. Finding a pale quadrilateral is
 * something a hundred lines can do reliably; reading the pips is not.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} frame
 * @returns {{corners: {x: number, y: number}[], area: number} | null}
 */
export function findCard(frame, options = {}) {
  const { width, height, data } = frame;
  const total = width * height;
  const minArea = (options.minArea ?? 0.02) * total;
  const maxArea = (options.maxArea ?? 0.9) * total;

  // Luma, and a histogram to pick the threshold from, in one pass.
  const grey = new Uint8Array(total);
  const histogram = new Uint32Array(256);
  for (let i = 0; i < total; i += 1) {
    const o = i * 4;
    // Rec. 601 weights: the eye is far more sensitive to green than to blue,
    // and a plain average turns a red suit darker than it looks.
    const value = (data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 8;
    grey[i] = value;
    histogram[value] += 1;
  }

  const threshold = otsuThreshold(histogram, total);

  /*
   * Refuse a frame that has no two sides to it.
   *
   * Otsu always returns a threshold, even for a blank wall — it will happily
   * split sensor noise into "dark" and "light" and hand back a shape made of
   * grain. Asking how far apart the two halves actually are is what separates a
   * card from an empty room, and without it the overlay appears over nothing at
   * the worst imaginable moment.
   */
  let darkSum = 0;
  let darkCount = 0;
  let lightSum = 0;
  let lightCount = 0;
  for (let v = 0; v < 256; v += 1) {
    if (v <= threshold) {
      darkSum += v * histogram[v];
      darkCount += histogram[v];
    } else {
      lightSum += v * histogram[v];
      lightCount += histogram[v];
    }
  }
  if (darkCount === 0 || lightCount === 0) return null;
  const contrast = lightSum / lightCount - darkSum / darkCount;
  if (contrast < (options.minContrast ?? 35)) return null;

  /*
   * Largest bright region, by flood fill.
   *
   * An explicit stack rather than recursion: a card can be most of the frame,
   * and a recursive fill over tens of thousands of pixels overflows the call
   * stack on exactly the frames that matter most.
   */
  const labels = new Int32Array(total).fill(-1);
  const stack = new Int32Array(total);
  let bestPixels = null;
  let bestCount = 0;

  for (let start = 0; start < total; start += 1) {
    if (labels[start] !== -1 || grey[start] <= threshold) continue;

    let top = 0;
    stack[top++] = start;
    labels[start] = start;
    const pixels = [];

    while (top > 0) {
      const p = stack[--top];
      pixels.push(p);
      const x = p % width;
      const y = (p - x) / width;

      // Four-connected. Eight would bridge a card to a bright highlight beside
      // it through a single touching corner, which is how one blob becomes two
      // cards' worth of nonsense.
      if (x > 0) {
        const n = p - 1;
        if (labels[n] === -1 && grey[n] > threshold) {
          labels[n] = start;
          stack[top++] = n;
        }
      }
      if (x < width - 1) {
        const n = p + 1;
        if (labels[n] === -1 && grey[n] > threshold) {
          labels[n] = start;
          stack[top++] = n;
        }
      }
      if (y > 0) {
        const n = p - width;
        if (labels[n] === -1 && grey[n] > threshold) {
          labels[n] = start;
          stack[top++] = n;
        }
      }
      if (y < height - 1) {
        const n = p + width;
        if (labels[n] === -1 && grey[n] > threshold) {
          labels[n] = start;
          stack[top++] = n;
        }
      }
    }

    if (pixels.length > bestCount) {
      bestCount = pixels.length;
      bestPixels = pixels;
    }
  }

  if (bestPixels === null || bestCount < minArea || bestCount > maxArea) return null;

  /*
   * Corners by extremes of the rotated axes.
   *
   * For a quadrilateral, the pixel furthest along (x + y) is the bottom-right
   * corner, the furthest along (x - y) is top-right, and so on. It costs one
   * pass, it does not care how the card is rotated, and it degrades into
   * something sensible rather than nothing when an edge is partly obscured —
   * which matters, because a card is usually being held by one of its corners.
   */
  let tl = bestPixels[0];
  let br = bestPixels[0];
  let tr = bestPixels[0];
  let bl = bestPixels[0];
  let minSum = Infinity;
  let maxSum = -Infinity;
  let minDiff = Infinity;
  let maxDiff = -Infinity;

  for (const p of bestPixels) {
    const x = p % width;
    const y = (p - x) / width;
    const sum = x + y;
    const diff = x - y;
    if (sum < minSum) {
      minSum = sum;
      tl = p;
    }
    if (sum > maxSum) {
      maxSum = sum;
      br = p;
    }
    if (diff > maxDiff) {
      maxDiff = diff;
      tr = p;
    }
    if (diff < minDiff) {
      minDiff = diff;
      bl = p;
    }
  }

  const point = (p) => ({ x: p % width, y: Math.floor(p / width) });
  const rough = [point(tl), point(tr), point(br), point(bl)];

  const corners = refineCorners(rough, bestPixels, labels, width, height) ?? rough;

  // A rectangle, roughly. Anything wildly off is a hand, a lamp or a page, and
  // a confident overlay on the wrong object is worse than no overlay at all.
  const edge = (a, b) => Math.hypot(corners[a].x - corners[b].x, corners[a].y - corners[b].y);
  const across = (edge(0, 1) + edge(3, 2)) / 2;
  const down = (edge(0, 3) + edge(1, 2)) / 2;
  if (across < 4 || down < 4) return null;

  /*
   * The ratio band is deliberately lopsided, because perspective is.
   *
   * A card tilted about its long axis loses width and the ratio falls; tilted
   * about its short axis it loses height and the ratio rises. A symmetric
   * tolerance wide enough for the first is wide enough to accept a square —
   * and a beer mat tracked confidently around the screen is the prop
   * announcing itself.
   */
  const ratio = across / down;
  const min = options.minRatio ?? 0.5;
  const max = options.maxRatio ?? 0.95;
  if (ratio < min || ratio > max) return null;

  return { corners, area: bestCount, threshold, ratio, contrast };
}

/**
 * Subpixel corners, by fitting a line to each edge and intersecting them.
 *
 * The extremes above land on whole pixels, and on a 160-wide frame a pixel of
 * error becomes several on screen — enough to see the replacement's edge beside
 * the card's. Fitting to every pixel along an edge averages the rasterisation
 * away and, more usefully, survives a corner being covered: a thumb takes out
 * the one pixel the extreme method depends on, but leaves the two edges that
 * cross there perfectly visible.
 */
function refineCorners(rough, pixels, labels, width, height) {
  const label = labels[pixels[0]];

  // Pixels on the blob's boundary: in the shape, with a neighbour that is not.
  const boundary = [];
  for (const p of pixels) {
    const x = p % width;
    const y = (p - x) / width;
    if (
      x === 0 ||
      y === 0 ||
      x === width - 1 ||
      y === height - 1 ||
      labels[p - 1] !== label ||
      labels[p + 1] !== label ||
      labels[p - width] !== label ||
      labels[p + width] !== label
    ) {
      boundary.push({ x, y });
    }
  }

  // Assign each boundary pixel to the edge it lies along, ignoring the ends:
  // near a corner the pixels belong to both edges and bias each away from true.
  const groups = [[], [], [], []];
  for (const pixel of boundary) {
    let bestEdge = -1;
    let bestDistance = Infinity;
    for (let e = 0; e < 4; e += 1) {
      const a = rough[e];
      const b = rough[(e + 1) % 4];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSquared = dx * dx + dy * dy;
      if (lengthSquared === 0) continue;
      const t = ((pixel.x - a.x) * dx + (pixel.y - a.y) * dy) / lengthSquared;
      if (t < 0.18 || t > 0.82) continue;
      const distance = Math.abs(dy * (pixel.x - a.x) - dx * (pixel.y - a.y)) / Math.sqrt(lengthSquared);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestEdge = e;
      }
    }
    // Well away from every edge means it is a notch or a bite out of the shape,
    // not part of its outline.
    if (bestEdge >= 0 && bestDistance < 3) groups[bestEdge].push(pixel);
  }

  const lines = groups.map(fitLine);
  if (lines.some((line) => line === null)) return null;

  // Corner i is where the edge arriving meets the edge leaving.
  const corners = [];
  for (let i = 0; i < 4; i += 1) {
    const meeting = intersect(lines[(i + 3) % 4], lines[i]);
    if (meeting === null) return null;
    corners.push(meeting);
  }
  return corners;
}

/**
 * Total least squares, not the usual kind.
 *
 * Fitting y against x cannot represent a vertical line, and two of a card's
 * four edges are near vertical almost every time it is held up. Taking the
 * principal direction of the points instead has no preferred axis.
 */
function fitLine(points) {
  if (points.length < 6) return null;

  const line = principalAxis(points);

  /*
   * Fit once, throw away the outliers, fit again.
   *
   * Sensor noise flips pixels along the edge, and a speckle sitting a pixel
   * inside the card pulls the line in with it — every one of them on the same
   * side, because there is nothing outside the card to flip the other way. The
   * bias is small and entirely one-directional, which is the kind that survives
   * averaging. Dropping the points furthest from the first fit removes them,
   * and keeps the many that agree.
   */
  const residuals = points.map((p) => Math.abs(distanceToLine(line, p)));
  const sorted = residuals.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const keep = points.filter((p, i) => residuals[i] <= Math.max(median * 1.8, 0.75));

  return keep.length >= 6 ? principalAxis(keep) : line;
}

/** Total least squares: the direction the points mostly lie along. */
function principalAxis(points) {
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= points.length;
  my /= points.length;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  // Principal eigenvector of the 2x2 covariance.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { x: mx, y: my, dx: Math.cos(theta), dy: Math.sin(theta) };
}

const distanceToLine = (line, p) => line.dy * (p.x - line.x) - line.dx * (p.y - line.y);

function intersect(a, b) {
  const den = a.dx * b.dy - a.dy * b.dx;
  // Parallel edges never meet, which for a quadrilateral means the shape was
  // not one.
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b.x - a.x) * b.dy - (b.y - a.y) * b.dx) / den;
  return { x: a.x + a.dx * t, y: a.y + a.dy * t };
}

/**
 * The CSS transform that lays a `w` by `h` element exactly over four corners.
 *
 * Canvas cannot draw a perspective-warped image — its transform is affine, so
 * the far edge of a tilted card stays the same width as the near one and the
 * replacement visibly floats. A homography in `matrix3d` is handled by the
 * compositor instead: correct perspective, on the GPU, interpolated between
 * detections so the overlay moves smoothly rather than at the detector's rate.
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
    // The quad is a parallelogram: no perspective term, and the general
    // solution below divides by zero rather than saying so.
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

  // Fold in the element's own size, so the caller can style it in pixels and
  // still have the unit-square maths above hold.
  return [a / w, d / w, 0, g / w, b / h, e / h, 0, i / h, 0, 0, 1, 0, c, f, 0, 1];
}

/** Where `matrix3d` actually puts a point — the check that the matrix is right. */
export function applyMatrix(matrix, x, y) {
  const [m0, m1, , m3, m4, m5, , m7, , , , , m12, m13] = matrix;
  const wq = m3 * x + m7 * y + 1;
  return { x: (m0 * x + m4 * y + m12) / wq, y: (m1 * x + m5 * y + m13) / wq };
}

/**
 * Eases the overlay towards a new detection.
 *
 * The detector runs on a downscaled frame several times a second and its
 * corners jitter by a pixel or two between frames. Pinned straight to the
 * output, the replacement shivers — which reads as *fake* long before anybody
 * works out why. Moving a fraction of the way each frame costs a few
 * milliseconds of lag nobody can see and removes all of it.
 */
export function ease(from, to, amount) {
  if (from === null) return to;
  return to.map((corner, index) => ({
    x: from[index].x + (corner.x - from[index].x) * amount,
    y: from[index].y + (corner.y - from[index].y) * amount,
  }));
}
