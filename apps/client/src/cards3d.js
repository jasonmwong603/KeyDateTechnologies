import * as THREE from 'three';

/**
 * Playing cards on the felt.
 *
 * The HUD panel tells you what you are holding; this is the part you watch.
 * Cards come off the shoe one at a time, arc across the table, turn face up as
 * they travel, and settle in front of whoever they were dealt to.
 *
 * It is driven entirely by the same table state the panel reads — there is no
 * separate "deal" message. A card animates because it is a mesh that did not
 * exist a moment ago, so the whole job here is diffing the hand against what is
 * already on the table and only creating what is genuinely new. Rebuilding the
 * lot on every table update (they arrive about five times a second) would leave
 * every card permanently mid-flight.
 */

/**
 * Metres. Deliberately about four times the real proportion against a 2.6m
 * table: a correctly-scaled playing card is a few pixels across from a seat,
 * and a card you cannot read is just a white speck on the felt.
 */
const CARD_W = 0.27;
const CARD_H = 0.37;
const CARD_THICKNESS = 0.006;

/** Height of the felt surface, from the table mesh in `renderer.js`. */
const FELT_Y = 1.06;

/**
 * The shoe, in table-local space — local +X points at the players, so this sits
 * just inside the flat side at the dealer's right hand.
 *
 * Exported because `renderer.js` builds the shoe prop from the same numbers.
 * Cards animate as coming out of it, so the two must not drift apart.
 */
export const SHOE_LOCAL = { x: 0.3, y: 1.26, z: 0.95 };

const FLIGHT_MS = 460;
const FLIP_MS = 340;
/** Gap between consecutive cards in one deal. */
const STAGGER_MS = 130;
/** How high a card arcs on its way across the table. */
const ARC_HEIGHT = 0.3;

/** How far in from the flat side the dealer's own hand is laid. */
const DEALER_INSET = 0.62;

/**
 * How far from the table centre a seat's cards land.
 *
 * The felt ends at 1.9m, so this is as close to the player as a card can sit
 * without hanging off the curved edge.
 */
export const SEAT_INSET = 1.5;

/** How far out a seat's chips sit — inboard of the cards, pushed at the dealer. */
export const BET_INSET = 1.02;

/** Sideways gap between the boxes of a player holding more than one. */
const BOX_SPACING = 0.44;
/** Sideways spacing between the cards of one hand. Wider than a card, so they
 *  sit side by side rather than stacked — a hole card half-buried under the
 *  upcard is the one card you most need to be able to point at. */
const FAN_SPACING = 0.3;

const RED_SUITS = new Set(['♥', '♦']);

function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

/** Rounded rectangle path, used for both faces of every card. */
function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

/**
 * Draws one card face.
 *
 * Corner indices plus a large centre pip. The centre pip is what actually does
 * the work: from a seat away, across a table, at a glancing angle, the corner
 * index is a smudge and the pip is the only thing still legible.
 */
function drawFace(rank, suit) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 356;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  roundedRect(ctx, 5, 5, canvas.width - 10, canvas.height - 10, 22);
  // Bone rather than paper white. This room is lit hard and tone mapped; a
  // true white card clips to a featureless slab and takes the ink with it.
  ctx.fillStyle = '#ddd7c7';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.lineWidth = 4;
  ctx.stroke();

  const ink = RED_SUITS.has(suit) ? '#98121f' : '#101216';
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // The centre pip carries the card. From a seat, at a glancing angle, across
  // a table, the corner index is a smudge and this is the only legible mark.
  ctx.font = 'bold 168px Georgia, "Times New Roman", serif';
  ctx.fillText(suit, canvas.width / 2, canvas.height / 2 + 18);

  ctx.font = 'bold 72px Georgia, "Times New Roman", serif';
  ctx.fillText(rank, 48, 54);

  // The bottom index, upside down, as on a real card.
  ctx.save();
  ctx.translate(canvas.width - 48, canvas.height - 54);
  ctx.rotate(Math.PI);
  ctx.font = 'bold 72px Georgia, "Times New Roman", serif';
  ctx.fillText(rank, 0, 0);
  ctx.restore();

  return canvas;
}

