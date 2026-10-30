import { describe, expect, it } from 'vitest';
import { PLAYER_RADIUS, TICK_DT, WALK_SPEED } from './constants.js';
import { createPlayerState, stepPlayer, type MoveInput } from './movement.js';
import { buildCasinoFloor, type World } from './world.js';
import { buttonsToMoveInput, INPUT_BUTTON_SPRINT } from '@keydate/protocol';

const world: World = buildCasinoFloor();

function input(overrides: Partial<MoveInput> = {}): MoveInput {
  return { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, sprint: false, ...overrides };
}

function run(
  state: ReturnType<typeof createPlayerState>,
  frame: MoveInput,
  ticks: number,
): ReturnType<typeof createPlayerState> {
  let current = state;
  for (let i = 0; i < ticks; i += 1) current = stepPlayer(current, frame, world, TICK_DT);
  return current;
}

describe('stepPlayer', () => {
  it('does not mutate the state it is given', () => {
    const start = createPlayerState(0, 0, 10, 0);
    const snapshot = { ...start };
    stepPlayer(start, input({ moveZ: 1 }), world, TICK_DT);
    expect(start).toEqual(snapshot);
  });

  it('is deterministic: identical inputs from identical state give identical output', () => {
    const start = createPlayerState(0, 0, 10, 0.7);
    const frames = [
      input({ moveZ: 1, yaw: 0.7 }),
      input({ moveX: 1, yaw: 0.9, jump: true }),
      input({ moveZ: -1, yaw: 1.2, sprint: true }),
    ];

    let a = start;
    let b = start;
    for (const frame of frames) {
      a = stepPlayer(a, frame, world, TICK_DT);
      b = stepPlayer(b, frame, world, TICK_DT);
    }

    // Bit-for-bit equality is the requirement, not approximate agreement:
    // client prediction and server authority must never disagree at all.
    expect(a).toEqual(b);
  });

  it('accelerates toward walk speed and stops accelerating there', () => {
    const start = createPlayerState(0, 0, 10, 0);
    const moving = run(start, input({ moveZ: 1, yaw: 0 }), 60);
    const speed = Math.hypot(moving.vx, moving.vz);
    expect(speed).toBeCloseTo(WALK_SPEED, 5);
  });

  /**
   * The camera maps sim yaw to `-yaw - PI/2`, so at yaw 0 the player faces +x
   * and the camera's right axis is +z. These are the vectors every direction
   * test below is measured against.
   */
  const forwardOf = (yaw: number) => ({ x: Math.cos(yaw), z: Math.sin(yaw) });
  const rightOf = (yaw: number) => ({ x: -Math.sin(yaw), z: Math.cos(yaw) });

  /**
   * Open floor, clear of the central bar and every table.
   *
   * The origin is inside the bar's collider, so a player started there cannot
   * move in any direction and every direction assertion reads zero.
   */
  const OPEN_FLOOR = { x: 0, z: 12 };

  /** How far a step went along `axis`, in metres. */
  function along(
    from: { x: number; z: number },
    to: { x: number; z: number },
    axis: { x: number; z: number },
  ): number {
    return (to.x - from.x) * axis.x + (to.z - from.z) * axis.z;
  }

  it('walks forward along the facing direction', () => {
    // Several yaws, because a sign error can be invisible at yaw 0.
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7]) {
      const start = createPlayerState(OPEN_FLOOR.x, 0, OPEN_FLOOR.z, yaw);
      const moved = run(start, input({ moveZ: 1, yaw }), 20);
      expect(along(start, moved, forwardOf(yaw))).toBeGreaterThan(0.5);
      // And essentially nothing sideways.
      expect(Math.abs(along(start, moved, rightOf(yaw)))).toBeLessThan(1e-9);
    }
  });

  it('walks backward when moveZ is negative', () => {
    for (const yaw of [0, 1.2, -2.4]) {
      const start = createPlayerState(OPEN_FLOOR.x, 0, OPEN_FLOOR.z, yaw);
      const moved = run(start, input({ moveZ: -1, yaw }), 20);
      expect(along(start, moved, forwardOf(yaw))).toBeLessThan(-0.5);
    }
  });

  it('strafes to the right of the facing direction, not the left', () => {
    // The regression this exists for: negating the strafe term makes D walk
    // left. Nothing else in the suite would notice, because the speed, the
    // collision behaviour and the determinism are all unchanged by the sign.
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 2.1]) {
      const start = createPlayerState(OPEN_FLOOR.x, 0, OPEN_FLOOR.z, yaw);
      const moved = run(start, input({ moveX: 1, yaw }), 20);
      expect(along(start, moved, rightOf(yaw))).toBeGreaterThan(0.5);
      expect(Math.abs(along(start, moved, forwardOf(yaw)))).toBeLessThan(1e-9);
    }
  });

  it('strafes left when moveX is negative', () => {
    for (const yaw of [0, 1.2, -2.4]) {
      const start = createPlayerState(OPEN_FLOOR.x, 0, OPEN_FLOOR.z, yaw);
      const moved = run(start, input({ moveX: -1, yaw }), 20);
      expect(along(start, moved, rightOf(yaw))).toBeLessThan(-0.5);
    }
  });

  it('moves forward-right on W and D together', () => {
    const yaw = 0.4;
    const start = createPlayerState(OPEN_FLOOR.x, 0, OPEN_FLOOR.z, yaw);
    const moved = run(start, input({ moveZ: 1, moveX: 1, yaw }), 20);
    expect(along(start, moved, forwardOf(yaw))).toBeGreaterThan(0.3);
    expect(along(start, moved, rightOf(yaw))).toBeGreaterThan(0.3);
  });

  it('does not let diagonal movement outrun cardinal movement', () => {
    const start = createPlayerState(0, 0, 10, 0);
    const cardinal = run(start, input({ moveZ: 1 }), 60);
    const diagonal = run(start, input({ moveZ: 1, moveX: 1 }), 60);

    expect(Math.hypot(diagonal.vx, diagonal.vz)).toBeCloseTo(
      Math.hypot(cardinal.vx, cardinal.vz),
      5,
    );
  });

  it('comes to rest when input stops', () => {
    const moving = run(createPlayerState(0, 0, 10, 0), input({ moveZ: 1 }), 30);
    const stopped = run(moving, input(), 30);
    expect(Math.hypot(stopped.vx, stopped.vz)).toBeCloseTo(0, 6);
  });

  it('keeps the player inside the world bounds', () => {
    // Walk hard at the wall for far longer than it takes to reach it.
    const pushed = run(createPlayerState(0, 0, 10, 0), input({ moveZ: 1, yaw: Math.PI / 2 }), 400);
    expect(pushed.z).toBeLessThanOrEqual(world.bounds.maxZ - PLAYER_RADIUS + 1e-9);
    expect(pushed.z).toBeGreaterThanOrEqual(world.bounds.minZ + PLAYER_RADIUS - 1e-9);
  });

  it('does not walk through the central bar', () => {
    // The bar is a 6x6 box at the origin. Start east of it and walk west.
    const start = createPlayerState(8, 0, 0, Math.PI);
    const blocked = run(start, input({ moveZ: 1, yaw: Math.PI }), 200);
    // Its eastern face is at x = 3; the player's box must stop short of it.
    expect(blocked.x).toBeGreaterThan(3);
  });

  it('slides along a wall instead of sticking to it', () => {
    // Approach the 6x6 bar at the origin diagonally: the x axis gets blocked
    // while the z axis stays free. Stop before the player rounds the corner.
    const start = createPlayerState(8, 0, -4, 0);
    const sliding = run(start, input({ moveZ: 1, yaw: Math.PI * 0.75 }), 60);

    // Still outside the bar's eastern face, pressed up against it.
    expect(sliding.x).toBeGreaterThan(3);
    expect(sliding.x).toBeLessThan(3.5);
    // ...but movement along the unblocked axis continued rather than halting.
    expect(sliding.z).toBeGreaterThan(1);
    expect(sliding.vx).toBe(0);
  });

  it('lets a blocked player round the corner once past the obstacle', () => {
    const start = createPlayerState(8, 0, -4, 0);
    const past = run(start, input({ moveZ: 1, yaw: Math.PI * 0.75 }), 90);
    // Clear of the bar's northern face, so the x axis is free again.
    expect(past.z).toBeGreaterThan(3.35);
    expect(past.x).toBeLessThan(3);
  });

  it('jumps and lands back on the floor', () => {
    const start = createPlayerState(0, 0, 10, 0);
    const airborne = stepPlayer(start, input({ jump: true }), world, TICK_DT);
    expect(airborne.grounded).toBe(false);
    expect(airborne.y).toBeGreaterThan(0);

    const landed = run(airborne, input(), 120);
    expect(landed.y).toBe(0);
    expect(landed.grounded).toBe(true);
  });

  it('cannot double jump', () => {
    const start = createPlayerState(0, 0, 10, 0);
    const first = stepPlayer(start, input({ jump: true }), world, TICK_DT);
    const second = stepPlayer(first, input({ jump: true }), world, TICK_DT);
    // Velocity must be falling under gravity, not reset by a second jump.
    expect(second.vy).toBeLessThan(first.vy);
  });

  it('freezes a seated player but still lets them look around', () => {
    const seated = { ...createPlayerState(5, 0, 5, 0), seatedAt: 1 };
    const after = stepPlayer(seated, input({ moveZ: 1, yaw: 2, pitch: 0.4 }), world, TICK_DT);

    expect(after.x).toBe(5);
    expect(after.z).toBe(5);
    expect(after.vx).toBe(0);
    expect(after.vz).toBe(0);
    expect(after.yaw).toBe(2);
    expect(after.pitch).toBe(0.4);
  });
});

