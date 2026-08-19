import {
  FixedTimestep,
  InterpolationBuffer,
  PredictionBuffer,
  needsCorrection,
} from '@keydate/netcode';
import { ENTITY_FLAG_SEATED, INPUT_BUTTON_INTERACT } from '@keydate/protocol';
import {
  INTERACT_RANGE,
  TICK_DT,
  createPlayerState,
  lerp,
  lerpAngle,
  stepPlayer,
} from '@keydate/sim';
import { Hud } from './hud.js';
import { InputController } from './input.js';
import { Connection } from './net.js';
import { WorldRenderer } from './renderer.js';

/**
 * Client entry point and main loop.
 *
 * Two clocks run here, deliberately:
 *
 *  - A fixed 30Hz simulation clock, locked to the server's, that samples input
 *    and predicts the local player. Its rate must not depend on framerate.
 *  - The browser's render loop, which draws as fast as the display allows and
 *    interpolates between simulated states so motion is smooth at 144Hz just as
 *    it is at 30.
 *
 * Conflating the two is the classic mistake: it makes movement speed depend on
 * framerate and makes prediction disagree with the server.
 */

const canvas = document.getElementById('viewport');
const connection = new Connection();
const input = new InputController(canvas);
const renderer = new WorldRenderer(canvas);
const hud = new Hud(connection);
// The blur lives in CSS on the canvas; the sway lives in the camera. Both are
// driven from the same replicated value.
hud.onDrunkenness = (level) => {
  renderer.drunkenness = level;
};

/** Authoritative-ish local player state, corrected by every snapshot. */
let localState = createPlayerState(0, 0, 0, 0);
/** The state as of the previous tick, for render interpolation. */
let previousState = { ...localState };

const prediction = new PredictionBuffer();
const timestep = new FixedTimestep(TICK_DT);

/** Remote entities: entityId -> { buffer, meta }. */
const remotes = new Map();
let world = null;
let worldBuilt = false;
let viewMode = 'first-person';

// ---------------------------------------------------------------------------
// Join flow
// ---------------------------------------------------------------------------

const joinScreen = document.getElementById('join-screen');
const joinForm = document.getElementById('join-form');
const joinError = document.getElementById('join-error');

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = document.getElementById('name-input').value.trim();
  const code = document.getElementById('code-input').value.trim().toUpperCase();
  if (name.length === 0) return;

  // The token is kept in sessionStorage so a refresh reclaims the same avatar
  // and chip stack, but a new tab is genuinely a new player.
  const stored = sessionStorage.getItem('keydate:resume');
  if (stored !== null) connection.resumeToken = stored;

  connection.connect(name, code);
  document.getElementById('join-button').disabled = true;
});

// A packaged build with no server address baked in can never connect. Say so
// on the join screen rather than spinning forever on a reconnect timer.
connection.on('config-error', (error) => {
  joinError.hidden = false;
  joinError.textContent = error.message;
  document.getElementById('join-button').disabled = false;
});

connection.on('server-error', (message) => {
  if (joinScreen.hidden) {
    hud.addChatLine(null, message.message, 'system');
    return;
  }
  joinError.hidden = false;
  joinError.textContent = message.message;
  document.getElementById('join-button').disabled = false;
});

connection.on('welcome', (message) => {
  world = message.world;
  sessionStorage.setItem('keydate:resume', message.resumeToken);

  // A reconnect re-sends welcome; the scene must not be built twice. Track
  // this explicitly rather than inferring it from the scene's child count,
  // which silently breaks the moment the lighting rig gains a light.
  if (!worldBuilt) {
    renderer.buildWorld(world);
    worldBuilt = true;
  }

  const spawn = world.spawns[0] ?? { x: 0, y: 0, z: 0, yaw: 0 };
  localState = createPlayerState(spawn.x, spawn.y, spawn.z, spawn.yaw);
  previousState = { ...localState };
  input.yaw = spawn.yaw;
  prediction.reset();

  if (renderer.avatars.has(message.entityId)) renderer.removeAvatar(message.entityId);
  renderer.addAvatar(message.entityId, 'You', true);
  renderer.setViewMode(viewMode);

  joinScreen.hidden = true;
  hud.show();
  hud.setSession(message.sessionCode);

  if (input.isTouchDevice) document.getElementById('touch-controls').hidden = false;
});

// ---------------------------------------------------------------------------
// Snapshots: reconciliation for the local player, interpolation for everyone else
// ---------------------------------------------------------------------------

/** Last full state per entity, so deltas can be applied against a baseline. */
const entityBaseline = new Map();