function drawBack() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 356;
  const ctx = canvas.getContext('2d');

  roundedRect(ctx, 5, 5, canvas.width - 10, canvas.height - 10, 22);
  ctx.fillStyle = '#7a1220';
  ctx.fill();
  ctx.strokeStyle = '#d8cfb4';
  ctx.lineWidth = 6;
  ctx.stroke();

  // Crimson with a gold lattice, so a face-down card is unmistakably a card
  // back and not a blank one — and reads against the green felt from any angle.
  ctx.save();
  roundedRect(ctx, 20, 20, canvas.width - 40, canvas.height - 40, 14);
  ctx.clip();
  ctx.strokeStyle = 'rgba(226, 195, 106, 0.65)';
  ctx.lineWidth = 4;
  for (let offset = -canvas.height; offset < canvas.width * 2; offset += 26) {
    ctx.beginPath();
    ctx.moveTo(offset, 0);
    ctx.lineTo(offset + canvas.height, canvas.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(offset + canvas.height, 0);
    ctx.lineTo(offset, canvas.height);
    ctx.stroke();
  }
  ctx.restore();

  return canvas;
}

/**
 * Where a seat's things sit on the felt, `inset` metres from the table centre.
 *
 * Shared with the chip stacks so cards and chips agree about which direction a
 * player is sitting in — they are laid out along the same radius, and the two
 * drifting apart would put somebody's bet in front of another seat's cards.
 */
export function seatAnchor(seat, inset) {
  const length = Math.hypot(seat.x, seat.z) || 1;
  const ux = seat.x / length;
  const uz = seat.z / length;
  return {
    x: ux * inset,
    z: uz * inset,
    // The tangent is the radial vector turned a quarter turn: the direction to
    // fan things out along without moving them nearer or further from the seat.
    tangentX: uz,
    tangentZ: -ux,
    // Long axis radial, so a card points at whoever it belongs to.
    yaw: Math.atan2(ux, uz),
  };
}

/** The key a card slot is tracked by, so a hand can be diffed between updates. */
function cardCode(card) {
  return card === null || card === undefined ? 'facedown' : `${card.rank}${card.suit}`;
}

export class CardTable {
  /** @param {THREE.Scene} scene */
  constructor(scene, anisotropy = 1) {
    this.scene = scene;
    this._anisotropy = anisotropy;

    /** Every card currently on the felt, keyed by slot. */
    this._cards = new Map();
    /** Face materials, cached by rank+suit — 52 at the very most. */
    this._faces = new Map();
    /** The table these cards belong to, and the round they were dealt in. */
    this._tableId = null;
    this._round = null;
    /** Which way the table faces — toward the players. Set when a table is adopted. */
    this._facing = { x: 1, z: 0 };
    /** Where cards fly from, in table-relative world coordinates. */
    this._shoe = new THREE.Vector3();
    /** Cards dealt in this batch, so one deal staggers across the whole table. */
    this._dealtThisBatch = 0;
    this._batchAt = 0;

    // Geometry is shared by every card; only the face material differs. The
    // card lies flat, so its face is the +Y side of the box.
    this._geometry = new THREE.BoxGeometry(CARD_W, CARD_THICKNESS, CARD_H);
    // Card stock is matte. Any specular at all and the faces blow out to blank
    // slabs under the lamp hanging directly over every table.
    this._edge = new THREE.MeshStandardMaterial({ color: '#cfc9ba', roughness: 1, metalness: 0 });
    this._back = new THREE.MeshStandardMaterial({
      map: this._texture(drawBack()),
      roughness: 1,
      metalness: 0,
    });

    /** Table-local origin of the felt, set when a table is adopted. */
    this._root = new THREE.Group();
    this._root.visible = false;
    this.scene.add(this._root);
  }

  _texture(canvas) {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // Cards are almost always seen at a shallow angle, which is exactly the
    // case where a texture without anisotropic filtering turns to mush.
    texture.anisotropy = this._anisotropy;
    return texture;
  }

  /** Face material for a card, created once per rank+suit and then reused. */
  _faceMaterial(card) {
    const code = cardCode(card);
    const cached = this._faces.get(code);
    if (cached !== undefined) return cached;

    const material = new THREE.MeshStandardMaterial({
      map: this._texture(drawFace(card.rank, card.suit)),
      roughness: 1,
      metalness: 0,
    });
    this._faces.set(code, material);
    return material;
  }

