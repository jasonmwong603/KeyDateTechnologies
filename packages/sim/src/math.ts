/** Minimal 3D math. Plain objects, no classes — these get copied and diffed a lot. */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest-path angular interpolation, so avatars never spin the long way round. */
export function lerpAngle(a: number, b: number, t: number): number {
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

export function lengthXZ(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

/**
 * Scales an XZ vector to at most `max` length.
 *
 * This is what stops diagonal movement being faster than cardinal movement —
 * the classic bug where holding W+D outruns holding W alone.
 */
export function clampLengthXZ(x: number, z: number, max: number): { x: number; z: number } {
  const length = lengthXZ(x, z);
  if (length <= max || length === 0) return { x, z };
  const scale = max / length;
  return { x: x * scale, z: z * scale };
}

/** Axis-aligned bounding box, stored as min/max corners. */
export interface AABB {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export function aabb(
  centerX: number,
  centerY: number,
  centerZ: number,
  sizeX: number,
  sizeY: number,
  sizeZ: number,
): AABB {
  const hx = sizeX / 2;
  const hz = sizeZ / 2;
  return {
    minX: centerX - hx,
    minY: centerY,
    minZ: centerZ - hz,
    maxX: centerX + hx,
    maxY: centerY + sizeY,
    maxZ: centerZ + hz,
  };
}

export function aabbOverlaps(a: AABB, b: AABB): boolean {
  return (
    a.minX < b.maxX &&
    a.maxX > b.minX &&
    a.minY < b.maxY &&
    a.maxY > b.minY &&
    a.minZ < b.maxZ &&
    a.maxZ > b.minZ
  );
}

export function distanceXZ(ax: number, az: number, bx: number, bz: number): number {
  return lengthXZ(ax - bx, az - bz);
}
