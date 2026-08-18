import { aabb, type AABB } from './math.js';

/**
 * Static world description.
 *
 * The world is sent to each client once, at connect, and is never replicated
 * per tick — it does not change. Both sides collide against exactly this data.
 */

export type InteractableKind = 'table' | 'bar' | 'door' | 'vendor';

export interface Interactable {
  id: number;
  kind: InteractableKind;
  /** Rules module that governs this interactable, e.g. 'wheel-of-fortune'. */
  gameId?: string;
  label: string;
  x: number;
  y: number;
  z: number;
  /** Seat anchor positions around the table, in world space. */
  seats: { x: number; y: number; z: number; yaw: number }[];
}

export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface World {
  name: string;
  /** Playable bounds; players are clamped inside these. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  colliders: AABB[];
  interactables: Interactable[];
  spawns: SpawnPoint[];
}

/** Builds a rectangular wall ring around the floor plan. */
function buildWalls(
  halfWidth: number,
  halfDepth: number,
  height: number,
  thickness: number,
): AABB[] {
  const span = halfWidth * 2 + thickness * 2;
  const depth = halfDepth * 2 + thickness * 2;
  return [
    { ...aabb(0, 0, -halfDepth - thickness / 2, span, height, thickness), kind: 'wall' as const },
    { ...aabb(0, 0, halfDepth + thickness / 2, span, height, thickness), kind: 'wall' as const },
    { ...aabb(-halfWidth - thickness / 2, 0, 0, thickness, height, depth), kind: 'wall' as const },
    { ...aabb(halfWidth + thickness / 2, 0, 0, thickness, height, depth), kind: 'wall' as const },
  ];
}

/** Six seats evenly spaced around a round table, each facing inward. */
function ringSeats(
  centerX: number,
  centerZ: number,
  radius: number,
  count: number,
): Interactable['seats'] {
  const seats: Interactable['seats'] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    const x = centerX + Math.cos(angle) * radius;
    const z = centerZ + Math.sin(angle) * radius;
    seats.push({
      x,
      y: 0,
      z,
      // Face the middle of the table.
      yaw: Math.atan2(centerZ - z, centerX - x),
    });
  }
  return seats;
}

/**
 * The first playable space: a single casino floor with four wagering tables.
 *
 * Deliberately one room. Interest management and zone handoff are only worth
 * building once there is a second room to hand off to.
 */
export function buildCasinoFloor(): World {
  const halfWidth = 24;
  const halfDepth = 18;

  const tablePositions = [
    { x: -12, z: -8, label: 'Wheel of Fortune', gameId: 'wheel-of-fortune' },
    { x: 12, z: -8, label: 'High Card Duel', gameId: 'high-card-duel' },
    { x: -12, z: 8, label: 'Wheel of Fortune', gameId: 'wheel-of-fortune' },
    { x: 12, z: 8, label: 'High Card Duel', gameId: 'high-card-duel' },
  ];

  const colliders: AABB[] = [
    ...buildWalls(halfWidth, halfDepth, 4, 0.5),
    // Central bar, purely to break sightlines and give the space a middle.
    { ...aabb(0, 0, 0, 6, 1.1, 6), kind: 'prop' as const },
  ];

  // Engaged columns down every wall. They are part of the authoritative world
  // rather than client decoration: a column you can walk through is worse than
  // no column at all, and putting them here means the server and every client
  // agree on where they are.
  //
  // Each sits flush against its wall, so there is no unreachable pocket behind
  // it for a player to get wedged in.
  const COLUMN_HALF = 0.5;
  for (const z of [-13.5, -4.5, 4.5, 13.5]) {
    for (const x of [-(halfWidth - COLUMN_HALF), halfWidth - COLUMN_HALF]) {
      colliders.push({ ...aabb(x, 0, z, 1, 4, 1), kind: 'column' as const });
    }
  }
  for (const x of [-18, -9, 9, 18]) {
    for (const z of [-(halfDepth - COLUMN_HALF), halfDepth - COLUMN_HALF]) {
      colliders.push({ ...aabb(x, 0, z, 1, 4, 1), kind: 'column' as const });
    }
  }

  const interactables: Interactable[] = tablePositions.map((table, index) => {
    // The table body is solid; players walk up to it rather than through it.
    // Tagged so the client draws its own table mesh here instead of a grey box.
    colliders.push({ ...aabb(table.x, 0, table.z, 2.6, 1.0, 2.6), kind: 'table' as const });
    return {
      id: index + 1,
      kind: 'table' as const,
      gameId: table.gameId,
      label: table.label,
      x: table.x,
      y: 0,
      z: table.z,
      seats: ringSeats(table.x, table.z, 2.1, 6),
    };
  });

  // The bar, in the north-west corner. Everything you drink is bought here and
  // paid for out of the same chips you gamble with, which is the whole loop.
  const BAR_X = -20;
  const BAR_Z = -12;
  colliders.push({ ...aabb(BAR_X, 0, BAR_Z, 1.5, 1.15, 6), kind: 'bar' as const });
  // Back-bar shelving against the wall behind it.
  colliders.push({ ...aabb(-23, 0, BAR_Z, 1.4, 2.4, 6), kind: 'bar' as const });

  interactables.push({
    id: 100,
    kind: 'bar',
    label: 'The Tap Room',
    // Sits on the customer side of the counter, so range is measured from where
    // a player can actually stand rather than from inside the woodwork.
    x: BAR_X + 1.4,
    y: 0,
    z: BAR_Z,
    seats: [],
  });

  return {
    name: 'Beer Bets',
    bounds: {
      minX: -halfWidth,
      maxX: halfWidth,
      minZ: -halfDepth,
      maxZ: halfDepth,
    },
    colliders,
    interactables,
    spawns: [
      { x: 0, y: 0, z: 14, yaw: -Math.PI / 2 },
      { x: -4, y: 0, z: 14, yaw: -Math.PI / 2 },
      { x: 4, y: 0, z: 14, yaw: -Math.PI / 2 },
      { x: 0, y: 0, z: -14, yaw: Math.PI / 2 },
    ],
  };
}

export function findInteractable(world: World, id: number): Interactable | undefined {
  return world.interactables.find((entry) => entry.id === id);
}