  /**
   * Where a card sits, in table-local space.
   *
   * Cards lie radially in front of their seat — long axis pointing at the
   * player, fanned sideways — because that is how they read from the one place
   * anybody is looking at them from.
   */
  _restingPlace(seat, indexInHand, handSize, box = { index: 0, count: 1 }) {
    if (seat === null) {
      // The dealer's hand, laid on the felt just inside the flat side in front
      // of where the dealer stands, fanned along the chord and pointing back at
      // them. Every seat is on the curve, so this never lands in front of one.
      const spread = (indexInHand - (handSize - 1) / 2) * FAN_SPACING;
      const f = this._facing;
      return {
        x: f.x * DEALER_INSET + f.z * spread,
        z: f.z * DEALER_INSET - f.x * spread,
        // Long axis along the facing, so the cards read to the dealer.
        yaw: Math.atan2(-f.x, -f.z),
      };
    }

    const anchor = seatAnchor(seat, SEAT_INSET);

    // A player holding three boxes gets three hands laid out side by side in
    // front of their seat, and the cards within each fan tighter so all three
    // fit inside one seat's share of the felt.
    const tight = box.count > 1;
    const boxOffset = (box.index - (box.count - 1) / 2) * BOX_SPACING;
    const spacing = tight ? FAN_SPACING * 0.55 : FAN_SPACING;
    const spread = boxOffset + (indexInHand - (handSize - 1) / 2) * spacing;

    return {
      x: anchor.x + anchor.tangentX * spread,
      z: anchor.z + anchor.tangentZ * spread,
      yaw: anchor.yaw,
    };
  }

  _createCard(card, place, faceDown, delayMs) {
    const pivot = new THREE.Group();
    pivot.position.copy(this._shoe);
    pivot.rotation.y = place.yaw;

    const mesh = new THREE.Mesh(this._geometry, [
      this._edge,
      this._edge,
      faceDown ? this._back : this._faceMaterial(card),
      this._back,
      this._edge,
      this._edge,
    ]);
    // Face down all the way out of the shoe. The turn happens in flight.
    mesh.rotation.x = Math.PI;
    mesh.castShadow = true;
    pivot.add(mesh);
    this._root.add(pivot);

    return {
      pivot,
      mesh,
      from: this._shoe.clone(),
      to: new THREE.Vector3(place.x, FELT_Y, place.z),
      startAt: performance.now() + delayMs,
      duration: FLIGHT_MS,
      motion: 'deal',
      faceDown,
    };
  }

  /**
   * Brings the felt in line with the hand being played.
   *
   * @param state the table's public state, for the table id, round and seats
   * @param hand `{ dealer: [card|null], seats: [{ playerId, cards }] }`, or null
   * @param interactable the world table, for its position and seat anchors
   */
  sync(state, hand, interactable) {
    if (state === null || interactable === undefined || interactable === null) {
      this.clear();
      return;
    }

    // A different table, or a fresh round, means the felt is cleared first.
    if (this._tableId !== state.tableId || this._round !== state.round) {
      this.clear();
      this._tableId = state.tableId;
      this._round = state.round;
      this._root.position.set(interactable.x, 0, interactable.z);
      this._root.visible = true;
    }

    // The root is never rotated — everything in it is placed from world-space
    // offsets — so the shoe's table-local position is rotated into place here
    // rather than by a parent transform.
    this._facing = interactable.facing ?? { x: 1, z: 0 };
    const f = this._facing;
    this._shoe.set(
      f.x * SHOE_LOCAL.x + f.z * SHOE_LOCAL.z,
      SHOE_LOCAL.y,
      f.z * SHOE_LOCAL.x - f.x * SHOE_LOCAL.z,
    );

    if (hand === null || hand === undefined) {
      this._removeAllBut(new Set());
      return;
    }

    // Seat anchors relative to the table centre, keyed by the player sitting in
    // them. `state.seats` is the mapping; `interactable.seats` is the geometry.
    const seatFor = new Map();
    for (const seat of state.seats ?? []) {
      const anchor = interactable.seats[seat.seatIndex % interactable.seats.length];
      if (anchor === undefined) continue;
      seatFor.set(seat.playerId, {
        x: anchor.x - interactable.x,
        z: anchor.z - interactable.z,
      });
    }

    // One stagger clock per batch of new cards, so a deal reads as a single
    // motion round the table rather than as everything landing at once.
    if (performance.now() - this._batchAt > STAGGER_MS * 3) this._dealtThisBatch = 0;

    // How many boxes each player is holding, so their hands can be laid out
    // side by side rather than on top of each other.
    const boxCount = new Map();
    for (const entry of hand.seats ?? []) {
      boxCount.set(entry.playerId, (boxCount.get(entry.playerId) ?? 0) + 1);
    }
    const boxSeen = new Map();

    const live = new Set();
    this._syncHand('dealer', hand.dealer ?? [], null, live);
    for (const entry of hand.seats ?? []) {
      const index = boxSeen.get(entry.playerId) ?? 0;
      boxSeen.set(entry.playerId, index + 1);
      this._syncHand(
        entry.key ?? entry.playerId,
        entry.cards ?? [],
        seatFor.get(entry.playerId) ?? null,
        live,
        { index, count: boxCount.get(entry.playerId) ?? 1 },
      );
    }
    this._removeAllBut(live);
  }

