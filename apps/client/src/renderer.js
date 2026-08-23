import * as THREE from 'three';
import { BET_INSET, CardTable, SHOE_LOCAL } from './cards3d.js';
import { ChipStacks } from './chips3d.js';
import { PLAYER_EYE_HEIGHT, PLAYER_HEIGHT, PLAYER_RADIUS } from '@keydate/sim';
import { createCarpet, createCofferedStone, createSculptedStone, tiledFor } from './textures.js';

/**
 * Renders the world and both camera modes.
 *
 * The renderer is a pure consumer of simulation state: it is handed positions
 * every frame and draws them. It never decides where anything is, which is what
 * keeps "what the server thinks" and "what you see" from drifting apart.
 */

const THIRD_PERSON_DISTANCE = 4.5;
const THIRD_PERSON_HEIGHT = 1.9;

/**
 * Converts a simulation yaw into a Three.js camera Y rotation.
 *
 * The two use different conventions and the mismatch is easy to get subtly
 * wrong. The simulation's forward vector is `(cos yaw, 0, sin yaw)`. A Three.js
 * camera with YXZ order and `rotation.y = t` looks along `(-sin t, 0, -cos t)`.
 * Equating the two gives `t = -yaw - PI/2`.
 *
 * The near-miss here is `yaw - PI/2`, which happens to be correct at yaw 0 and
 * mirrors the camera everywhere else — turning right swings the view left.
 */
function cameraYaw(yaw) {
  return -yaw - Math.PI / 2;
}

