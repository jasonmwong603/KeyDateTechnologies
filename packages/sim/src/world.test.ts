import { describe, expect, it } from 'vitest';
import { INTERACT_RANGE, PLAYER_RADIUS, TICK_DT } from './constants.js';
import { distanceXZ } from './math.js';
import { createPlayerState, stepPlayer, type MoveInput } from './movement.js';
import { buildCasinoFloor } from './world.js';

/**
 * The floor plan, checked as geometry rather than as a picture.
 *
 * Everything here is shared by the server and every client's prediction, so a
 * table placed where a player cannot reach it, or a seat inside a wall, is a
 * bug that shows up identically on every machine and is invisible in code
 * review.
 */

const world = buildCasinoFloor();

function input(overrides: Partial<MoveInput> = {}): MoveInput {
  return { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, sprint: false, ...overrides };
}

describe('the casino floor', () => {
  it('puts six tables out, across five games', () => {
    const tables = world.interactables.filter((entry) => entry.kind === 'table');
    expect(tables).toHaveLength(6);
    expect(new Set(tables.map((table) => table.gameId)).size).toBe(5);
  });

  it('gives every table six seats', () => {
    for (const table of world.interactables.filter((entry) => entry.kind === 'table')) {
      expect(table.seats).toHaveLength(6);
    }
  });

  it('gives every seat a stool you cannot walk through', () => {
    // Seats used to be a translucent disc painted on the floor. A stool that is
    // only a picture is worse than no stool, so each one is a real collider.
    const stools = world.colliders.filter((box) => box.kind === 'seat');
    expect(stools).toHaveLength(36);

    for (const table of world.interactables.filter((entry) => entry.kind === 'table')) {
      for (const seat of table.seats) {
        const stool = stools.find(
          (box) =>
            Math.abs((box.minX + box.maxX) / 2 - seat.x) < 0.001 &&
            Math.abs((box.minZ + box.maxZ) / 2 - seat.z) < 0.001,
        );
        expect(stool).toBeDefined();
      }
    }
  });

  it('keeps the stools low enough to see the felt over', () => {
    // The table top is at 1.0m. A stool taller than that would hide the cards
    // from anybody sitting on the far side.
    for (const stool of world.colliders.filter((box) => box.kind === 'seat')) {
      expect(stool.maxY).toBeLessThan(1.0);
    }
  });

  it('leaves room to walk between neighbouring stools', () => {
    // Six stools ringing a table must not wall it off. The gap has to clear a
    // player's own width, or a table becomes reachable only from the angles
    // that happen to line up with a gap.
    const table = world.interactables.find((entry) => entry.kind === 'table')!;
    const [first, second] = table.seats;
    const gap = distanceXZ(first!.x, first!.z, second!.x, second!.z) - 0.62;
    expect(gap).toBeGreaterThan(PLAYER_RADIUS * 2 + 0.3);
  });

  it('never spawns a player inside anything', () => {
    for (const spawn of world.spawns) {
      const state = createPlayerState(spawn.x, spawn.y, spawn.z, spawn.yaw);
      // One idle step: if the spawn were inside geometry, collision resolution
      // would shove the player somewhere else immediately.
      const stepped = stepPlayer(state, input({ yaw: spawn.yaw }), world, TICK_DT);
      expect(stepped.x).toBeCloseTo(spawn.x, 6);
      expect(stepped.z).toBeCloseTo(spawn.z, 6);
    }
  });

  it('lets a player walk up to every table from the open floor', () => {
    // The check the stools could plausibly have broken. Walking straight at a
    // table from eight directions must get close enough to interact from every
    // one of them, sliding around a stool where necessary.
    for (const table of world.interactables.filter((entry) => entry.kind === 'table')) {
      for (let degrees = 0; degrees < 360; degrees += 45) {
        const angle = (degrees * Math.PI) / 180;
        // Start well outside the seat ring and walk inward.
        let state = createPlayerState(
          table.x + Math.cos(angle) * 5,
          0,
          table.z + Math.sin(angle) * 5,
          angle + Math.PI,
        );

        let closest = Infinity;
        for (let tick = 0; tick < 200; tick += 1) {
          state = stepPlayer(state, input({ moveZ: 1, yaw: angle + Math.PI }), world, TICK_DT);
          closest = Math.min(closest, distanceXZ(state.x, state.z, table.x, table.z));
        }

        // Has to be reachable, not merely approachable: getting within
        // INTERACT_RANGE is what lets the player actually sit down.
        expect(closest).toBeLessThan(INTERACT_RANGE);
      }
    }
  });

  it('parks a seated player rather than sliding them off the stool', () => {
    // Seats are solid now, and a seated player sits exactly on one. They must
    // not be pushed out of it by their own collision shape.
    const table = world.interactables.find((entry) => entry.kind === 'table')!;
    const seat = table.seats[0]!;
    let state = { ...createPlayerState(seat.x, 0, seat.z, seat.yaw), seatedAt: table.id };

    for (let tick = 0; tick < 60; tick += 1) {
      state = stepPlayer(state, input({ moveZ: 1, yaw: seat.yaw }), world, TICK_DT);
    }

    expect(state.x).toBeCloseTo(seat.x, 6);
    expect(state.z).toBeCloseTo(seat.z, 6);
  });
});
