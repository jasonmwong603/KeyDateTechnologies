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
  /**
   * Which way the table faces, as a unit vector pointing from its centre
   * toward the players.
   *
   * Tables are half-circles: the dealer stands at the flat side and the seats
   * ring the curve. Everything that has to know which side is which — where the
   * shoe sits, which way the dealer's cards lie, how the client rotates the
   * mesh — reads it from here rather than working it out again.
   */
  facing?: { x: number; z: number };
  /** Radius of the curved side, in metres. */
  radius?: number;
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

/**
 * Seats spread along the curved side of a half-circle table.
 *
 * They fan across an arc centred on `facing` rather than ringing the whole
 * table, because there is no whole table to ring: the flat side is where the
 * dealer stands. The arc stops short of the chord at either end so the outer
 * seats are still looking across the felt rather than along it.
 */
function arcSeats(
  centerX: number,
  centerZ: number,
  radius: number,
  count: number,
  facing: { x: number; z: number },
): Interactable['seats'] {
  const middle = Math.atan2(facing.z, facing.x);
  const seats: Interactable['seats'] = [];

  for (let i = 0; i < count; i += 1) {
    // Spread evenly across the arc, with a half-step inset at each end so no
    // seat sits exactly on the chord.
    const t = count === 1 ? 0.5 : i / (count - 1);
    const angle = middle + (t - 0.5) * SEAT_ARC;
    const x = centerX + Math.cos(angle) * radius;
    const z = centerZ + Math.sin(angle) * radius;
    seats.push({
      x,
      y: 0,
      z,
      // Face the middle of the table, which is also toward the dealer.
      yaw: Math.atan2(centerZ - z, centerX - x),
    });
  }
  return seats;
}

/**
 * A half-disc approximated by three nested slabs.
 *
 * Collision here is axis-aligned boxes, and one box around a half-circle would
 * put solid geometry in two empty corners — invisible walls a player walks into
 * beside a table that plainly is not there. Three slabs of decreasing width,
 * all starting at the flat side, follow the curve closely enough that the error
 * is a few centimetres at the shoulders.
 *
 * `facing` must be a cardinal direction. Every table on this floor faces along
 * one, which is what keeps the slabs axis-aligned and the approximation cheap.
 */
function halfDiscColliders(
  centerX: number,
  centerZ: number,
  radius: number,
  height: number,
  facing: { x: number; z: number },
): AABB[] {
  // Depth from the chord, and the half-width of the disc at that depth. The
  // widths are sqrt(1 - d²) at the far edge of each slab, so every slab is
  // fully inside the true half-disc.
  const slabs = [
    { depth: 0.45, halfWidth: 0.89 },
    { depth: 0.78, halfWidth: 0.62 },
    { depth: 0.97, halfWidth: 0.24 },
  ];

  return slabs.map(({ depth, halfWidth }) => {
    const along = radius * depth;
    const across = radius * halfWidth * 2;
    // Slabs run from the chord outward, so their centre is half their depth in.
    const cx = centerX + facing.x * (along / 2);
    const cz = centerZ + facing.z * (along / 2);
    // Facing is cardinal, so exactly one of these is the depth axis.
    const sizeX = facing.x !== 0 ? along : across;
    const sizeZ = facing.z !== 0 ? along : across;
    return { ...aabb(cx, 0, cz, sizeX, height, sizeZ), kind: 'table' as const };
  });
}

/** Radius of the curved side of a table. */
const TABLE_RADIUS = 1.9;

/** How far a table's seats sit from its centre — a stool pulled up to the felt. */
const SEAT_RADIUS = 2.5;

/** How wide an arc the seats fan across, in radians. */
const SEAT_ARC = (150 * Math.PI) / 180;

/**
 * How wide a stool is.
 *
 * Bounded from above by the gap between neighbours: six stools on the arc sit
 * about 1.29m apart, and a player is 0.7m across, so anything over ~0.59m walls
 * the curved side off entirely.
 */
const STOOL_SIZE = 0.52;

/**
 * The first playable space: a single casino floor with six wagering tables.
 *
 * Deliberately one room. Interest management and zone handoff are only worth
 * building once there is a second room to hand off to.
 */
export function buildCasinoFloor(): World {
  const halfWidth = 24;
  const halfDepth = 18;

  // The four corner positions are the room's prime real estate — visible from
  // the door, on the walk to the bar — so the three headline games take them,
  // with blackjack twice because it is the one that seats people longest. The
  // house oddities sit out on the east and west walls.
  //
  // Nothing is placed on the z = ±14 line: that is where players spawn, and a
  // spawn point inside a seat ring drops somebody onto the felt.
  // `facing` points from the table centre toward the players, and every table
  // turns its curved side toward the middle of the room. Walking in off the
  // floor therefore brings you out among the empty stools, with the dealer on
  // the far side of the felt — you sit down where you were already standing.
  //
  // Turning them the other way is what it looked like at first: the dealer
  // greets you as you arrive. But there are no seats on the dealer's side, so
  // pressing E teleported the player the whole way around the arc, and the room
  // swung through 180° under a first-person camera.
  //
  // Every facing is a cardinal direction. That is what lets the half-disc be
  // approximated by axis-aligned slabs; see `halfDiscColliders`.
  const WEST = { x: -1, z: 0 };
  const EAST = { x: 1, z: 0 };
  const tablePositions = [
    { x: -12, z: -8, label: 'Blackjack', gameId: 'blackjack', facing: EAST },
    { x: 12, z: -8, label: 'Roulette', gameId: 'roulette', facing: WEST },
    { x: -12, z: 8, label: 'Baccarat', gameId: 'baccarat', facing: EAST },
    { x: 12, z: 8, label: 'Blackjack', gameId: 'blackjack', facing: WEST },
    { x: -19, z: 0, label: 'Wheel of Fortune', gameId: 'wheel-of-fortune', facing: EAST },
    { x: 19, z: 0, label: 'High Card Duel', gameId: 'high-card-duel', facing: WEST },
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
    colliders.push(...halfDiscColliders(table.x, table.z, TABLE_RADIUS, 1.0, table.facing));

    const seats = arcSeats(table.x, table.z, SEAT_RADIUS, 6, table.facing);

    // A stool at every seat, solid like everything else you can see. Seats used
    // to be a translucent disc painted on the floor, which told you where to
    // stand but not that anyone was sitting there.
    //
    // They are deliberately narrow. Six of them span the arc about 1.29m apart,
    // and a stool any wider than this leaves a gap a player cannot fit through —
    // which would make the table reachable only from the dealer's side.
    for (const seat of seats) {
      colliders.push({ ...aabb(seat.x, 0, seat.z, STOOL_SIZE, 0.72, STOOL_SIZE), kind: 'seat' });
    }

    return {
      id: index + 1,
      kind: 'table' as const,
      gameId: table.gameId,
      label: table.label,
      x: table.x,
      y: 0,
      z: table.z,
      facing: table.facing,
      radius: TABLE_RADIUS,
      seats,
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