export class WorldRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Without tone mapping the emissive ceiling clips to flat white and drags
    // the whole frame with it. ACES rolls the highlights off instead.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    // Warm, low interior haze. A blue fog fights every warm surface in here
    // and makes travertine read as grey concrete at distance.
    this.scene.background = new THREE.Color(0x140b0c);
    this.scene.fog = new THREE.Fog(0x1d1210, 30, 85);

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 200);
    this.viewMode = 'first-person';

    /** @type {Map<number, THREE.Group>} */
    this.avatars = new Map();
    /** @type {THREE.Group | null} */
    this.localAvatar = null;

    this._raycaster = new THREE.Raycaster();
    this._tableMeshes = [];
    /**
     * Solid geometry only — walls and table bodies.
     *
     * The third-person camera raycasts against this rather than the whole
     * scene. Raycasting `scene.children` also hits Sprites (nameplates, table
     * signs), which three.js cannot test without `Raycaster.camera` and which
     * made it throw on every single frame, silently killing the render loop.
     */
    this._occluders = [];
    /** What the world build actually produced. Asserted by the client smoke test. */
    this.stats = { walls: 0, columns: 0, tables: 0, bar: 0, seats: 0 };
    /** Cards on the felt of whichever table the player is sitting at. */
    this.cardTable = new CardTable(this.scene, this.renderer.capabilities.getMaxAnisotropy());
    /** Chip stacks for every bet on that table. */
    this.chipStacks = new ChipStacks(this.scene);
    /** Table interactables by id, so a table state can be placed in the world. */
    this._interactables = new Map();
    /** 0..1, set from replicated state. Drives the camera sway only. */
    this.drunkenness = 0;

    this._buildLighting();
    this._handleResize();
    window.addEventListener('resize', () => this._handleResize());
  }

  _buildLighting() {
    // Everything in this room is warm — crimson carpet, cream stone, gilt. The
    // rig is lit to match; the previous cool-blue setup turned the travertine
    // grey and the carpet brown.
    this.scene.add(new THREE.AmbientLight(0xffe3bd, 1.15));
    this.scene.add(new THREE.HemisphereLight(0xffeccd, 0x3a0d13, 0.85));

    const key = new THREE.DirectionalLight(0xfff0d8, 1.0);
    key.position.set(12, 22, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    // The shadow frustum has to cover the whole floor or shadows pop in and out
    // as players walk toward the edges.
    key.shadow.camera.left = -30;
    key.shadow.camera.right = 30;
    key.shadow.camera.top = 24;
    key.shadow.camera.bottom = -24;
    key.shadow.camera.far = 60;
    this.scene.add(key);

    // Warm pools over each table, plus one over the centre bar.
    //
    // Point light count is deliberately small. This is a forward renderer:
    // every material compiles a shader sized to the whole light list, and every
    // fragment evaluates all of them. An earlier version had nine point lights
    // for the sake of coloured fill and the shader compile alone stalled load
    // for seconds on weak hardware — which is most phones. Five reads
    // essentially the same and costs a fraction.
    const lamps = [
      [-12, -8, 0xffd9a0, 95, 19],
      [12, -8, 0xffd9a0, 95, 19],
      [-12, 8, 0xffd9a0, 95, 19],
      [12, 8, 0xffd9a0, 95, 19],
      [0, 0, 0xffc98a, 70, 22],
    ];
    for (const [px, pz, color, intensity, distance] of lamps) {
      const lamp = new THREE.PointLight(color, intensity, distance);
      lamp.position.set(px, 3.5, pz);
      this.scene.add(lamp);
    }
  }

  /** Builds the static scene from the world description the server sent. */
  buildWorld(world) {
    const { bounds } = world;
    const width = bounds.maxX - bounds.minX;
    const depth = bounds.maxZ - bounds.minZ;
    const midX = (bounds.minX + bounds.maxX) / 2;
    const midZ = (bounds.minZ + bounds.maxZ) / 2;
    const anisotropy = this.renderer.capabilities.getMaxAnisotropy();

    // --- Floor: red and black casino carpet --------------------------------
    const carpet = createCarpet(Math.round(width / 3.2), Math.round(depth / 3.2));
    carpet.map.anisotropy = anisotropy;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      // Carpet is pile: fully rough, zero metalness. Any specular at all and it
      // reads as printed lino.
      new THREE.MeshStandardMaterial({ map: carpet.map, roughness: 1, metalness: 0 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(midX, 0, midZ);
    floor.receiveShadow = true;
    this.scene.add(floor);

    // --- Ceiling: coffered golden stone -------------------------------------
    const coffers = createCofferedStone(Math.round(width / 9), Math.round(depth / 9));
    coffers.map.anisotropy = anisotropy;
    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshStandardMaterial({
        map: coffers.map,
        // Real relief, so the coffers catch the lamps below them instead of
        // being a picture of a coffered ceiling.
        bumpMap: coffers.bumpMap,
        bumpScale: 1.4,
        roughness: 0.82,
        metalness: 0.04,
      }),
    );
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(midX, 4, midZ);
    this.scene.add(ceiling);

    // --- Walls, columns and props: Roman travertine -------------------------
    const stone = createSculptedStone();
    stone.map.anisotropy = anisotropy;
    this._stone = stone;
    /**
     * Stone materials, keyed by the surface size they are tiled for.
     *
     * `tiledFor` clones a texture, and every clone is a separate GPU upload of
     * the same bitmap. Cloning per mesh meant ~100 uploads of four identical
     * 512px images at load, which is seconds of stalled main thread before the
     * join screen can even be dismissed. Walls come in a handful of sizes and
     * every column is identical, so caching collapses that to a handful.
     */
    this._stoneMaterials = new Map();

    for (const box of world.colliders) {
      // Table bodies get their own mesh in _buildTable. Drawing the collider
      // too leaves a grey slab poking out from under the felt.
      if (box.kind === 'table') continue;
      if (box.kind === 'column') {
        this._buildColumn(box);
        this.stats.columns += 1;
        continue;
      }
      if (box.kind === 'seat') {
        this._buildStool(box);
        this.stats.seats += 1;
        continue;
      }
      if (box.kind === 'bar') {
        this._buildBarFitting(box);
        continue;
      }

      const w = box.maxX - box.minX;
      const h = box.maxY - box.minY;
      const d = box.maxZ - box.minZ;

      // Each surface gets its own tiling so the stone keeps a constant scale
      // whatever the wall's proportions. One shared texture stretches the long
      // walls into smears.
      const material = this._stoneMaterialFor(Math.max(w, d), h);

      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
      mesh.position.set(
        (box.minX + box.maxX) / 2,
        (box.minY + box.maxY) / 2,
        (box.minZ + box.maxZ) / 2,
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this._occluders.push(mesh);
      this.stats.walls += 1;

      // The central bar gets a dark marble counter so it does not read as one
      // more block of the same stone.
      if (box.kind === 'prop') {
        const top = new THREE.Mesh(
          new THREE.BoxGeometry(w + 0.25, 0.12, d + 0.25),
          new THREE.MeshStandardMaterial({ color: 0x1d1418, roughness: 0.25, metalness: 0.35 }),
        );
        top.position.set(mesh.position.x, box.maxY + 0.06, mesh.position.z);
        top.castShadow = true;
        this.scene.add(top);
      }
    }

    this._buildCornice(bounds);

    for (const interactable of world.interactables) {
      if (interactable.kind === 'bar') this._buildBarSign(interactable);
      else this._buildTable(interactable);
    }
  }

  /** A stone material tiled for a surface of this size, created once and shared. */
  _stoneMaterialFor(width, height, metresPerTile = 4, extra = {}) {
    const key = `${Math.round(width)}x${Math.round(height)}x${metresPerTile}x${extra.flatShading ? 1 : 0}`;
    const cached = this._stoneMaterials.get(key);
    if (cached !== undefined) return cached;

    const material = new THREE.MeshStandardMaterial({
      map: tiledFor(this._stone.map, width, height, metresPerTile),
      bumpMap: tiledFor(this._stone.bumpMap, width, height, metresPerTile),
      bumpScale: 1.1,
      roughnessMap: tiledFor(this._stone.roughnessMap, width, height, metresPerTile),
      roughness: 0.8,
      metalness: 0.03,
      ...extra,
    });
    this._stoneMaterials.set(key, material);
    return material;
  }

  /** The hanging sign that tells you where the bar is from across the room. */
  _buildBarSign(interactable) {
    const group = new THREE.Group();
    group.position.set(interactable.x, 0, interactable.z);

    const sign = this._makeLabelSprite(interactable.label, '#ffd166');
    sign.position.y = 3.1;
    sign.scale.set(3.4, 0.85, 1);
    group.add(sign);

    group.userData.interactableId = interactable.id;
    group.userData.label = interactable.label;
    group.userData.prompt = `Order at ${interactable.label}`;
    this._tableMeshes.push(group);
    this.scene.add(group);
  }

  /**
   * Counter and back-bar joinery.
   *
   * Timber rather than the room's stone: the bar should read as furniture
   * somebody installed, not as more architecture.
   */
  _buildBarFitting(box) {
    const w = box.maxX - box.minX;
    const h = box.maxY - box.minY;
    const d = box.maxZ - box.minZ;

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color: 0x3a2118, roughness: 0.65, metalness: 0.05 }),
    );
    body.position.set(
      (box.minX + box.maxX) / 2,
      (box.minY + box.maxY) / 2,
      (box.minZ + box.maxZ) / 2,
    );
    body.castShadow = true;
    body.receiveShadow = true;
    this.scene.add(body);
    this._occluders.push(body);
    this.stats.bar += 1;

    // A polished counter lip, overhanging slightly so it catches the light.
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.28, 0.1, d + 0.28),
      new THREE.MeshStandardMaterial({ color: 0x14100e, roughness: 0.2, metalness: 0.45 }),
    );
    top.position.set(body.position.x, box.maxY + 0.05, body.position.z);
    top.castShadow = true;
    this.scene.add(top);

    // Bottles along anything tall enough to be back-bar shelving.
    if (h < 1.6) return;
    const bottleColours = [0x6b8f3a, 0x8a3a2a, 0xc8a14a, 0x2f5d7c, 0x7a3f6d];
    for (let i = 0; i < 14; i += 1) {
      const bottle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.06, 0.3, 8),
        new THREE.MeshStandardMaterial({
          color: bottleColours[i % bottleColours.length],
          roughness: 0.25,
          metalness: 0.1,
        }),
      );
      bottle.position.set(
        body.position.x + (i % 2 === 0 ? 0.16 : -0.1),
        box.maxY - 0.55,
        box.minZ + 0.4 + (i / 14) * (d - 0.8),
      );
      this.scene.add(bottle);
    }
  }

  /**
   * A Tuscan column standing in the footprint of its collider.
   *
   * The shaft is drawn flat-shaded on purpose: at twenty radial segments the
   * facets catch the light as fluting for a fraction of the cost of a real
   * normal map, which this client has no pipeline to author.
   */
  /**
   * A stool at a table seat.
   *
   * Solid, and part of the authoritative world rather than decoration — the
   * seats used to be a translucent disc painted on the floor, which told you
   * where to stand but not that a chair was there. Backless and low, so six of
   * them ringing a table never hide the felt from anybody sitting at it.
   */
  _buildStool(box) {
    const cx = (box.minX + box.maxX) / 2;
    const cz = (box.minZ + box.maxZ) / 2;
    const top = box.maxY;
    const radius = Math.min(box.maxX - box.minX, box.maxZ - box.minZ) / 2;

    const group = new THREE.Group();
    group.position.set(cx, 0, cz);

    // Padded leather seat, in the same crimson as the carpet so the furniture
    // reads as belonging to the room.
    const cushion = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius * 0.94, 0.13, 20),
      new THREE.MeshStandardMaterial({ color: 0x6d1420, roughness: 0.75 }),
    );
    cushion.position.y = top - 0.065;
    cushion.castShadow = true;
    cushion.receiveShadow = true;
    group.add(cushion);

    const trim = new THREE.Mesh(
      new THREE.TorusGeometry(radius * 0.99, 0.022, 6, 20),
      new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.35, metalness: 0.8 }),
    );
    trim.rotation.x = Math.PI / 2;
    trim.position.y = top - 0.13;
    group.add(trim);

    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, top - 0.16, 10),
      new THREE.MeshStandardMaterial({ color: 0x2b1c14, roughness: 0.5, metalness: 0.25 }),
    );
    post.position.y = (top - 0.16) / 2;
    post.castShadow = true;
    group.add(post);

    const foot = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.8, radius * 0.86, 0.05, 16),
      new THREE.MeshStandardMaterial({ color: 0x2b1c14, roughness: 0.45, metalness: 0.35 }),
    );
    foot.position.y = 0.025;
    foot.receiveShadow = true;
    group.add(foot);

    this.scene.add(group);
    this._occluders.push(cushion);
  }

  _buildColumn(box) {
    const cx = (box.minX + box.maxX) / 2;
    const cz = (box.minZ + box.maxZ) / 2;
    const height = box.maxY - box.minY;
    const radius = Math.min(box.maxX - box.minX, box.maxZ - box.minZ) / 2;

    const group = new THREE.Group();
    group.position.set(cx, 0, cz);

    const shaftMaterial = this._stoneMaterialFor(radius * 4, height, 2.5, {
      bumpScale: 0.7,
      flatShading: true,
    });
    const trimMaterial = this._stoneMaterialFor(radius * 4, 1, 2);

    const plinth = new THREE.Mesh(
      new THREE.BoxGeometry(radius * 2.1, 0.18, radius * 2.1),
      trimMaterial,
    );
    plinth.position.y = 0.09;
    group.add(plinth);

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.92, radius * 1.05, 0.2, 20),
      trimMaterial,
    );
    base.position.y = 0.28;
    group.add(base);

    const shaftHeight = height - 0.95;
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.78, radius * 0.9, shaftHeight, 20),
      shaftMaterial,
    );
    shaft.position.y = 0.38 + shaftHeight / 2;
    shaft.castShadow = true;
    group.add(shaft);

    const capital = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 1.05, radius * 0.8, 0.24, 20),
      trimMaterial,
    );
    capital.position.y = height - 0.33;
    group.add(capital);

    const abacus = new THREE.Mesh(
      new THREE.BoxGeometry(radius * 2.3, 0.16, radius * 2.3),
      trimMaterial,
    );
    abacus.position.y = height - 0.13;
    group.add(abacus);

    this.scene.add(group);
    // Only the shaft occludes: the camera should tuck past a plinth, not shove
    // itself away from one.
    this._occluders.push(shaft);
  }

  /**
   * The entablature running the length of every wall.
   *
   * Roman interiors are horizontally banded, and a wall that meets the ceiling
   * in a bare seam reads as a video-game box however good the stone is.
   */
  _buildCornice(bounds) {
    const material = this._stoneMaterialFor(48, 1, 2);
    const width = bounds.maxX - bounds.minX;
    const depth = bounds.maxZ - bounds.minZ;
    const midX = (bounds.minX + bounds.maxX) / 2;
    const midZ = (bounds.minZ + bounds.maxZ) / 2;

    const bands = [
      // [w, d, x, z]
      [width, 0.6, midX, bounds.minZ + 0.3],
      [width, 0.6, midX, bounds.maxZ - 0.3],
      [0.6, depth, bounds.minX + 0.3, midZ],
      [0.6, depth, bounds.maxX - 0.3, midZ],
    ];

    for (const [w, d, x, z] of bands) {
      const cornice = new THREE.Mesh(new THREE.BoxGeometry(w, 0.42, d), material);
      cornice.position.set(x, 3.72, z);
      cornice.castShadow = true;
      this.scene.add(cornice);

      // A second, thinner course below it — the architrave. Two bands read as
      // architecture; one reads as a mistake.
      const architrave = new THREE.Mesh(
        new THREE.BoxGeometry(w * 0.995, 0.14, d * 0.995),
        material,
      );
      architrave.position.set(x, 3.44, z);
      this.scene.add(architrave);
    }
  }

  /**
   * What each game's table looks like from across the room.
   *
   * With five games on one floor, identical green discs mean walking up to
   * every table to read its sign. The felt colour is the cheap half of the fix
   * and the centrepiece is the other: a wheel is a wheel at any distance.
   */
  _tableStyle(gameId) {
    const styles = {
      blackjack: { felt: 0x1c5c3a, centre: 'shoe' },
      roulette: { felt: 0x14304f, centre: 'wheel' },
      baccarat: { felt: 0x5a1830, centre: 'shoe' },
      'wheel-of-fortune': { felt: 0x1a7a4a, centre: 'wheel' },
      'high-card-duel': { felt: 0x2c2350, centre: 'none' },
    };
    return styles[gameId] ?? { felt: 0x1a7a4a, centre: 'none' };
  }

  _buildTable(interactable) {
    this._interactables.set(interactable.id, interactable);

    const radius = interactable.radius ?? 1.9;
    const facing = interactable.facing ?? { x: 1, z: 0 };
    const style = this._tableStyle(interactable.gameId);

    const group = new THREE.Group();
    group.position.set(interactable.x, 0, interactable.z);
    // Local +X points at the players. A rotation about Y by φ sends (1,0,0) to
    // (cos φ, 0, -sin φ), so this is the φ that lines the two up.
    group.rotation.y = Math.atan2(-facing.z, facing.x);

    // The felt: a half-cylinder covering local +X. Three.js sweeps theta from
    // +Z toward +X, so [0, π] is exactly the half the players sit around.
    const felt = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, 0.1, 40, 1, false, 0, Math.PI),
      new THREE.MeshStandardMaterial({ color: style.felt, roughness: 0.9 }),
    );
    felt.position.y = 1.0;
    felt.castShadow = true;
    felt.receiveShadow = true;
    group.add(felt);
    this._occluders.push(felt);

    // A padded rail round the curve, and a straight one along the chord where
    // the dealer stands — the two edges a player actually leans on.
    const railMaterial = new THREE.MeshStandardMaterial({ color: 0x2b1c14, roughness: 0.55 });
    const curvedRail = new THREE.Mesh(
      new THREE.TorusGeometry(radius, 0.075, 8, 40, Math.PI),
      railMaterial,
    );
    // The torus is built in the XY plane sweeping from +X; laying it flat and
    // turning it a quarter turn puts its opening along the chord.
    curvedRail.rotation.x = Math.PI / 2;
    curvedRail.rotation.z = -Math.PI / 2;
    curvedRail.position.y = 1.05;
    group.add(curvedRail);

    const chordRail = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.15, radius * 2), railMaterial);
    chordRail.position.set(-0.02, 1.02, 0);
    chordRail.castShadow = true;
    group.add(chordRail);

    // The pedestal, under the middle of the curve rather than the chord, so the
    // table does not look like it is about to tip toward the dealer.
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.66, 1.0, 16),
      new THREE.MeshStandardMaterial({ color: 0x3d2b1f, roughness: 0.8 }),
    );
    base.position.set(radius * 0.4, 0.5, 0);
    base.castShadow = true;
    group.add(base);

    this._buildTableCentre(group, style.centre, radius);

    // A sign above the table, always readable because it faces the camera.
    const sign = this._makeLabelSprite(interactable.label);
    sign.position.set(radius * 0.35, 2.7, 0);
    sign.scale.set(3, 0.75, 1);
    group.add(sign);

    // Decoration positioned from world-space seat offsets goes in here, which
    // undoes the table's own rotation so the offsets can be used directly.
    const flat = new THREE.Group();
    flat.rotation.y = -group.rotation.y;
    group.add(flat);

    // The seats themselves are stools, built from their own colliders in
    // `_buildStool`. What is left here is a betting circle painted on the felt
    // in front of each one, so it is obvious where a bet goes before you place
    // one — and where it went afterwards.
    for (const seat of interactable.seats) {
      const length = Math.hypot(seat.x - interactable.x, seat.z - interactable.z) || 1;
      const ux = (seat.x - interactable.x) / length;
      const uz = (seat.z - interactable.z) / length;

      const circle = new THREE.Mesh(
        new THREE.RingGeometry(0.2, 0.225, 24),
        new THREE.MeshBasicMaterial({
          color: 0xe2c36a,
          transparent: true,
          opacity: 0.4,
          side: THREE.DoubleSide,
        }),
      );
      circle.rotation.x = -Math.PI / 2;
      circle.position.set(ux * BET_INSET, 1.055, uz * BET_INSET);
      flat.add(circle);
    }

    group.userData.interactableId = interactable.id;
    group.userData.label = interactable.label;
    group.userData.prompt = `Sit at ${interactable.label}`;
    this._tableMeshes.push(group);
    this.stats.tables += 1;
    this.scene.add(group);
  }

  /**
   * The prop in the middle of the felt.
   *
   * Deliberately a handful of primitives sharing no textures: this runs once
   * per table on a phone GPU that already has a room to compile, and a detailed
   * roulette wheel would buy nothing at the distance you actually see it from.
   */
  _buildTableCentre(group, kind, radius = 1.9) {
    if (kind === 'wheel') {
      // Out on the felt where everyone can see it, not tucked under the
      // dealer's hands.
      const at = radius * 0.55;
      const wheel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.62, 0.62, 0.1, 24),
        new THREE.MeshStandardMaterial({ color: 0x14100e, roughness: 0.35, metalness: 0.5 }),
      );
      wheel.position.set(at, 1.1, 0);
      wheel.castShadow = true;
      group.add(wheel);

      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(0.62, 0.055, 8, 28),
        new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.3, metalness: 0.85 }),
      );
      rim.rotation.x = Math.PI / 2;
      rim.position.set(at, 1.15, 0);
      group.add(rim);

      // A single spoke, so the wheel reads as a wheel rather than as a coaster.
      const spoke = new THREE.Mesh(
        new THREE.BoxGeometry(1.16, 0.03, 0.06),
        new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.3, metalness: 0.85 }),
      );
      spoke.position.set(at, 1.17, 0);
      group.add(spoke);
      return;
    }

    if (kind === 'shoe') {
      // A dealing shoe: a wedge of dark timber with a brass lip, sitting at the
      // dealer's right hand on the flat side. Cards are animated as coming out
      // of here, so it has to be where they come from — `cards3d.js` derives
      // the same spot from the table's facing.
      const timber = new THREE.MeshStandardMaterial({ color: 0x2a1b12, roughness: 0.5 });
      const at = { x: SHOE_LOCAL.x, z: SHOE_LOCAL.z };

      const body = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.2, 0.34), timber);
      body.position.set(at.x - 0.1, 1.15, at.z);
      body.castShadow = true;
      group.add(body);

      const ramp = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.16, 0.34), timber);
      ramp.position.set(at.x + 0.16, 1.11, at.z);
      ramp.rotation.z = 0.32;
      ramp.castShadow = true;
      group.add(ramp);

      const lip = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.02, 0.36),
        new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.35, metalness: 0.8 }),
      );
      lip.position.set(at.x + 0.27, 1.08, at.z);
      group.add(lip);

      // No stack of spare cards beside it: real cards land on this felt now,
      // and a white block next to them just reads as a card that failed to draw.
    }
  }

  /** Renders text to a canvas and returns it as a camera-facing sprite. */
  _makeLabelSprite(text, color = '#ffd166') {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(11, 16, 32, 0.75)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Shrink until the text fits. A fixed size clipped longer labels — 'Wheel
    // of Fortune' rendered as 'heel of Fortun'.
    const padding = 24;
    let fontSize = 64;
    do {
      ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
      if (ctx.measureText(text).width <= canvas.width - padding * 2) break;
      fontSize -= 2;
    } while (fontSize > 16);

    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
    );
    sprite.renderOrder = 10;
    return sprite;
  }

  /**
   * Creates the avatar for a player entity.
   *
   * A black pill with limbs, deliberately: a capsule alone reads as a bollard,
   * and until there are real rigged models the cheapest thing that reads as a
   * *person* is a silhouette with a head and four limbs on it. The head is a
   * sphere sunk into the top of the capsule rather than a ball sitting above
   * it, so the two share a profile instead of looking like a snowman.
   *
   * Limbs hug the body — arms flush against the torso, legs together — so the
   * whole thing keeps the capsule's outline from a distance and only resolves
   * into a figure close up. That also keeps it inside `PLAYER_RADIUS`, which
   * matters: the collision shape is the capsule, and a limb poking outside it
   * would visibly pass through walls.
   */
  addAvatar(entityId, name, isLocal) {
    const group = new THREE.Group();

    // Near-black, with a hint of colour so the local player can still be told
    // from everyone else without breaking the silhouette.
    const skin = new THREE.MeshStandardMaterial({
      color: isLocal ? 0x24201a : 0x14161d,
      roughness: 0.72,
      metalness: 0.06,
    });
    // Limbs a shade lighter than the body. Cut from the same black they would
    // vanish into it under this lighting, and a figure whose arms and legs
    // cannot be made out is just a pill again.
    const limbSkin = new THREE.MeshStandardMaterial({
      color: isLocal ? 0x3a342a : 0x262b36,
      roughness: 0.66,
      metalness: 0.08,
    });

    const torsoHeight = PLAYER_HEIGHT - PLAYER_RADIUS * 2;
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(PLAYER_RADIUS * 0.92, torsoHeight * 0.62, 6, 14),
      skin,
    );
    body.position.y = PLAYER_HEIGHT * 0.58;
    body.castShadow = true;
    group.add(body);

    // The head, carved out of the top of the pill: a sphere set low enough that
    // it merges into the shoulders rather than perching on them.
    const head = new THREE.Mesh(new THREE.SphereGeometry(PLAYER_RADIUS * 0.62, 14, 12), skin);
    head.position.y = PLAYER_HEIGHT - PLAYER_RADIUS * 0.55;
    head.castShadow = true;
    group.add(head);

    // A short neck, so the join reads as one body rather than two shapes.
    const neck = new THREE.Mesh(
      new THREE.CylinderGeometry(PLAYER_RADIUS * 0.3, PLAYER_RADIUS * 0.44, 0.16, 10),
      skin,
    );
    neck.position.y = PLAYER_HEIGHT - PLAYER_RADIUS * 1.05;
    group.add(neck);

    const limbs = [];
    const armGeometry = new THREE.CapsuleGeometry(PLAYER_RADIUS * 0.2, torsoHeight * 0.5, 4, 8);
    const legGeometry = new THREE.CapsuleGeometry(PLAYER_RADIUS * 0.24, torsoHeight * 0.62, 4, 8);

    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(armGeometry, limbSkin);
      // Flush against the torso: far enough out to catch a highlight and read
      // as a separate limb, near enough to stay inside the collision capsule.
      // An arm poking past PLAYER_RADIUS would visibly pass through walls.
      arm.position.set(0, PLAYER_HEIGHT * 0.6, side * PLAYER_RADIUS * 0.79);
      arm.rotation.x = side * 0.05;
      arm.castShadow = true;
      group.add(arm);
      limbs.push(arm);

      // Set so the feet land on the floor rather than sinking through it, and
      // high enough to overlap the torso — legs hanging below a gap read as a
      // body floating over two sticks.
      const leg = new THREE.Mesh(legGeometry, limbSkin);
      // Far enough apart to read as two legs. Any closer and they merge into
      // one dark mass under the torso and the figure loses its stance.
      leg.position.set(0, torsoHeight * 0.4, side * PLAYER_RADIUS * 0.46);
      leg.castShadow = true;
      group.add(leg);
      limbs.push(leg);
    }

    // A pale wedge on the face, so which way someone is facing is readable at
    // distance against a body that is otherwise all one dark tone.
    const facing = new THREE.Mesh(
      new THREE.ConeGeometry(0.075, 0.2, 8),
      new THREE.MeshStandardMaterial({ color: 0xe8e2d2, roughness: 0.6 }),
    );
    facing.rotation.z = -Math.PI / 2;
    facing.position.set(PLAYER_RADIUS * 0.58, PLAYER_EYE_HEIGHT, 0);
    group.add(facing);

    const nameplate = this._makeLabelSprite(name, isLocal ? '#ffd166' : '#e8f1ff');
    nameplate.position.y = PLAYER_HEIGHT + 0.45;
    nameplate.scale.set(2, 0.5, 1);
    group.add(nameplate);

    // Everything that has to drop when the player sits down. The nameplate and
    // the facing wedge stay where they are — a label that sinks into the table
    // helps nobody.
    group.userData.body = body;
    group.userData.figure = [body, head, neck, facing, ...limbs];
    group.userData.restY = group.userData.figure.map((part) => part.position.y);
    this.scene.add(group);
    this.avatars.set(entityId, group);
    if (isLocal) this.localAvatar = group;
    return group;
  }

  removeAvatar(entityId) {
    const group = this.avatars.get(entityId);
    if (group === undefined) return;
    this.scene.remove(group);
    this.avatars.delete(entityId);
  }

  /** Positions an avatar. Called every rendered frame with interpolated values. */
  setAvatarTransform(entityId, x, y, z, yaw, seated) {
    const group = this.avatars.get(entityId);
    if (group === undefined) return;
    group.position.set(x, y, z);
    group.rotation.y = -yaw;

    // Sinking the whole figure reads as sitting without needing a rigged model.
    // Every part drops by the same amount, so the limbs stay attached — moving
    // the torso alone used to leave the head and arms hanging in the air.
    const drop = seated ? 0.45 : 0;
    const figure = group.userData.figure ?? [group.userData.body];
    const rest = group.userData.restY ?? [];
    figure.forEach((part, index) => {
      part.position.y = (rest[index] ?? part.position.y) - drop;
    });
  }

  setViewMode(mode) {
    this.viewMode = mode;
    // The local avatar would fill the screen from inside its own head.
    if (this.localAvatar !== null) this.localAvatar.visible = mode === 'third-person';
  }

  /**
   * Places the camera for the local player.
   *
   * In third person the camera is pulled back along the look direction and
   * stopped short of any wall it would otherwise clip through, so backing into
   * a corner tightens the shot instead of putting the camera outside the room.
   */
  updateCamera(x, y, z, yaw, pitch) {
    const eyeY = y + PLAYER_EYE_HEIGHT;

    // Drunk sway. Purely a camera offset: the player's actual position and
    // facing are untouched, so this never enters the shared simulation and
    // cannot desync prediction. Two prime-ish frequencies keep it from settling
    // into an obvious loop.
    if (this.drunkenness > 0.01) {
      const t = performance.now() / 1000;
      const amount = this.drunkenness;
      yaw += Math.sin(t * 0.73) * 0.05 * amount;
      pitch += Math.sin(t * 0.51 + 1.3) * 0.035 * amount;
    }

    if (this.viewMode === 'first-person') {
      this.camera.position.set(x, eyeY, z);
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.set(pitch, cameraYaw(yaw), 0, 'YXZ');
      return;
    }

    const back = new THREE.Vector3(
      -Math.cos(yaw) * Math.cos(pitch),
      // Looking up must swing the camera *down* and behind the player. Getting
      // this sign wrong lifts it into the ceiling instead.
      -Math.sin(pitch),
      -Math.sin(yaw) * Math.cos(pitch),
    ).normalize();

    const origin = new THREE.Vector3(x, eyeY, z);
    let distance = THIRD_PERSON_DISTANCE;

    this._raycaster.set(origin, back);
    this._raycaster.far = THIRD_PERSON_DISTANCE;
    const hit = this._raycaster.intersectObjects(this._occluders, false)[0];
    if (hit !== undefined) {
      // Stop just short of the surface so the near plane does not clip through it.
      distance = Math.max(0.8, hit.distance - 0.3);
    }

    this.camera.position.copy(origin).addScaledVector(back, distance);
    this.camera.position.y += THIRD_PERSON_HEIGHT - PLAYER_EYE_HEIGHT;
    this.camera.lookAt(origin);
  }

  _isDescendantOf(object, ancestor) {
    let current = object;
    while (current !== null) {
      if (current === ancestor) return true;
      current = current.parent;
    }
    return false;
  }

  /** The table the player is close enough to use, or null. */
  findInteractableInRange(x, z, range) {
    let closest = null;
    let closestDistance = range;
    for (const group of this._tableMeshes) {
      const dx = group.position.x - x;
      const dz = group.position.z - z;
      const distance = Math.hypot(dx, dz);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = group;
      }
    }
    return closest === null
      ? null
      : {
          id: closest.userData.interactableId,
          label: closest.userData.label,
          prompt: closest.userData.prompt,
        };
  }

  _handleResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Puts the hand being played onto the table's felt.
   *
   * Driven by the same table state the HUD panel reads — there is no separate
   * deal message, because the cards are already in it.
   */
  setTableHand(state, hand) {
    if (state === null || state === undefined) {
      this.clearTableHand();
      return;
    }
    const interactable = this._interactables.get(state.tableId);
    this.cardTable.sync(state, hand, interactable);
    // Chips come off the same state as the cards, so a bet and the hand it
    // bought can never be shown against different boxes.
    this.chipStacks.sync(state, interactable);
  }

  clearTableHand() {
    this.cardTable.clear();
    this.chipStacks.clear();
  }

  render() {
    // Cards are animated here rather than on table updates: those arrive about
    // five times a second, and a card in flight has to move every frame.
    this.cardTable.update();
    this.renderer.render(this.scene, this.camera);
  }
}
