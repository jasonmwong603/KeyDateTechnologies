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

    this._buildLighting();
    this._handleResize();
    window.addEventListener('resize', () => this._handleResize());
  }

  _buildLighting() {
    this.scene.add(new THREE.AmbientLight(0x4a5578, 1.4));

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

    const rim = new THREE.PointLight(0xff5f8a, 60, 40);
    rim.position.set(0, 6, 0);
    this.scene.add(rim);
  }

  /** Builds the static scene from the world description the server sent. */
  buildWorld(world) {
    const { bounds } = world;
    const width = bounds.maxX - bounds.minX;
    const depth = bounds.maxZ - bounds.minZ;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshStandardMaterial({ color: 0x14213d, roughness: 0.85, metalness: 0.1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2);
    floor.receiveShadow = true;
    this.scene.add(floor);

    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x1d2b53, roughness: 0.9 });
    for (const box of world.colliders) {
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
    }

    for (const interactable of world.interactables) {
      this._buildTable(interactable);
    }
  }

  _buildTable(interactable) {
    const group = new THREE.Group();
    group.position.set(interactable.x, 0, interactable.z);

    const felt = new THREE.Mesh(
      new THREE.CylinderGeometry(1.3, 1.3, 0.1, 32),
      new THREE.MeshStandardMaterial({ color: 0x0f5132, roughness: 0.95 }),
    );
    felt.position.y = 1.0;
    felt.castShadow = true;
    felt.receiveShadow = true;
    group.add(felt);

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
    ctx.font = 'bold 64px system-ui, sans-serif';
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
      this.camera.rotation.set(0, 0, 0, 'YXZ');
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.y = yaw - Math.PI / 2;
      this.camera.rotation.x = pitch;
      return;
    }

    const back = new THREE.Vector3(
      -Math.cos(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.sin(yaw) * Math.cos(pitch),
    ).normalize();

    const origin = new THREE.Vector3(x, eyeY, z);
    let distance = THIRD_PERSON_DISTANCE;

    this._raycaster.set(origin, back);
    this._raycaster.far = THIRD_PERSON_DISTANCE;
    const hits = this._raycaster.intersectObjects(this.scene.children, true);
    for (const hit of hits) {
      // Ignore the player's own avatar and any sprite (nameplates, signs).
      if (this.localAvatar !== null && this._isDescendantOf(hit.object, this.localAvatar)) continue;
      if (hit.object.isSprite) continue;
      distance = Math.max(0.8, hit.distance - 0.3);
      break;
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