connection.on('snapshot', (snapshot) => {
  if (world === null) return;

  if (snapshot.baseTick === null) entityBaseline.clear();

  for (const delta of snapshot.entities) {
    const merged = { ...(entityBaseline.get(delta.id) ?? {}), ...delta };
    entityBaseline.set(delta.id, merged);
  }

  for (const entityId of snapshot.removed) {
    entityBaseline.delete(entityId);
    remotes.delete(entityId);
    renderer.removeAvatar(entityId);
  }

  for (const [entityId, entity] of entityBaseline) {
    if (entityId === connection.entityId) {
      applyLocalCorrection(entity, snapshot.ackedInput);
      hud.setChips(entity.chips ?? 0);
      if (entity.drunkenness !== undefined) hud.setDrunkenness(entity.drunkenness);
      continue;
    }

    if (!remotes.has(entityId)) {
      remotes.set(entityId, {
        buffer: new InterpolationBuffer({ tickIntervalMs: 1000 / connection.tickRate }),
        name: entity.name ?? 'Player',
      });
      renderer.addAvatar(entityId, entity.name ?? 'Player', false);
    }

    remotes.get(entityId).buffer.push({
      tick: snapshot.tick,
      x: entity.x ?? 0,
      y: entity.y ?? 0,
      z: entity.z ?? 0,
      yaw: entity.yaw ?? 0,
      seated: ((entity.flags ?? 0) & ENTITY_FLAG_SEATED) !== 0,
    });
  }

  latestServerTick = snapshot.tick;
});

let latestServerTick = 0;

/**
 * Snaps the local player onto the server's state and replays unacknowledged input.
 *
 * The correction is only *applied* when the disagreement is large enough to
 * matter — otherwise ordinary floating-point drift would jitter the camera
 * every single tick.
 */
function applyLocalCorrection(entity, ackedInput) {
  const authoritative = {
    ...localState,
    x: entity.x ?? localState.x,
    y: entity.y ?? localState.y,
    z: entity.z ?? localState.z,
    seatedAt: entity.seatedAt ?? null,
  };

  const corrected = prediction.reconcile({
    authoritative,
    ackedSeq: ackedInput,
    step: (state, frame) => stepPlayer(state, frame, world, TICK_DT),
  });

  // Seating is a server decision that prediction cannot anticipate, so it is
  // always taken verbatim rather than being treated as drift.
  const seatChanged = corrected.seatedAt !== localState.seatedAt;

  if (seatChanged || needsCorrection(localState, corrected)) {
    localState = corrected;
    previousState = { ...corrected };
  } else {
    localState.seatedAt = corrected.seatedAt;
  }
}

// ---------------------------------------------------------------------------
// Table and chat events
// ---------------------------------------------------------------------------

connection.on('event:table:state', (event) => {
  hud.renderTable(event.state);
  // The panel and the felt are drawn from one resolved hand, so they cannot
  // disagree about what was dealt.
  renderer.setTableHand(event.state, hud.currentHand);
});
connection.on('event:table:left', () => {
  hud.hideTable();
  renderer.clearTableHand();
});
connection.on('event:table:resolved', (event) => {
  if (event.result?.summary) hud.addChatLine(null, event.result.summary, 'system');
});
connection.on('event:chips:changed', (event) => {
  hud.setChips(event.balance);
});
connection.on('event:bar:menu', (event) => hud.showBar(event.label, event.menu));
connection.on('event:bar:left', () => hud.hideBar());
connection.on('event:drink:served', (event) => {
  hud.setDrunkenness(event.drunkenness);
  hud.addChatLine(null, `You drink a ${event.name}.`, 'system');
});
connection.on('event:chat', (event) => hud.addChatLine(event.from, event.text, event.channel));
connection.on('event:player:joined', (event) =>
  hud.addChatLine(null, `${event.name} entered the floor.`, 'system'),
);
connection.on('event:player:left', (event) =>
  hud.addChatLine(null, `${event.name} left.`, 'system'),
);
connection.on('disconnected', () =>
  hud.addChatLine(null, 'Connection lost. Reconnecting…', 'system'),
);

// ---------------------------------------------------------------------------
// HUD wiring
// ---------------------------------------------------------------------------

document.getElementById('view-toggle').addEventListener('click', (event) => {
  viewMode = viewMode === 'first-person' ? 'third-person' : 'first-person';
  renderer.setViewMode(viewMode);
  connection.send({ type: 'view-mode', mode: viewMode });
  event.target.textContent = viewMode === 'first-person' ? 'Third person' : 'First person';
  event.target.blur();
});

const chatInput = document.getElementById('chat-input');
chatInput.addEventListener('focus', () => {
  input.textEntryActive = true;
});
chatInput.addEventListener('blur', () => {
  input.textEntryActive = false;
});
chatInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const text = chatInput.value.trim();
  if (text.length > 0) {
    connection.send({
      type: 'chat',
      channel: localState.seatedAt === null ? 'local' : 'table',
      text,
    });
  }
  chatInput.value = '';
  chatInput.blur();
});
window.addEventListener('keydown', (event) => {
  // Enter opens chat, but only once the player is actually in the world —
  // otherwise it would steal the submit key from the join form.
  if (event.key === 'Enter' && !input.textEntryActive && joinScreen.hidden) {
    event.preventDefault();
    chatInput.focus();
  }
});

