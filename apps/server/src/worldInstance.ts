import { diffEntity, type Baseline } from '@keydate/netcode';
import {
  ENTITY_FLAG_GROUNDED,
  ENTITY_FLAG_SEATED,
  ENTITY_FLAG_SPRINTING,
  buttonsToMoveInput,
  type EntitySnapshot,
  type InputFrame,
  type ServerEvent,
  type ServerMessage,
} from '@keydate/protocol';
import { getTableGame, TableRuntime } from '@keydate/table-games';
import {
  buildCasinoFloor,
  createPlayerState,
  distanceXZ,
  INTERACT_RANGE,
  INTERACT_RANGE_SERVER_TOLERANCE,
  stepPlayer,
  TICK_DT,
  type MoveInput,
  type PlayerPhysicsState,
  type World,
} from '@keydate/sim';
import { wrapAngle } from '@keydate/protocol';
import { clampIntoxication, drink, findDrink, publicMenu, soberUp } from './bar.js';
import { config } from './config.js';
import { ChipLedger } from './ledger.js';

/**
 * One running world: its players, its tables, and its authoritative tick loop.
 *
 * A world instance is self-contained and holds no global state, so a session
 * code maps to exactly one of these and additional shards are just additional
 * instances. Nothing here knows about sockets — the caller supplies a `send`
 * function per player — which keeps the simulation testable without a network.
 */

export type SendFn = (message: ServerMessage) => void;

export interface PlayerConnection {
  playerId: string;
  entityId: number;
  name: string;
  send: SendFn;
  resumeToken: string;
}

interface PlayerRecord extends PlayerConnection {
  state: PlayerPhysicsState;
  /** Inputs received but not yet simulated, oldest first. */
  inputQueue: InputFrame[];
  /** Highest input seq consumed by the simulation. */
  ackedInput: number;
  /** Highest seq ever accepted, used to reject replayed or out-of-order frames. */
  highestSeqSeen: number;
  connected: boolean;
  disconnectedAt: number | null;
  /** Per-client delta baseline: what we last told this client about each entity. */
  baseline: Baseline<EntitySnapshot>;
  /** Events queued for delivery on the next tick. */
  pendingEvents: ServerEvent[];
  lastTableStateSentTick: number;
  /** How drunk this player is, 0..1. Bought at the bar, wears off with time. */
  drunkenness: number;
  /** The bar this player has open, or null. Purely so the menu can be closed. */
  atBar: number | null;
}

/** Entity ids are partitioned so a client can tell players from props on sight. */
const PLAYER_ENTITY_ID_BASE = 1000;

