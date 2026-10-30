import * as THREE from 'three';
import { createRng } from '@keydate/netcode';

/**
 * Procedurally generated surface textures for the floor.
 *
 * These are drawn to canvases at load rather than shipped as image files. The
 * client has no bundler and no asset pipeline, so an image would mean binary
 * blobs in the repository and another thing to serve; a few hundred lines of
 * canvas drawing costs nothing to transfer and stays editable — every colour
 * and proportion below is a number someone can change and immediately see.
 *
 * Every generator is seeded. Two players standing in the same room must see the
 * same stone veining and the same scrollwork, or screenshots and bug reports
 * stop matching each other.
 */

/** Tile resolution. 512 is enough at the distances anything here is viewed from. */
const TILE = 512;

function makeCanvas(size = TILE) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

/** Wraps a canvas as a repeating sRGB texture. */
function toTexture(canvas, repeatX, repeatY) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  return texture;
}

/** Non-colour data (roughness, bump) must not be sRGB-decoded. */
function toDataTexture(canvas, repeatX, repeatY) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  return texture;
}

/**
 * Builds a height map from a drawing's own luminance.
 *
 * These stone surfaces are near-monochrome and are shaded so that carved
 * recesses are painted dark and lit rims painted bright — which is exactly the
 * relationship a bump map wants. Deriving it from the artwork keeps the relief
 * aligned with the carving for free; hand-authoring a second map would just be
 * an opportunity for the two to drift apart.
 */
function deriveBump(source, contrast = 1.25) {
  const size = source.width;
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0);

  const image = ctx.getImageData(0, 0, size, size);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const pushed = Math.max(0, Math.min(255, (luma - 128) * contrast + 128));
    data[i] = pushed;
    data[i + 1] = pushed;
    data[i + 2] = pushed;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** Fine speckle, the thing that stops any flat fill reading as painted card. */
