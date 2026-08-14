/**
 * Every message that crosses the socket, in both directions.
 *
 * The server is authoritative. Clients send *inputs and intents*, never state:
 * anything a client asserts about its position, chip balance or a wager outcome
 * is ignored. The client may predict locally, but the server's snapshot always
 * wins and the client reconciles to it.
 */

export const PROTOCOL_VERSION = 1;

export type PlayerId = string;
export type EntityId = number;

/** Which camera the player is currently driving. Purely cosmetic to the server. */
export type ViewMode = 'first-person' | 'third-person';

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

/** First message on a fresh socket. */
export interface ClientHello {
  type: 'hello';
  protocolVersion: number;
  displayName: string;
  /** Private session code to join a friend's world; omit to join the public world. */
  sessionCode?: string;
  /** Presented after a refresh or a dropped tunnel to reclaim the same avatar. */
  resumeToken?: string;
}

/**
 * One simulated frame of intent. Sent at the fixed input rate and buffered
 * client-side until the server acknowledges it, so unacknowledged frames can be
 * replayed during reconciliation.
 */
export interface InputFrame {
  /** Monotonic per connection. The server echoes the highest one it consumed. */
  seq: number;
  /** Strafe axis, -1..1. */
  moveX: number;
  /** Forward axis, -1..1. */
  moveZ: number;
  /** Radians. Drives movement direction, so the server needs it. */
  yaw: number;
  /** Radians. Look-only, replicated so others see where you are looking. */
  pitch: number;
  /** Bitmask of INPUT_BUTTON_* flags. */
  buttons: number;
}

export interface ClientInput {
  type: 'input';
  frames: InputFrame[];
}

/** Interact with whatever the player is standing at (a table seat, a door). */
export interface ClientInteract {
  type: 'interact';
  entityId: EntityId;
}

/** Stand up from a table seat. */
export interface ClientLeaveTable {
  type: 'table:leave';
}

/** Stake virtual chips on a betting spot at the table the player is seated at. */
export interface ClientPlaceWager {
  type: 'table:wager';
  /** Which betting spot, as defined by the table game's rules module. */
  spotId: string;
  /** Chips to stake. Integer, validated against the player's balance server-side. */
  amount: number;
}

/** Withdraw a wager before the table locks. */
export interface ClientClearWagers {
  type: 'table:clear';
}

/** Declare readiness so a table can resolve without waiting out the full timer. */
export interface ClientTableReady {
  type: 'table:ready';
  ready: boolean;
}

export interface ClientChat {
  type: 'chat';
  channel: 'local' | 'table';
  text: string;
}

/** Cosmetic; lets other clients render your avatar's head correctly. */
export interface ClientSetViewMode {
  type: 'view-mode';
  mode: ViewMode;
}

/** Round-trip probe used to estimate latency and server clock offset. */
export interface ClientPing {
  type: 'ping';
  clientTime: number;
}

export type ClientMessage =
  | ClientHello
  | ClientInput
  | ClientInteract
  | ClientLeaveTable
  | ClientPlaceWager
  | ClientClearWagers
  | ClientTableReady
  | ClientChat
  | ClientSetViewMode
  | ClientPing;

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export interface ServerWelcome {
  type: 'welcome';
  protocolVersion: number;
  playerId: PlayerId;
  entityId: EntityId;
  resumeToken: string;
  sessionCode: string;
  /** Simulation rate in Hz. The client runs its prediction at exactly this rate. */
  tickRate: number;
  serverTick: number;
  /** Static geometry and interactables; sent once, never replicated per tick. */
  world: unknown;
}

/** Replicated per-entity state. Absent fields mean "unchanged since baseline". */
export interface EntitySnapshot {
  id: EntityId;
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  pitch?: number;
  /** Bitmask of ENTITY_FLAG_* values. */
  flags?: number;
  name?: string;
  chips?: number;
  /** Table the entity is seated at, or null when standing. */
  seatedAt?: EntityId | null;
}

/**
 * The authoritative view of the world for this client, for one tick.
 *
 * Delta-encoded against `baseTick`. A client that no longer holds `baseTick`
 * discards the snapshot and waits for the next keyframe (`baseTick === null`).
 */
export interface ServerSnapshot {
  type: 'snapshot';
  tick: number;
  /** Tick this delta is encoded against; null marks a full keyframe. */
  baseTick: number | null;
  /** Highest input seq the server has consumed for this client. */
  ackedInput: number;
  entities: EntitySnapshot[];
  /** Entities that left this client's interest set. */
  removed: EntityId[];
}

/** Discrete things that happened, delivered exactly once rather than replicated. */
export type ServerEvent =
  | { kind: 'table:seated'; tableId: EntityId; seat: number }
  | { kind: 'table:left'; tableId: EntityId }
  | { kind: 'table:state'; tableId: EntityId; state: unknown }
  | { kind: 'table:resolved'; tableId: EntityId; result: unknown }
  | { kind: 'chips:changed'; delta: number; balance: number; reason: string }
  | { kind: 'chat'; from: string; channel: 'local' | 'table' | 'system'; text: string }
  | { kind: 'player:joined'; name: string }
  | { kind: 'player:left'; name: string };

export interface ServerEvents {
  type: 'events';
  tick: number;
  events: ServerEvent[];
}

export interface ServerPong {
  type: 'pong';
  clientTime: number;
  serverTime: number;
  serverTick: number;
}

export interface ServerError {
  type: 'error';
  code: ErrorCode;
  message: string;
}

export type ServerMessage =
  ServerWelcome | ServerSnapshot | ServerEvents | ServerPong | ServerError;

export type ErrorCode =
  | 'bad_message'
  | 'protocol_mismatch'
  | 'session_not_found'
  | 'world_full'
  | 'name_rejected'
  | 'not_authorized'
  | 'invalid_action'
  | 'insufficient_chips'
  | 'table_locked'
  | 'rate_limited';

// ---------------------------------------------------------------------------
// Bit flags
// ---------------------------------------------------------------------------

export const INPUT_BUTTON_JUMP = 1 << 0;
export const INPUT_BUTTON_SPRINT = 1 << 1;
export const INPUT_BUTTON_INTERACT = 1 << 2;
export const INPUT_BUTTON_CROUCH = 1 << 3;

export const ENTITY_FLAG_GROUNDED = 1 << 0;
export const ENTITY_FLAG_SPRINTING = 1 << 1;
export const ENTITY_FLAG_SEATED = 1 << 2;
export const ENTITY_FLAG_LOCAL_PLAYER = 1 << 3;