/** Index of the seat closest to a position, or undefined if the table has none. */
function nearestSeat(interactable: { seats: { x: number; z: number }[] }, x: number, z: number) {
  let best: number | undefined;
  let bestDistance = Infinity;
  interactable.seats.forEach((seat, index) => {
    const distance = distanceXZ(x, z, seat.x, seat.z);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/**
 * Where a player ends up when they stand up, measured from the table centre.
 *
 * Far enough out to clear the stool they were on — stools sit at 2.5m and are
 * 0.52m across, so their outer edge is 2.76m out, plus the player's own 0.35m
 * half-width. And inside `INTERACT_RANGE`, so standing up never puts the table
 * out of reach: getting up and sitting straight back down has to work.
 */
const STAND_BACK_RADIUS = 3.25;

/** Table state is pushed to seated players at this many ticks apart (~5Hz). */
const TABLE_STATE_INTERVAL_TICKS = 6;

export class WorldInstance {
  readonly world: World;
  private readonly players = new Map<string, PlayerRecord>();
  private readonly tables = new Map<number, TableRuntime>();
  private readonly ledger: ChipLedger;
  private nextEntityId = PLAYER_ENTITY_ID_BASE;
  private tick = 0;

  constructor(
    readonly sessionCode: string,
    /** Seed source for table rounds. Injected so a session can be replayed. */
    private readonly seedSource: () => number = () => Math.floor(Math.random() * 0xffffffff),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.world = buildCasinoFloor();
    this.ledger = new ChipLedger(config.startingChips);

    for (const interactable of this.world.interactables) {
      if (interactable.kind !== 'table' || interactable.gameId === undefined) continue;
      const definition = getTableGame(interactable.gameId);
      if (definition === undefined) {
        // A world referencing a game that was never registered is a build error,
        // not a runtime condition worth limping through.
        throw new Error(
          `World "${this.world.name}" references unknown table game "${interactable.gameId}".`,
        );
      }
      this.tables.set(
        interactable.id,
        new TableRuntime(
          interactable.id,
          definition,
          {
            debit: (playerId, amount, reason) => this.debit(playerId, amount, reason),
            credit: (playerId, amount, reason) => this.credit(playerId, amount, reason),
            now: this.now,
          },
          this.seedSource,
        ),
      );
    }
  }

  get playerCount(): number {
    return [...this.players.values()].filter((player) => player.connected).length;
  }

  get currentTick(): number {
    return this.tick;
  }

  isFull(): boolean {
    return this.playerCount >= config.maxPlayersPerWorld;
  }

  // -------------------------------------------------------------------------
  // Joining and leaving
  // -------------------------------------------------------------------------

  addPlayer(playerId: string, name: string, send: SendFn, resumeToken: string): PlayerRecord {
    const spawn = this.world.spawns[this.players.size % this.world.spawns.length] ?? {
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
    };

    const record: PlayerRecord = {
      playerId,
      entityId: this.nextEntityId++,
      name,
      send,
      resumeToken,
      state: createPlayerState(spawn.x, spawn.y, spawn.z, spawn.yaw),
      inputQueue: [],
      ackedInput: 0,
      highestSeqSeen: 0,
      connected: true,
      disconnectedAt: null,
      baseline: { tick: -1, entities: new Map() },
      pendingEvents: [],
      lastTableStateSentTick: -TABLE_STATE_INTERVAL_TICKS,
      drunkenness: 0,
      atBar: null,
    };

    this.players.set(playerId, record);
    this.ledger.balanceOf(playerId);
    this.broadcastEvent({ kind: 'player:joined', name }, playerId);
    return record;
  }

  /** Re-attaches a returning player to their existing avatar and chips. */
  resumePlayer(resumeToken: string, send: SendFn): PlayerRecord | null {
    for (const record of this.players.values()) {
      if (record.resumeToken !== resumeToken) continue;
      record.send = send;
      record.connected = true;
      record.disconnectedAt = null;
      // Force a keyframe: the returning client holds no usable baseline.
      record.baseline = { tick: -1, entities: new Map() };
      record.inputQueue = [];
      return record;
    }
    return null;
  }

  getPlayer(playerId: string): PlayerRecord | undefined {
    return this.players.get(playerId);
  }

  /**
   * Marks a player as gone but keeps their avatar and chips for the grace
   * window, so a dropped tunnel on a phone does not cost them their stack.
   */
  disconnectPlayer(playerId: string): void {
    const record = this.players.get(playerId);
    if (record === undefined) return;
    record.connected = false;
    record.disconnectedAt = this.now();
    // Standing them up refunds any live wager rather than leaving chips on a
    // table they cannot see.
    this.standUp(record);
  }

  private removePlayer(record: PlayerRecord): void {
    this.standUp(record);
    this.players.delete(record.playerId);
    this.ledger.forget(record.playerId);
    this.broadcastEvent({ kind: 'player:left', name: record.name }, record.playerId);
  }

  // -------------------------------------------------------------------------
  // Client intents
  // -------------------------------------------------------------------------

  queueInput(playerId: string, frames: InputFrame[]): void {
    const record = this.players.get(playerId);
    if (record === undefined) return;

    for (const frame of frames) {
      // Duplicated and reordered frames are normal on a lossy link; replaying
      // one would double-apply a movement, so anything not strictly newer is
      // dropped.
      if (frame.seq <= record.highestSeqSeen) continue;
      record.highestSeqSeen = frame.seq;
      record.inputQueue.push(frame);
    }

    // A client that floods input cannot buy extra movement: the queue is capped
    // and the simulation consumes at most one frame per tick regardless.
    const maxQueued = 32;
    if (record.inputQueue.length > maxQueued) {
      record.inputQueue.splice(0, record.inputQueue.length - maxQueued);
    }
  }

  handleInteract(playerId: string, entityId: number): void {
    const record = this.players.get(playerId);
    if (record === undefined) return;

    const interactable = this.world.interactables.find((entry) => entry.id === entityId);
    if (interactable === undefined) return;

    // Range is checked against the server's position, never the client's claim,
    // plus a small tolerance for the client predicting slightly ahead of us.
    const distance = distanceXZ(record.state.x, record.state.z, interactable.x, interactable.z);
    if (distance > INTERACT_RANGE + INTERACT_RANGE_SERVER_TOLERANCE) {
      this.sendError(record, 'invalid_action', 'You are too far away.');
      return;
    }

    if (interactable.kind === 'bar') {
      record.atBar = interactable.id;
      this.enqueueEvent(record, {
        kind: 'bar:menu',
        barId: interactable.id,
        label: interactable.label,
        menu: publicMenu(),
      });
      return;
    }

    const table = this.tables.get(interactable.id);
    if (table === undefined) return;

    if (record.state.seatedAt === interactable.id) return;
    if (record.state.seatedAt !== null) this.standUp(record);

    // Sit in the chair you actually walked up to. Allocating seat zero and
    // teleporting the player round the table is disorienting in a first-person
    // view — you press E and the room swings.
    const seatIndex = table.sit(
      playerId,
      nearestSeat(interactable, record.state.x, record.state.z),
    );
    if (seatIndex === null) {
      this.sendError(record, 'invalid_action', 'That table is full.');
      return;
    }

    const seat = interactable.seats[seatIndex % interactable.seats.length];
    if (seat !== undefined) {
      // Position moves to the chair; the view carries over.
      //
      // What is preserved is the angle *relative to the table*, not the compass
      // heading. Walk up looking straight at the felt and you are still looking
      // straight at it from the seat; walk up glancing off to one side and you
      // keep that glance. Either extreme is wrong: snapping to the seat's own
      // inward angle spins the room under the player, and holding the compass
      // heading now seats them facing a wall, because the seats are on the far
      // side of a half-circle from where anybody walks in.
      const approach = Math.atan2(interactable.z - record.state.z, interactable.x - record.state.x);
      const offset = wrapAngle(record.state.yaw - approach);

      record.state = {
        ...record.state,
        x: seat.x,
        y: seat.y,
        z: seat.z,
        yaw: wrapAngle(seat.yaw + offset),
      };
    }
    record.state.seatedAt = interactable.id;
    this.enqueueEvent(record, { kind: 'table:seated', tableId: interactable.id, seat: seatIndex });
    this.pushTableState(record, interactable.id, true);
  }

  handleLeaveTable(playerId: string): void {
    const record = this.players.get(playerId);
    if (record !== undefined) this.standUp(record);
  }

  handleWager(playerId: string, spotId: string, amount: number): void {
    const record = this.players.get(playerId);
    if (record === undefined) return;

    const tableId = record.state.seatedAt;
    if (tableId === null) {
      this.sendError(record, 'invalid_action', 'Sit at a table before betting.');
      return;
    }

    const table = this.tables.get(tableId);
    if (table === undefined) return;

    const result = table.placeWager(playerId, spotId, amount);
    if (!result.ok) {
      this.sendError(record, result.code, result.message);
      return;
    }
    this.broadcastTableState(tableId, true);
  }

  /**
   * Calls the deal at a table that waits to be asked.
   *
   * Broadcast to the whole table rather than acknowledged to the caller: the
   * last call is everyone's business, and the other seats need to see the clock
   * start the moment it starts.
   */
  handleCallDeal(playerId: string): void {
    const record = this.players.get(playerId);
    if (record === undefined) return;

    const tableId = record.state.seatedAt;
    if (tableId === null) {
      this.sendError(record, 'invalid_action', 'Sit at a table first.');
      return;
    }

    const table = this.tables.get(tableId);
    if (table === undefined) return;

    const result = table.callDeal(playerId);
    if (!result.ok) {
      this.sendError(record, result.code, result.message);
      return;
    }
    this.broadcastTableState(tableId, true);
  }

  /**
   * Takes a player's turn at a table with a decision phase.
   *
   * Every guard that matters lives in the runtime — whose turn it is, whether
   * the action is legal, whether it can be paid for. This only routes.
   */
  handleTableAction(playerId: string, actionId: string): void {
    const record = this.players.get(playerId);
    if (record === undefined) return;

    const tableId = record.state.seatedAt;
    if (tableId === null) {
      this.sendError(record, 'invalid_action', 'You are not at a table.');
      return;
    }

    const table = this.tables.get(tableId);
    if (table === undefined) return;

    const result = table.takeAction(playerId, actionId);
    if (!result.ok) {
      this.sendError(record, result.code, result.message);
      return;
    }
    // Everyone at the table watches the hand, so the whole table is refreshed
    // rather than just the player who acted.
    this.broadcastTableState(tableId, true);
  }

  /**
   * Sells a drink.
   *
   * Range is re-checked here rather than trusted from the earlier interact: a
   * client that opened the menu and then walked away — or never walked over at
   * all — must not be able to keep ordering.
   */
  handleBuyDrink(playerId: string, drinkId: string): void {
    const record = this.players.get(playerId);
    if (record === undefined) return;

    const beverage = findDrink(drinkId);
    if (beverage === undefined) {
      this.sendError(record, 'invalid_action', 'No such drink.');
      return;
    }

    const bar = this.world.interactables.find(
      (entry) => entry.kind === 'bar' && entry.id === record.atBar,
    );
    if (bar === undefined) {
      this.sendError(record, 'invalid_action', 'You are not at the bar.');
      return;
    }

    const distance = distanceXZ(record.state.x, record.state.z, bar.x, bar.z);
    if (distance > INTERACT_RANGE + INTERACT_RANGE_SERVER_TOLERANCE) {
      record.atBar = null;
      this.enqueueEvent(record, { kind: 'bar:left', barId: bar.id });
      this.sendError(record, 'invalid_action', 'You are too far from the bar.');
      return;
    }

    if (!this.debit(playerId, beverage.price, `drink:${beverage.id}`)) {
      this.sendError(record, 'insufficient_chips', 'You cannot afford that.');
      return;
    }

    record.drunkenness = drink(record.drunkenness, beverage);
    this.enqueueEvent(record, {
      kind: 'drink:served',
      drinkId: beverage.id,
      name: beverage.name,
      drunkenness: record.drunkenness,
    });
  }

  /** Closes the bar menu, e.g. when the player walks away or presses escape. */
  handleLeaveBar(playerId: string): void {
    const record = this.players.get(playerId);
    if (record === undefined || record.atBar === null) return;
    const barId = record.atBar;
    record.atBar = null;
    this.enqueueEvent(record, { kind: 'bar:left', barId });
  }

  handleClearWagers(playerId: string): void {
    const record = this.players.get(playerId);
    if (record === undefined || record.state.seatedAt === null) return;
    const table = this.tables.get(record.state.seatedAt);
    if (table?.clearWagers(playerId) === true) {
      this.broadcastTableState(record.state.seatedAt, true);
    }
  }

  handleReady(playerId: string, ready: boolean): void {
    const record = this.players.get(playerId);
    if (record === undefined || record.state.seatedAt === null) return;
    this.tables.get(record.state.seatedAt)?.setReady(playerId, ready);
    this.broadcastTableState(record.state.seatedAt, true);
  }

  handleChat(playerId: string, channel: 'local' | 'table', text: string): void {
    const sender = this.players.get(playerId);
    if (sender === undefined) return;

    for (const record of this.players.values()) {
      if (!record.connected) continue;
      // 'table' reaches only the people sitting with you; 'local' reaches the
      // whole floor, which is fine while the world is a single room.
      if (channel === 'table' && record.state.seatedAt !== sender.state.seatedAt) continue;
      this.enqueueEvent(record, { kind: 'chat', from: sender.name, channel, text });
    }
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  /** Advances the whole world by one fixed tick and replicates it. */
  update(): void {
    this.tick += 1;

    this.simulatePlayers();
    this.updateBar();
    this.updateTables();
    this.expireDisconnected();
    this.replicate();
  }

  private simulatePlayers(): void {
    for (const record of this.players.values()) {
      // Exactly one input frame per tick. Consuming the whole queue would let a
      // client that batches inputs move several times in one tick — the classic
      // speed hack — so a backlog drains at one frame per tick instead.
      const frame = record.inputQueue.shift();

      const input: MoveInput = frame
        ? {
            moveX: frame.moveX,
            moveZ: frame.moveZ,
            yaw: frame.yaw,
            pitch: frame.pitch,
            // Shared with the client, which has to unpack these identically or
            // its prediction is of a different hand entirely.
            ...buttonsToMoveInput(frame.buttons),
          }
        : {
            // No input this tick (packet loss, or an idle player): carry the
            // last facing and coast. Never freeze — gravity must keep applying.
            moveX: 0,
            moveZ: 0,
            yaw: record.state.yaw,
            pitch: record.state.pitch,
            jump: false,
            sprint: false,
          };

      record.state = stepPlayer(record.state, input, this.world, TICK_DT);
      if (frame !== undefined) record.ackedInput = frame.seq;
    }
  }

  private updateTables(): void {
    for (const [tableId, table] of this.tables) {
      const previousPhase = table.currentPhase;
      const previousActor = table.currentActor;
      const resolution = table.update();

      if (resolution !== null) {
        const state = table.toPublicState();
        for (const record of this.seatedAt(tableId)) {
          this.enqueueEvent(record, {
            kind: 'table:resolved',
            tableId,
            result: {
              summary: resolution.summary,
              detail: resolution.detail,
              reveal: state.lastResult?.reveal ?? null,
            },
          });
        }
        this.broadcastTableState(tableId, true);
        this.grantBailouts(tableId);
        continue;
      }

      // Phase changes are the moments the UI must not miss (betting opening,
      // bets locking, the turn passing to you), so they push immediately rather
      // than waiting for the periodic refresh.
      if (table.currentPhase !== previousPhase || table.currentActor !== previousActor) {
        this.broadcastTableState(tableId, true);
      } else if (this.tick % TABLE_STATE_INTERVAL_TICKS === 0) {
        this.broadcastTableState(tableId, false);
      }
    }
  }

  /** Tops up anyone who just busted out at this table. */
  private grantBailouts(tableId: number): void {
    for (const record of this.seatedAt(tableId)) {
      const granted = this.ledger.bailout(record.playerId, config.bailoutChips);
      if (granted > 0) {
        this.enqueueEvent(record, {
          kind: 'chips:changed',
          delta: granted,
          balance: this.ledger.balanceOf(record.playerId),
          reason: 'bailout',
        });
      }
    }
  }

  /**
   * Wears off intoxication, and closes the menu of anyone who has wandered off.
   *
   * Sobering is driven by tick count rather than wall-clock deltas so it stays
   * in step with everything else the world does, and cannot be accelerated by a
   * client that stalls its own connection.
   */
  private updateBar(): void {
    for (const record of this.players.values()) {
      if (record.drunkenness > 0) {
        record.drunkenness = soberUp(record.drunkenness, TICK_DT);
      }

      if (record.atBar === null) continue;
      const bar = this.world.interactables.find((entry) => entry.id === record.atBar);
      if (bar === undefined) continue;
      const distance = distanceXZ(record.state.x, record.state.z, bar.x, bar.z);
      if (distance > INTERACT_RANGE + INTERACT_RANGE_SERVER_TOLERANCE + 1) {
        const barId = record.atBar;
        record.atBar = null;
        this.enqueueEvent(record, { kind: 'bar:left', barId });
      }
    }
  }

  private expireDisconnected(): void {
    const now = this.now();
    for (const record of [...this.players.values()]) {
      if (record.connected || record.disconnectedAt === null) continue;
      if (now - record.disconnectedAt >= config.resumeGraceMs) this.removePlayer(record);
    }
  }

  // -------------------------------------------------------------------------
  // Replication
  // -------------------------------------------------------------------------

  private replicate(): void {
    // Build the full entity set once, then delta it per client against that
    // client's own baseline.
    const current = new Map<number, EntitySnapshot>();
    for (const record of this.players.values()) {
      if (!record.connected) continue;
      current.set(record.entityId, this.toEntitySnapshot(record));
    }

    for (const record of this.players.values()) {
      if (!record.connected) continue;

      const isKeyframe = record.baseline.tick < 0;
      const entities: EntitySnapshot[] = [];

      for (const [entityId, snapshot] of current) {
        const previous = isKeyframe ? undefined : record.baseline.entities.get(entityId);
        const delta = diffEntity(previous, snapshot, 'id');
        if (delta !== null) entities.push(delta as EntitySnapshot);
      }

      const removed: number[] = [];
      for (const entityId of record.baseline.entities.keys()) {
        if (!current.has(entityId)) removed.push(entityId);
      }

      record.send({
        type: 'snapshot',
        tick: this.tick,
        baseTick: isKeyframe ? null : record.baseline.tick,
        ackedInput: record.ackedInput,
        entities,
        removed,
      });

      record.baseline = { tick: this.tick, entities: new Map(current) };

      if (record.pendingEvents.length > 0) {
        record.send({ type: 'events', tick: this.tick, events: record.pendingEvents });
        record.pendingEvents = [];
      }
    }
  }

  private toEntitySnapshot(record: PlayerRecord): EntitySnapshot {
    let flags = 0;
    if (record.state.grounded) flags |= ENTITY_FLAG_GROUNDED;
    if (record.state.seatedAt !== null) flags |= ENTITY_FLAG_SEATED;
    if (Math.abs(record.state.vx) + Math.abs(record.state.vz) > 5) flags |= ENTITY_FLAG_SPRINTING;

    return {
      id: record.entityId,
      x: record.state.x,
      y: record.state.y,
      z: record.state.z,
      yaw: record.state.yaw,
      pitch: record.state.pitch,
      flags,
      name: record.name,
      // Stacks are public on purpose: seeing who is up and who is desperate is
      // most of the fun of playing with friends.
      chips: this.ledger.balanceOf(record.playerId),
      seatedAt: record.state.seatedAt,
      // Quantised to 1/100. Replicating raw floats would mark every player as
      // changed on every single tick purely from sobering up, defeating the
      // whole point of delta encoding.
      drunkenness: Math.round(clampIntoxication(record.drunkenness) * 100) / 100,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private *seatedAt(tableId: number): Generator<PlayerRecord> {
    for (const record of this.players.values()) {
      if (record.connected && record.state.seatedAt === tableId) yield record;
    }
  }

  private standUp(record: PlayerRecord): void {
    const tableId = record.state.seatedAt;
    if (tableId === null) return;

    this.tables.get(tableId)?.stand(record.playerId);
    record.state.seatedAt = null;
    this.stepBackFromSeat(record, tableId);
    this.enqueueEvent(record, { kind: 'table:left', tableId });
    this.broadcastTableState(tableId, true);
  }

  /**
   * Steps a player back off the stool they were sitting on.
   *
   * A seated player is parked on the seat anchor, which is the middle of a
   * solid stool — fine while seated, because the simulation does not move them
   * at all. The moment they stand up it is not fine: they are inside geometry,
   * and collision only permits a move to a clear destination, so every
   * direction is refused and they are stuck on the spot forever.
   *
   * Stepping out radially puts them where somebody who had just got up would
   * actually be standing, and inside interact range so they can sit straight
   * back down.
   */
  private stepBackFromSeat(record: PlayerRecord, tableId: number): void {
    const table = this.world.interactables.find((entry) => entry.id === tableId);
    if (table === undefined) return;

    const dx = record.state.x - table.x;
    const dz = record.state.z - table.z;
    const length = Math.hypot(dx, dz);
    // Dead centre of the table is not a direction; any ray out will do.
    const ux = length < 0.001 ? 1 : dx / length;
    const uz = length < 0.001 ? 0 : dz / length;

    record.state.x = table.x + ux * STAND_BACK_RADIUS;
    record.state.z = table.z + uz * STAND_BACK_RADIUS;
    record.state.vx = 0;
    record.state.vz = 0;
  }

  private broadcastTableState(tableId: number, force: boolean): void {
    for (const record of this.seatedAt(tableId)) {
      this.pushTableState(record, tableId, force);
    }
  }

  private pushTableState(record: PlayerRecord, tableId: number, force: boolean): void {
    if (!force && this.tick - record.lastTableStateSentTick < TABLE_STATE_INTERVAL_TICKS) return;
    const table = this.tables.get(tableId);
    if (table === undefined) return;
    record.lastTableStateSentTick = this.tick;
    this.enqueueEvent(record, { kind: 'table:state', tableId, state: table.toPublicState() });
  }

  private enqueueEvent(record: PlayerRecord, event: ServerEvent): void {
    record.pendingEvents.push(event);
  }

  private broadcastEvent(event: ServerEvent, exceptPlayerId?: string): void {
    for (const record of this.players.values()) {
      if (!record.connected || record.playerId === exceptPlayerId) continue;
      this.enqueueEvent(record, event);
    }
  }

  private sendError(record: PlayerRecord, code: string, message: string): void {
    record.send({ type: 'error', code: code as never, message });
  }

  private debit(playerId: string, amount: number, reason: string): boolean {
    const ok = this.ledger.debit(playerId, amount, reason);
    if (ok) this.notifyChips(playerId, -amount, reason);
    return ok;
  }

  private credit(playerId: string, amount: number, reason: string): void {
    this.ledger.credit(playerId, amount, reason);
    this.notifyChips(playerId, amount, reason);
  }

  private notifyChips(playerId: string, delta: number, reason: string): void {
    const record = this.players.get(playerId);
    if (record === undefined) return;
    this.enqueueEvent(record, {
      kind: 'chips:changed',
      delta,
      balance: this.ledger.balanceOf(playerId),
      reason,
    });
  }

  balanceOf(playerId: string): number {
    return this.ledger.balanceOf(playerId);
  }

  drunkennessOf(playerId: string): number {
    return this.players.get(playerId)?.drunkenness ?? 0;
  }
}