function speckle(ctx, size, rng, count, lightAlpha, darkAlpha) {
  for (let i = 0; i < count; i += 1) {
    const x = rng.next() * size;
    const y = rng.next() * size;
    const r = 0.5 + rng.next() * 1.8;
    ctx.fillStyle =
      rng.next() > 0.5 ? `rgba(255,255,255,${lightAlpha})` : `rgba(0,0,0,${darkAlpha})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// Floor — black carpet with red scrollwork
// ---------------------------------------------------------------------------

/**
 * One inward-curling scroll.
 *
 * The radius falls off as a power of the parameter rather than linearly, which
 * tightens the curl toward the centre — a linear spiral looks like a clock
 * spring, not like brushwork.
 */
function drawScroll(ctx, cx, cy, radius, rotation, turns, width, color, tipDot) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();

  const STEPS = 72;
  let tipX = cx;
  let tipY = cy;
  for (let i = 0; i <= STEPS; i += 1) {
    const t = i / STEPS;
    const angle = rotation + t * turns * Math.PI * 2;
    const r = radius * Math.pow(1 - t, 0.85);
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    tipX = x;
    tipY = y;
  }
  ctx.stroke();

  // A blunt terminal dot. Real woven scrollwork almost always ends in one, and
  // without it every curl tapers to an identical thin point.
  if (tipDot) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(tipX, tipY, width * 0.85, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Draws the carpet: near-black ground under layered red scrollwork.
 *
 * Every scroll is stamped nine times — once in place and once for each
 * neighbouring tile position — so curls that run off an edge continue onto the
 * opposite one and the tiling seam disappears.
 */
function drawCarpetTile(ctx, size, rng) {
  const INK = '#0b0708';

  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, size, size);

  // Uneven ground, so the black is pile rather than a void.
  for (let i = 0; i < 60; i += 1) {
    const x = rng.next() * size;
    const y = rng.next() * size;
    const r = size * (0.05 + rng.next() * 0.22);
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, 'rgba(70,18,22,0.18)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  /**
   * Draws a motif, repeating it into neighbouring tile positions only when it
   * actually crosses an edge.
   *
   * Stamping all nine positions unconditionally is nine times the drawing for
   * an identical result, and this tile is built on the main thread while the
   * player waits to enter the world.
   */
  const stamp = (cx, cy, reach, draw) => {
    const left = cx - reach < 0;
    const right = cx + reach > size;
    const top = cy - reach < 0;
    const bottom = cy + reach > size;

    draw(0, 0);
    if (left) draw(size, 0);
    if (right) draw(-size, 0);
    if (top) draw(0, size);
    if (bottom) draw(0, -size);
    if (left && top) draw(size, size);
    if (right && top) draw(-size, size);
    if (left && bottom) draw(size, -size);
    if (right && bottom) draw(-size, -size);
  };

  /**
   * Three passes, back to front. The deep maroon layer sits far enough back to
   * read as shadow between the bright scrolls; drawing everything at one
   * brightness flattens the whole pattern into noise.
   */
  const layers = [
    { count: 8, color: 'rgba(92,20,26,0.92)', min: 0.26, max: 0.48, width: [12, 24], dot: false },
    { count: 9, color: '#b4122b', min: 0.18, max: 0.36, width: [6, 12], dot: true },
    { count: 8, color: '#e0243f', min: 0.14, max: 0.3, width: [4, 8], dot: true },
    { count: 2, color: '#e8901c', min: 0.14, max: 0.26, width: [3.5, 6], dot: true },
  ];

  for (const layer of layers) {
    for (let i = 0; i < layer.count; i += 1) {
      const cx = rng.next() * size;
      const cy = rng.next() * size;
      const radius = size * (layer.min + rng.next() * (layer.max - layer.min));
      const rotation = rng.next() * Math.PI * 2;
      const turns = 0.75 + rng.next() * 1.1;
      const width = layer.width[0] + rng.next() * (layer.width[1] - layer.width[0]);
      stamp(cx, cy, radius + width, (dx, dy) =>
        drawScroll(ctx, cx + dx, cy + dy, radius, rotation, turns, width, layer.color, layer.dot),
      );
    }
  }

  speckle(ctx, size, rng, 3200, 0.045, 0.16);
}

export function createCarpet(repeatX = 30, repeatY = 22) {
  const canvas = makeCanvas();
  drawCarpetTile(canvas.getContext('2d'), TILE, createRng(0xca5140));
  return { map: toTexture(canvas, repeatX, repeatY) };
}

// ---------------------------------------------------------------------------
// Golden stone — shared palette for walls and ceiling
// ---------------------------------------------------------------------------

const STONE = {
  base: '#d7b167',
  light: '#f0d79c',
  mid: '#c39a4e',
  deep: '#9a7332',
  shadow: 'rgba(88,62,22,0.55)',
  lit: 'rgba(255,245,214,0.5)',
};

/** Warm honey limestone ground, before anything is carved into it. */
function paintStoneGround(ctx, size, rng) {
  ctx.fillStyle = STONE.base;
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 44; i += 1) {
    const x = rng.next() * size;
    const y = rng.next() * size;
    const r = size * (0.07 + rng.next() * 0.24);
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, rng.next() > 0.5 ? 'rgba(240,215,156,0.30)' : 'rgba(154,115,50,0.26)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Bedding veins.
  for (let i = 0; i < 18; i += 1) {
    const y = rng.next() * size;
    ctx.strokeStyle = `rgba(150,112,48,${0.08 + rng.next() * 0.14})`;
    ctx.lineWidth = 0.6 + rng.next() * 2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    let cy = y;
    for (let x = 0; x <= size; x += size / 8) {
      cy += (rng.next() - 0.5) * 5;
      ctx.lineTo(x, cy);
    }
    ctx.stroke();
  }

  speckle(ctx, size, rng, 700, 0.1, 0.1);
}

/**
 * A carved recess with a lit top edge and a shadowed bottom edge.
 *
 * Which edge gets which is what tells the eye whether a panel is sunk into the
 * wall or standing proud of it. Everything here is lit from above, so: shadow
 * under the top lip, light on the bottom lip.
 */
function carveRecess(ctx, x, y, w, h, depth) {
  ctx.fillStyle = STONE.mid;
  ctx.fillRect(x, y, w, h);

  ctx.fillStyle = STONE.shadow;
  ctx.fillRect(x, y, w, depth);
  ctx.fillRect(x, y, depth, h);

  ctx.fillStyle = STONE.lit;
  ctx.fillRect(x, y + h - depth, w, depth);
  ctx.fillRect(x + w - depth, y, depth, h);
}

/** A carved rosette — the standard centrepiece of a coffer or a wall panel. */
function carveRosette(ctx, cx, cy, radius) {
  ctx.fillStyle = STONE.deep;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  const PETALS = 8;
  for (let p = 0; p < PETALS; p += 1) {
    const a = (p / PETALS) * Math.PI * 2;
    // Lit face, then a shadow offset below it — two overlapping ellipses is
    // enough to make a flat petal look modelled.
    ctx.fillStyle = STONE.shadow;
    ctx.beginPath();
    ctx.ellipse(
      cx + Math.cos(a) * radius * 0.52,
      cy + Math.sin(a) * radius * 0.52 + radius * 0.06,
      radius * 0.3,
      radius * 0.15,
      a,
      0,
      Math.PI * 2,
    );
    ctx.fill();

    ctx.fillStyle = STONE.light;
    ctx.beginPath();
    ctx.ellipse(
      cx + Math.cos(a) * radius * 0.52,
      cy + Math.sin(a) * radius * 0.52,
      radius * 0.28,
      radius * 0.14,
      a,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }

  ctx.fillStyle = STONE.light;
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.17, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = STONE.deep;
  ctx.beginPath();
  ctx.arc(cx + radius * 0.03, cy + radius * 0.05, radius * 0.1, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Ceiling — coffered golden stone
// ---------------------------------------------------------------------------

/**
 * A coffered ceiling: sunken stone panels in a heavy grid, rosette in each.
 *
 * This is the Pantheon's ceiling, and it is what "luxury stone" means overhead
 * — the depth comes from the coffers, not from colour, so it stays calm no
 * matter how long you look at it.
 */
function drawCofferTile(ctx, size, rng) {
  paintStoneGround(ctx, size, rng);

  const CELLS = 2;
  const cell = size / CELLS;

  for (let gy = 0; gy < CELLS; gy += 1) {
    for (let gx = 0; gx < CELLS; gx += 1) {
      const ox = gx * cell;
      const oy = gy * cell;
      const rib = cell * 0.11;
      const depth = cell * 0.035;

      // Successive recesses, each smaller — a stepped coffer, which catches
      // the light in concentric bands the way a single flat recess never does.
      carveRecess(ctx, ox + rib, oy + rib, cell - rib * 2, cell - rib * 2, depth);
      carveRecess(
        ctx,
        ox + rib * 1.9,
        oy + rib * 1.9,
        cell - rib * 3.8,
        cell - rib * 3.8,
        depth * 0.8,
      );

      carveRosette(ctx, ox + cell / 2, oy + cell / 2, cell * 0.17);

      // Lit highlight along the top of each rib.
      ctx.fillStyle = STONE.light;
      ctx.fillRect(ox, oy, cell, rib * 0.22);
      ctx.fillStyle = 'rgba(120,88,34,0.35)';
      ctx.fillRect(ox, oy + rib - rib * 0.22, cell, rib * 0.22);
    }
  }

  speckle(ctx, size, rng, 500, 0.06, 0.07);
}

export function createCofferedStone(repeatX = 5, repeatY = 4) {
  const canvas = makeCanvas();
  drawCofferTile(canvas.getContext('2d'), TILE, createRng(0xc0ffee));
  return {
    map: toTexture(canvas, repeatX, repeatY),
    bumpMap: toDataTexture(deriveBump(canvas, 1.35), repeatX, repeatY),
  };
}

// ---------------------------------------------------------------------------
// Walls — sculpted golden stone
// ---------------------------------------------------------------------------

/**
 * Ashlar courses with a carved panel and rosette in each block.
 *
 * A plain stone wall at this scale is a beige rectangle. The carving is what
 * gives the eye something to measure the room against as you walk past it.
 */
function drawSculptedStoneTile(ctx, size, rng) {
  paintStoneGround(ctx, size, rng);

  const COURSES = 2;
  const courseHeight = size / COURSES;

  for (let c = 0; c < COURSES; c += 1) {
    const top = c * courseHeight;
    // Alternate courses are offset so the vertical joints bond rather than
    // stacking into a continuous seam.
    const offset = c % 2 === 0 ? 0 : size * 0.25;

    for (let b = -1; b < 2; b += 1) {
      const left = offset + b * (size / 2);
      const w = size / 2;
      const inset = w * 0.08;

      carveRecess(
        ctx,
        left + inset,
        top + courseHeight * 0.14,
        w - inset * 2,
        courseHeight * 0.72,
        size * 0.009,
      );

      // Rosettes on alternate blocks only. One in every panel turns a wall
      // into wallpaper — the repeat becomes the first thing you see.
      if ((b + c) % 2 === 0) {
        carveRosette(ctx, left + w / 2, top + courseHeight * 0.5, Math.min(w, courseHeight) * 0.13);
      }

      // Block joint down the right-hand side.
      ctx.fillStyle = STONE.shadow;
      ctx.fillRect(left + w - size * 0.006, top, size * 0.006, courseHeight);
      ctx.fillStyle = STONE.lit;
      ctx.fillRect(left + w, top, size * 0.004, courseHeight);
    }

    // Course joint.
    ctx.fillStyle = STONE.shadow;
    ctx.fillRect(0, top, size, size * 0.008);
    ctx.fillStyle = STONE.lit;
    ctx.fillRect(0, top + size * 0.008, size, size * 0.005);
  }

  speckle(ctx, size, rng, 600, 0.07, 0.08);
}

export function createSculptedStone(repeatX = 8, repeatY = 2) {
  const canvas = makeCanvas();
  drawSculptedStoneTile(canvas.getContext('2d'), TILE, createRng(0x5c0175));

  const rough = makeCanvas(256);
  const rctx = rough.getContext('2d');
  rctx.fillStyle = '#8e8e8e';
  rctx.fillRect(0, 0, 256, 256);
  speckle(rctx, 256, createRng(0x5c0176), 900, 0.35, 0.25);

  return {
    map: toTexture(canvas, repeatX, repeatY),
    bumpMap: toDataTexture(deriveBump(canvas, 1.3), repeatX, repeatY),
    roughnessMap: toDataTexture(rough, repeatX, repeatY),
  };
}

/**
 * Returns a clone of `texture` tiled for a surface of the given size.
 *
 * Walls here are not all the same shape, and one shared texture stretches the
 * stone on the long ones. Cloning shares the underlying image — only the
 * repeat differs — so this costs no extra memory for the bitmap.
 */
export function tiledFor(texture, width, height, metresPerTile = 4) {
  const clone = texture.clone();
  clone.needsUpdate = true;
  clone.wrapS = THREE.RepeatWrapping;
  clone.wrapT = THREE.RepeatWrapping;
  clone.repeat.set(
    Math.max(1, Math.round(width / metresPerTile)),
    Math.max(1, Math.round(height / metresPerTile)),
  );
  return clone;
}