describe('the wire frame the simulation is actually fed', () => {
  /**
   * The client and the server both run `stepPlayer`, which is the whole point
   * of sharing `packages/sim` — but sharing the simulation is worth nothing if
   * the two disagree about what they feed it.
   *
   * They did. The wire carries the buttons as a bitmask; `stepPlayer` wants
   * `jump` and `sprint` as booleans. The server unpacked them and the client
   * handed the raw frame straight over, so `input.sprint` was `undefined` in
   * every predicted step. The client predicted a walk while the server ran a
   * sprint, and every tick of holding the key was a correction — rubber-banding
   * that nothing reported, because the corrections still landed the player
   * roughly where they belonged.
   */
  it('runs at walking pace when the flags are missing rather than sprinting', () => {
    const raw = { moveX: 0, moveZ: 1, yaw: 0, pitch: 0 } as unknown as MoveInput;
    const stepped = run(createPlayerState(0, 0, 10, 0), raw, 20);
    const speed = Math.hypot(stepped.vx, stepped.vz);

    // Not a bug in `stepPlayer`: given no sprint it is right to walk. It is the
    // reason the omission was invisible — the wrong answer looks like a
    // perfectly ordinary one.
    expect(speed).toBeCloseTo(WALK_SPEED, 5);
  });

  it('sprints when the flag is there, which is what the client must reproduce', () => {
    const walking = run(createPlayerState(0, 0, 10, 0), input({ moveZ: 1 }), 20);
    const sprinting = run(createPlayerState(0, 0, 10, 0), input({ moveZ: 1, sprint: true }), 20);

    expect(Math.hypot(sprinting.vx, sprinting.vz)).toBeGreaterThan(
      Math.hypot(walking.vx, walking.vz) * 1.3,
    );
  });

  it('agrees with itself whichever side unpacked the buttons', () => {
    // Both sides now go through `buttonsToMoveInput`. This is what that buys:
    // identical input in, identical state out, tick for tick.
    const held = INPUT_BUTTON_SPRINT;
    const shared = { moveX: 0, moveZ: 1, yaw: 0.4, pitch: 0, ...buttonsToMoveInput(held) };

    const asServer = run(createPlayerState(0, 0, 10, 0), shared, 30);
    const asClient = run(createPlayerState(0, 0, 10, 0), { ...shared }, 30);
    expect(asClient).toEqual(asServer);
  });
});
