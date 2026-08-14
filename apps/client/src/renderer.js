import * as THREE from 'three';
import { PLAYER_EYE_HEIGHT, PLAYER_HEIGHT, PLAYER_RADIUS } from '@keydate/sim';

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

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b1020);
    this.scene.fog = new THREE.Fog(0x0b1020, 25, 70);

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

    this._buildLighting();
    this._handleResize();
    window.addEventListener('resize', () => this._handleResize());
  }

  _buildLighting() {
    // A casino floor is a bright room. The palette here is deliberately deep
    // blue, which means the lighting has to do real work — under a dim rig
    // these materials render as an almost featureless dark surface.
    this.scene.add(new THREE.AmbientLight(0x8ea0d0, 2.2));
    // Sky/ground fill separates the floor plane from the walls without needing
    // a second shadow-casting light.
    this.scene.add(new THREE.HemisphereLight(0xbcd0ff, 0x2a1f3d, 1.5));

    const key = new THREE.DirectionalLight(0xffe9c4, 1.6);
    key.position.set(12, 22, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    // The shadow frustum has to cover the whole floor or shadows pop in and out
    // as players walk toward the edges.
    key.shadow.camera.left = -30;
    key.shadow.camera.right = 30;
    key.shadow.camera.top = 24;
    key.shadow.camera.bottom = -24;
    key.shadow.camera.far = 60;
    this.scene.add(key);

    const rim = new THREE.PointLight(0xff5f8a, 220, 45);
    rim.position.set(0, 5.5, 0);
    this.scene.add(rim);

    // Warm pools over each corner of the floor, so the room has landmarks to
    // navigate by rather than reading as one flat box.
    for (const [px, pz] of [
      [-12, -8],
      [12, -8],
      [-12, 8],
      [12, 8],
    ]) {
      const lamp = new THREE.PointLight(0xffd9a0, 120, 22);
      lamp.position.set(px, 4.2, pz);
      this.scene.add(lamp);
    }
  }

  /** Builds the static scene from the world description the server sent. */
  buildWorld(world) {
    const { bounds } = world;
    const width = bounds.maxX - bounds.minX;
    const depth = bounds.maxZ - bounds.minZ;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshStandardMaterial({ color: 0x24365f, roughness: 0.8, metalness: 0.15 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2);
    floor.receiveShadow = true;
    this.scene.add(floor);

    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x33477e, roughness: 0.85 });
    for (const box of world.colliders) {
      // Table bodies get their own mesh in _buildTable. Drawing the collider
      // too leaves a grey slab poking out from under the felt.
      if (box.kind === 'table') continue;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ),
        wallMaterial,
      );
      mesh.position.set(
        (box.minX + box.maxX) / 2,
        (box.minY + box.maxY) / 2,
        (box.minZ + box.maxZ) / 2,
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this._occluders.push(mesh);
    }

    // Without a ceiling the top half of every shot is empty black, which reads
    // as a rendering failure rather than a room.
    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshStandardMaterial({ color: 0x161f3d, roughness: 1 }),
    );
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set((bounds.minX + bounds.maxX) / 2, 4, (bounds.minZ + bounds.maxZ) / 2);
    this.scene.add(ceiling);

    for (const interactable of world.interactables) {
      this._buildTable(interactable);
    }
  }

  _buildTable(interactable) {
    const group = new THREE.Group();
    group.position.set(interactable.x, 0, interactable.z);

    const felt = new THREE.Mesh(
      new THREE.CylinderGeometry(1.3, 1.3, 0.1, 32),
      new THREE.MeshStandardMaterial({ color: 0x1a7a4a, roughness: 0.9 }),
    );
    felt.position.y = 1.0;
    felt.castShadow = true;
    felt.receiveShadow = true;
    group.add(felt);
    this._occluders.push(felt);

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.6, 1.0, 16),
      new THREE.MeshStandardMaterial({ color: 0x3d2b1f, roughness: 0.8 }),
    );
    base.position.y = 0.5;
    base.castShadow = true;
    group.add(base);

    // A sign above the table, always readable because it faces the camera.
    const sign = this._makeLabelSprite(interactable.label);
    sign.position.y = 2.6;
    sign.scale.set(3, 0.75, 1);
    group.add(sign);

    // Seat markers, so it is obvious where you can sit before you walk over.
    for (const seat of interactable.seats) {
      const marker = new THREE.Mesh(
        new THREE.CircleGeometry(0.35, 16),
        new THREE.MeshBasicMaterial({ color: 0xff5f8a, transparent: true, opacity: 0.28 }),
      );
      marker.rotation.x = -Math.PI / 2;
      marker.position.set(seat.x - interactable.x, 0.02, seat.z - interactable.z);
      group.add(marker);
    }

    group.userData.interactableId = interactable.id;
    group.userData.label = interactable.label;
    this._tableMeshes.push(group);
    this.scene.add(group);
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

  /** Creates the avatar for a player entity. */
  addAvatar(entityId, name, isLocal) {
    const group = new THREE.Group();

    const bodyColor = isLocal ? 0xffd166 : 0x4cc9f0;
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT - PLAYER_RADIUS * 2, 6, 12),
      new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.6 }),
    );
    body.position.y = PLAYER_HEIGHT / 2;
    body.castShadow = true;
    group.add(body);

    // A nose-like wedge, so which way someone is facing is readable at distance.
    const facing = new THREE.Mesh(
      new THREE.ConeGeometry(0.12, 0.3, 8),
      new THREE.MeshStandardMaterial({ color: 0xffffff }),
    );
    facing.rotation.z = -Math.PI / 2;
    facing.position.set(PLAYER_RADIUS + 0.1, PLAYER_EYE_HEIGHT, 0);
    group.add(facing);

    const nameplate = this._makeLabelSprite(name, isLocal ? '#ffd166' : '#e8f1ff');
    nameplate.position.y = PLAYER_HEIGHT + 0.45;
    nameplate.scale.set(2, 0.5, 1);
    group.add(nameplate);

    group.userData.body = body;
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
    // Sinking the capsule reads as sitting without needing a rigged model.
    group.userData.body.position.y = seated ? PLAYER_HEIGHT / 2 - 0.45 : PLAYER_HEIGHT / 2;
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
      : { id: closest.userData.interactableId, label: closest.userData.label };
  }

  _handleResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