  _syncHand(ownerKey, cards, seat, live, box = { index: 0, count: 1 }) {
    cards.forEach((card, index) => {
      const key = `${ownerKey}:${index}`;
      live.add(key);

      const place = this._restingPlace(seat, index, cards.length, box);
      const code = cardCode(card);
      const existing = this._cards.get(key);

      if (existing === undefined) {
        const entry = this._createCard(
          card,
          place,
          card === null || card === undefined,
          this._dealtThisBatch * STAGGER_MS,
        );
        entry.code = code;
        this._dealtThisBatch += 1;
        this._batchAt = performance.now();
        this._cards.set(key, entry);
        return;
      }

      // A card already here whose identity changed is the hole card being
      // turned over. It does not move; it just stops being a secret.
      if (existing.code !== code && code !== 'facedown') {
        existing.code = code;
        existing.faceDown = false;
        existing.mesh.material = [
          this._edge,
          this._edge,
          this._faceMaterial(card),
          this._back,
          this._edge,
          this._edge,
        ];
        existing.motion = 'flip';
        existing.startAt = performance.now();
        existing.duration = FLIP_MS;
      }

      // Hands re-fan as they grow, so a settled card slides to its new place
      // rather than jumping. Only cards that have finished flying are moved.
      if (existing.motion === null) {
        existing.pivot.position.set(place.x, FELT_Y, place.z);
        existing.pivot.rotation.y = place.yaw;
      } else if (existing.motion === 'deal') {
        existing.to.set(place.x, FELT_Y, place.z);
        existing.pivot.rotation.y = place.yaw;
      }
    });
  }

  _removeAllBut(live) {
    for (const [key, entry] of this._cards) {
      if (live.has(key)) continue;
      this._root.remove(entry.pivot);
      this._cards.delete(key);
    }
  }

  /** Takes every card off the felt. Textures and geometry are kept for reuse. */
  clear() {
    for (const entry of this._cards.values()) this._root.remove(entry.pivot);
    this._cards.clear();
    this._dealtThisBatch = 0;
    this._root.visible = false;
    this._tableId = null;
    this._round = null;
  }

  /** How many cards are on the felt. Read by the client smoke test. */
  get cardCount() {
    return this._cards.size;
  }

  /** True while any card is still moving. */
  get dealing() {
    for (const entry of this._cards.values()) {
      if (entry.motion !== null) return true;
    }
    return false;
  }

  /** Advances every in-flight card. Called once per rendered frame. */
  update(now = performance.now()) {
    for (const entry of this._cards.values()) {
      if (entry.motion === null) continue;

      const elapsed = now - entry.startAt;
      // A staggered card has not left the shoe yet. Keep it hidden rather than
      // parked visibly on top of the shoe waiting its turn.
      if (elapsed < 0) {
        entry.pivot.visible = false;
        continue;
      }
      entry.pivot.visible = true;

      const t = Math.min(1, elapsed / entry.duration);
      const eased = easeOutCubic(t);

      if (entry.motion === 'deal') {
        entry.pivot.position.lerpVectors(entry.from, entry.to, eased);
        // A flat slide across the felt looks like a bug. The hop is what makes
        // it read as a card being thrown rather than dragged.
        entry.pivot.position.y += Math.sin(Math.PI * eased) * ARC_HEIGHT;
        // Face down out of the shoe, turning over as it travels. A card that
        // stays hidden — the hole card — simply never completes the turn.
        entry.mesh.rotation.x = entry.faceDown ? Math.PI : Math.PI * (1 - eased);
      } else {
        entry.mesh.rotation.x = Math.PI * (1 - eased);
      }

      if (t >= 1) {
        entry.motion = null;
        entry.mesh.rotation.x = entry.faceDown ? Math.PI : 0;
        entry.pivot.position.copy(entry.to);
      }
    }
  }
}
