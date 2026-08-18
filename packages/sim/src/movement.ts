import {
  AIR_ACCEL,
  GRAVITY,
  GROUND_ACCEL,
  GROUND_EPSILON,
  GROUND_FRICTION,
  JUMP_VELOCITY,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  SPRINT_SPEED,
  WALK_SPEED,
} from './constants.js';
import { aabbOverlaps, clamp, clampLengthXZ, type AABB } from './math.js';
import type { World } from './world.js';

/**
 * The authoritative movement step.
 *
 * This function is the reason the monorepo exists. The server runs it to decide
 * where a player actually is; the client runs the *identical* code to predict
 * its own movement without waiting a round trip, and to replay unacknowledged
 * inputs when a correction arrives. Any divergence between the two — a stray
 * `Math.random()`, a `Date.now()`, a dependence on render framerate — surfaces
 * as rubber-banding, so this file is strictly a pure function of
 * (state, input, world, dt).
 */

export interface MoveInput {
  /** Strafe axis, -1..1. */
  moveX: number;
  /** Forward axis, -1..1. */
  moveZ: number;
  yaw: number;
  pitch: number;
  jump: boolean;
  sprint: boolean;
}

export interface PlayerPhysicsState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  grounded: boolean;
  /** Interactable id when seated at a table, else null. Seated players do not move. */
  seatedAt: number | null;
}

export function createPlayerState(
  x: number,
  y: number,
  z: number,
  yaw: number,
): PlayerPhysicsState {
  return { x, y, z, vx: 0, vy: 0, vz: 0, yaw, pitch: 0, grounded: true, seatedAt: null };
}

/** The player's collision box at a hypothetical position. */
function playerBox(x: number, y: number, z: number): AABB {
  return {
    minX: x - PLAYER_RADIUS,
    minY: y,
    minZ: z - PLAYER_RADIUS,
    maxX: x + PLAYER_RADIUS,
    maxY: y + PLAYER_HEIGHT,
    maxZ: z + PLAYER_RADIUS,
  };
}

function collidesAt(world: World, x: number, y: number, z: number): boolean {
  const box = playerBox(x, y, z);
  for (const collider of world.colliders) {
    if (aabbOverlaps(box, collider)) return true;
  }
  return false;
}

/**
 * Advances one player by exactly one tick.
 *
 * Returns a new state object; the input state is never mutated, so callers can
 * keep a history of past states for reconciliation without defensive copying.
 */
export function stepPlayer(
  state: PlayerPhysicsState,
  input: MoveInput,
  world: World,
  dt: number,
): PlayerPhysicsState {
  const next: PlayerPhysicsState = { ...state };

  // Look direction is always accepted verbatim: it is already clamped by the
  // protocol validator, and fighting the client over aim only adds latency.
  next.yaw = input.yaw;
  next.pitch = input.pitch;

  // A seated player is parked. Their body stays on the seat anchor and only
  // their head turns, so leaving the table is the one way to move again.
  if (next.seatedAt !== null) {
    next.vx = 0;
    next.vy = 0;
    next.vz = 0;
    next.grounded = true;
    return next;
  }

  // --- Desired horizontal velocity, in world space -------------------------
  const maxSpeed = input.sprint ? SPRINT_SPEED : WALK_SPEED;
  const sin = Math.sin(input.yaw);
  const cos = Math.cos(input.yaw);
  // `moveZ` is forward along yaw, `moveX` is to its right.
  //
  // Forward is (cos yaw, sin yaw). Right is that turned a quarter turn the way
  // the camera considers right, which is (-sin yaw, cos yaw) — the camera maps
  // sim yaw to -yaw - PI/2, so at yaw 0 it faces +x and its right axis is +z.
  //
  // Negating the strafe term here is the easy mistake, and it does not look
  // like a bug in code: the player simply walks left when they press D.
  const rawX = input.moveZ * cos - input.moveX * sin;
  const rawZ = input.moveZ * sin + input.moveX * cos;
  const desired = clampLengthXZ(rawX, rawZ, 1);
  const targetVx = desired.x * maxSpeed;
  const targetVz = desired.z * maxSpeed;

  const hasInput = desired.x !== 0 || desired.z !== 0;
  const accel = next.grounded ? GROUND_ACCEL : AIR_ACCEL;

  // Accelerate along the velocity error as a vector, not per axis.
  //
  // Stepping vx and vz independently by the same amount means the axis with
  // the smaller change arrives first, so a player starting from rest at, say,
  // 40 degrees drifts noticeably off their heading for the first few ticks
  // before straightening out. You aim one way and set off slightly another.
  //
  // Friction only bites on the ground; in the air you keep your momentum.
  const targets = hasInput ? { x: targetVx, z: targetVz } : { x: 0, z: 0 };
  const maxDelta = hasInput ? accel * dt : next.grounded ? GROUND_FRICTION * dt : 0;

  if (maxDelta > 0) {
    const dvx = targets.x - next.vx;
    const dvz = targets.z - next.vz;
    // Math.sqrt is IEEE-exact; Math.hypot's precision is implementation
    // defined, which is exactly the kind of thing that desyncs prediction.
    const distance = Math.sqrt(dvx * dvx + dvz * dvz);

    if (distance <= maxDelta) {
      next.vx = targets.x;
      next.vz = targets.z;
    } else {
      next.vx += (dvx / distance) * maxDelta;
      next.vz += (dvz / distance) * maxDelta;
    }
  }

  // --- Vertical ------------------------------------------------------------
  if (input.jump && next.grounded) {
    next.vy = JUMP_VELOCITY;
    next.grounded = false;
  }
  next.vy -= GRAVITY * dt;

  // --- Integrate with per-axis collision resolution ------------------------
  // Resolving one axis at a time is what lets a player slide along a wall
  // instead of sticking to it when they walk into it at an angle.
  const stepX = next.vx * dt;
  if (!collidesAt(world, next.x + stepX, next.y, next.z)) {
    next.x += stepX;
  } else {
    next.vx = 0;
  }

  const stepZ = next.vz * dt;
  if (!collidesAt(world, next.x, next.y, next.z + stepZ)) {
    next.z += stepZ;
  } else {
    next.vz = 0;
  }

  const stepY = next.vy * dt;
  if (!collidesAt(world, next.x, next.y + stepY, next.z)) {
    next.y += stepY;
    next.grounded = false;
  } else {
    // Landing on something (falling) grounds the player; hitting a ceiling
    // (rising) just kills the upward velocity.
    if (next.vy <= 0) next.grounded = true;
    next.vy = 0;
  }

  // --- Floor and bounds ----------------------------------------------------
  if (next.y <= 0) {
    next.y = 0;
    if (next.vy < 0) next.vy = 0;
    next.grounded = true;
  } else if (next.grounded && !collidesAt(world, next.x, next.y - GROUND_EPSILON, next.z)) {
    // Walked off a ledge.
    next.grounded = false;
  }

  next.x = clamp(next.x, world.bounds.minX + PLAYER_RADIUS, world.bounds.maxX - PLAYER_RADIUS);
  next.z = clamp(next.z, world.bounds.minZ + PLAYER_RADIUS, world.bounds.maxZ - PLAYER_RADIUS);

  return next;
}
