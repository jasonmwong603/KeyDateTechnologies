import * as THREE from 'three';
import { seatAnchor } from './cards3d.js';

/**
 * Chips on the felt.
 *
 * A number in a panel tells you what somebody bet; a stack of chips tells you
 * at a glance, from across the table, without reading anything. That is the
 * whole point of chip colours in a real room and it is the point here.
 *
 * Stacks sit inboard of the cards — between the player's hand and the middle of
 * the table — which on a round table with the dealer in the centre is exactly
 * where a bet is pushed to.
 */

/**
 * The chip ladder, largest first.
 *
 * The five colours are the standard ones. The white 1 is not: bets here are any
 * whole number, so without it a stake of 137 could not be built out of chips at
 * all, and a stack that does not add up to the bet beside it is worse than no
 * stack. It is the "and change" chip.
 */
export const DENOMINATIONS = [
  { value: 1000, color: 0xd4a017, rim: 0xfff0c0, name: 'gold' },
  { value: 500, color: 0x6b2fa0, rim: 0xd9c2f2, name: 'purple' },
  { value: 100, color: 0x16181d, rim: 0xb9bec9, name: 'black' },
  { value: 25, color: 0x1f7a3f, rim: 0xbfe8cd, name: 'green' },
  { value: 5, color: 0xa51c26, rim: 0xf3c3c6, name: 'red' },
  { value: 1, color: 0xe6e3da, rim: 0x8d8a80, name: 'white' },
];

const CHIP_RADIUS = 0.058;
const CHIP_HEIGHT = 0.014;
/** Height of the felt surface, matching the table mesh in `renderer.js`. */
const FELT_Y = 1.06;
/** How far from the table centre a bet is pushed. Inboard of the cards. */
const BET_INSET = 0.6;
/** Sideways gap between the boxes of a player holding more than one. */
const BOX_SPACING = 0.5;
/** Chips per column before a stack starts a new one beside it. */
const COLUMN_HEIGHT = 8;
/** Columns before the stack stops growing and the label carries the rest. */
const MAX_COLUMNS = 4;
const COLUMN_SPACING = 0.135;

/**
 * Breaks an amount into chips, largest first.
 *
 * Greedy, which is exact for this ladder — every denomination divides the ones
 * above it — so the stack always adds up to the bet rather than approximating
 * it.
 */
export function chipBreakdown(amount) {
  const chips = [];
  let left = Math.max(0, Math.floor(amount));
  for (const denomination of DENOMINATIONS) {
    const count = Math.floor(left / denomination.value);
    for (let i = 0; i < count; i += 1) chips.push(denomination);
    left -= count * denomination.value;
  }
  return chips;
}

export class ChipStacks {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.scene = scene;

    /** One entry per betting spot with chips on it, keyed by player and spot. */
    this._stacks = new Map();
    this._tableId = null;

    this._geometry = new THREE.CylinderGeometry(CHIP_RADIUS, CHIP_RADIUS, CHIP_HEIGHT, 18);
    /** One material per denomination, shared by every chip of that colour. */
    this._materials = new Map(
      DENOMINATIONS.map((denomination) => [
        denomination.value,
        new THREE.MeshStandardMaterial({
          color: denomination.color,
          roughness: 0.55,
          metalness: denomination.value === 1000 ? 0.55 : 0.05,
          // Chips sit under a lamp and are read at a glance from across the
          // table; a touch of self-lit colour keeps them telling each other
          // apart even in the shadow of a hand.
          emissive: denomination.color,
          emissiveIntensity: 0.16,
        }),
      ]),
    );