document.getElementById('touch-jump').addEventListener('touchstart', () => input.pressJump(true));
document.getElementById('touch-jump').addEventListener('touchend', () => input.pressJump(false));
document
  .getElementById('touch-interact')
  .addEventListener('touchstart', () => input.pressInteract());

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

function simulateTick() {
  const frame = input.sample();
  const interacting = (frame.buttons & INPUT_BUTTON_INTERACT) !== 0;

  const seq = prediction.record(frame);
  connection.queueInput({ seq, ...frame });

  previousState = { ...localState };
  localState = stepPlayer(localState, frame, world, TICK_DT);

  if (interacting && input.consumeInteract()) {
    if (localState.seatedAt !== null) {
      connection.send({ type: 'table:leave' });
    } else {
      const target = renderer.findInteractableInRange(localState.x, localState.z, INTERACT_RANGE);
      if (target !== null) connection.send({ type: 'interact', entityId: target.id });
    }
  }
}

function render(alpha) {
  // Draw the local player between the last two simulated states. Without this,
  // motion is visibly stepped on any display faster than the 30Hz tick rate.
  const x = lerp(previousState.x, localState.x, alpha);
  const y = lerp(previousState.y, localState.y, alpha);
  const z = lerp(previousState.z, localState.z, alpha);

  renderer.setAvatarTransform(
    connection.entityId,
    x,
    y,
    z,
    input.yaw,
    localState.seatedAt !== null,
  );
  renderer.updateCamera(x, y, z, input.yaw, input.pitch);

  for (const [entityId, remote] of remotes) {
    const sample = remote.buffer.sampleAt(latestServerTick, alpha);
    if (sample === null) continue;
    const { from, to, t } = sample;
    renderer.setAvatarTransform(
      entityId,
      lerp(from.x, to.x, t),
      lerp(from.y, to.y, t),
      lerp(from.z, to.z, t),
      lerpAngle(from.yaw, to.yaw, t),
      to.seated,
    );
  }

  if (localState.seatedAt === null) {
    const target = renderer.findInteractableInRange(localState.x, localState.z, INTERACT_RANGE);
    hud.showInteractPrompt(target === null ? null : target.prompt);
  } else {
    hud.showInteractPrompt(null);
  }

  renderer.render();
}

let frameCount = 0;

function loop(now) {
  requestAnimationFrame(loop);
  if (world === null) return;

  const ticks = timestep.advance(now);
  for (let i = 0; i < ticks; i += 1) simulateTick();
  if (ticks > 0) connection.flushInputs();

  render(timestep.alpha);

  // Ping display does not need updating every frame.
  frameCount += 1;
  if (frameCount % 30 === 0) hud.setPing(connection.ping);
}

requestAnimationFrame(loop);

/**
 * Introspection hook for the client smoke test (`apps/client/smoke.mjs`).
 *
 * The renderer and the prediction loop are entangled with the DOM and WebGL, so
 * the only way to assert on them is to drive a real browser. This exposes the
 * few values that test needs to ask about. It reads state rather than driving
 * the game — the server would reject anything it tried to assert anyway.
 */
window.__keydate = {
  position: () => ({ x: localState.x, y: localState.y, z: localState.z }),
  viewMode: () => viewMode,
  remoteCount: () => remotes.size,
  sceneStats: () => ({ ...renderer.stats }),
  yaw: () => input.yaw,
  drunkenness: () => hud.drunkenness ?? 0,
  /** Points the camera at the bar and reports the distance to it. */
  aimAtBar: () => {
    if (world === null) return null;
    const bar = world.interactables.find((entry) => entry.kind === 'bar');
    if (bar === undefined) return null;
    input.yaw = Math.atan2(bar.z - localState.z, bar.x - localState.x);
    return { id: bar.id, distance: Math.hypot(bar.x - localState.x, bar.z - localState.z) };
  },
  seatedAt: () => localState.seatedAt,
  /** Cards physically on the felt, and whether any are still in flight. */
  feltCards: () => ({
    count: renderer.cardTable.cardCount,
    dealing: renderer.cardTable.dealing,
  }),
  /**
   * Points the camera at the nearest table and reports how far away it is.
   *
   * Deliberately does not teleport: the server is authoritative and would snap
   * any such move straight back. The test walks there with real input, which
   * exercises the whole prediction path rather than sidestepping it.
   */
  aimAtNearestTable: (gameId = null) => {
    if (world === null) return null;
    let nearest = null;
    let nearestDistance = Infinity;
    // Optionally restrict to one game. Tables differ in how many players they
    // need before a round can start, so "the nearest table" is not a stable
    // target for anything that then expects betting to be open.
    for (const table of world.interactables) {
      if (gameId !== null && table.gameId !== gameId) continue;
      const distance = Math.hypot(table.x - localState.x, table.z - localState.z);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = table;
      }
    }
    if (nearest === null) return null;
    input.yaw = Math.atan2(nearest.z - localState.z, nearest.x - localState.x);
    return { id: nearest.id, label: nearest.label, distance: nearestDistance };
  },
};