    this._root = new THREE.Group();
    this._root.visible = false;
    this.scene.add(this._root);
  }

  /**
   * Puts every wager on the table onto the felt.
   *
   * @param state the table's public state — wagers, seats, round
   * @param interactable the world table, for its position and seat anchors
   */
  sync(state, interactable) {
    if (state === null || state === undefined || interactable === undefined) {
      this.clear();
      return;
    }

    if (this._tableId !== state.tableId) {
      this.clear();
      this._tableId = state.tableId;
    }
    this._root.position.set(interactable.x, 0, interactable.z);
    this._root.visible = true;

    const seatFor = new Map();
    for (const seat of state.seats ?? []) {
      const anchor = interactable.seats[seat.seatIndex % interactable.seats.length];
      if (anchor === undefined) continue;
      seatFor.set(seat.playerId, { x: anchor.x - interactable.x, z: anchor.z - interactable.z });
    }

    // Each player's spots laid out left to right, so box 2's chips sit under
    // box 2's cards.
    const spotsFor = new Map();
    for (const wager of state.wagers ?? []) {
      const list = spotsFor.get(wager.playerId) ?? [];
      list.push(wager.spotId);
      spotsFor.set(wager.playerId, list);
    }
    for (const list of spotsFor.values()) list.sort();

    const live = new Set();
    for (const wager of state.wagers ?? []) {
      const seat = seatFor.get(wager.playerId);
      if (seat === undefined) continue;

      const key = `${wager.playerId}:${wager.spotId}`;
      live.add(key);
      const spots = spotsFor.get(wager.playerId) ?? [wager.spotId];
      this._syncStack(key, wager.amount, seat, spots.indexOf(wager.spotId), spots.length);
    }

    for (const [key, stack] of this._stacks) {
      if (live.has(key)) continue;
      this._root.remove(stack.group);
      this._stacks.delete(key);
    }
  }

  _syncStack(key, amount, seat, boxIndex, boxCount) {
    let stack = this._stacks.get(key);
    if (stack === undefined) {
      stack = { group: new THREE.Group(), amount: -1, label: null };
      this._root.add(stack.group);
      this._stacks.set(key, stack);
    }

    const anchor = seatAnchor(seat, BET_INSET);
    const offset = (boxIndex - (boxCount - 1) / 2) * BOX_SPACING;
    stack.group.position.set(
      anchor.x + anchor.tangentX * offset,
      0,
      anchor.z + anchor.tangentZ * offset,
    );
    stack.group.rotation.y = anchor.yaw;

    // Rebuilt only when the amount changes. Wagers are republished about five
    // times a second and rebuilding a stack of chips on every one of those
    // would be pure churn.
    if (stack.amount === amount) return;
    stack.amount = amount;
    stack.group.clear();

    const chips = chipBreakdown(amount);
    const columns = Math.min(MAX_COLUMNS, Math.max(1, Math.ceil(chips.length / COLUMN_HEIGHT)));

    chips.slice(0, columns * COLUMN_HEIGHT).forEach((denomination, index) => {
      const column = Math.floor(index / COLUMN_HEIGHT);
      const height = index % COLUMN_HEIGHT;
      const chip = new THREE.Mesh(this._geometry, this._materials.get(denomination.value));
      chip.position.set(
        (column - (columns - 1) / 2) * COLUMN_SPACING,
        FELT_Y + CHIP_HEIGHT / 2 + height * CHIP_HEIGHT,
        0,
      );
      // A hand-stacked column is never perfectly aligned, and a perfectly
      // aligned one reads as a single extruded cylinder rather than as chips.
      chip.rotation.y = ((index * 37) % 360) * (Math.PI / 180);
      chip.castShadow = true;
      stack.group.add(chip);
    });

    stack.group.add(this._amountLabel(amount, columns));
  }

  /**
   * The exact amount, floating over the stack.
   *
   * The chips carry the magnitude; this carries the number. Both are needed —
   * a very large bet is capped at four columns, so past that point the label is
   * the only thing still telling the truth.
   */
  _amountLabel(amount, columns) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 62px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(6, 9, 18, 0.85)';
    ctx.strokeText(amount.toLocaleString(), 128, 52);
    ctx.fillStyle = '#ffd166';
    ctx.fillText(amount.toLocaleString(), 128, 52);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
    );
    sprite.renderOrder = 9;
    sprite.position.set(0, FELT_Y + 0.22 + columns * 0.01, 0);
    sprite.scale.set(0.42, 0.16, 1);
    return sprite;
  }

  clear() {
    for (const stack of this._stacks.values()) this._root.remove(stack.group);
    this._stacks.clear();
    this._root.visible = false;
    this._tableId = null;
  }

  /** How many chip meshes are on the felt. Read by the client smoke test. */
  get chipCount() {
    let total = 0;
    for (const stack of this._stacks.values()) {
      total += stack.group.children.filter((child) => child.isMesh === true).length;
    }
    return total;
  }
}
