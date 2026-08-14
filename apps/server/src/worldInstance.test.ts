import { ENTITY_FLAG_SEATED, type ServerMessage } from '@keydate/protocol';
import { TICK_RATE } from '@keydate/sim';
import { beforeEach, describe, expect, it } from 'vitest';
import { WorldInstance } from './worldInstance.js';

/**
 * Integration tests for the authoritative world.
 *
 * These drive the world exactly as the gateway does — queue input, tick, read
 * the outgoing snapshots — so they cover the seams between simulation,
 * replication and the table runtime that unit tests on each piece cannot.
 */

/** Collects everything the server would send to one client. */
class FakeClient {
  messages: ServerMessage[] = [];

  send = (message: ServerMessage): void => {
    this.messages.push(message);
  };

  get snapshots(): Extract<ServerMessage, { type: 'snapshot' }>[] {
    return this.messages.filter(
      (m): m is Extract<ServerMessage, { type: 'snapshot' }> => m.type === 'snapshot',
    );
  }

  events(kind: string): unknown[] {
    return this.messages
      .filter((m): m is Extract<ServerMessage, { type: 'events' }> => m.type === 'events')
      .flatMap((m) => m.events)
      .filter((event) => event.kind === kind);
  }

  errors(): Extract<ServerMessage, { type: 'error' }>[] {
    return this.messages.filter(
      (m): m is Extract<ServerMessage, { type: 'error' }> => m.type === 'error',
    );
  }

  clear(): void {
    this.messages = [];
  }
}

let world: WorldInstance;
let clock: number;

beforeEach(() => {
  clock = 0;
  world = new WorldInstance(
    'TESTS',
    () => 4242,
    () => clock,
  );
});

function advance(ms: number): void {
  clock += ms;
}

/** Runs `count` ticks. */
function tick(count = 1): void {
  for (let i = 0; i < count; i += 1) world.update();
}

/** An input frame with sensible defaults. */
function frame(seq: number, overrides: Record<string, number> = {}) {
  return { seq, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, ...overrides };
}

describe('WorldInstance joining', () => {
  it('spawns a player and replicates them', () => {
    const client = new FakeClient();
    const record = world.addPlayer('p1', 'Sam', client.send, 'token-1');

    tick();

    const snapshot = client.snapshots[0]!;
    // The first snapshot must be a keyframe: the client holds no baseline yet.
    expect(snapshot.baseTick).toBeNull();
    const me = snapshot.entities.find((entity) => entity.id === record.entityId);
    expect(me?.name).toBe('Sam');
    expect(me?.chips).toBeGreaterThan(0);
  });

  it('tells existing players when someone joins', () => {
    const first = new FakeClient();
    world.addPlayer('p1', 'Sam', first.send, 't1');
    tick();
    first.clear();

    world.addPlayer('p2', 'Ada', new FakeClient().send, 't2');
    tick();

    expect(first.events('player:joined')).toContainEqual(expect.objectContaining({ name: 'Ada' }));
  });

  it('sends deltas after the first keyframe', () => {
    const client = new FakeClient();
    world.addPlayer('p1', 'Sam', client.send, 't1');
    tick(3);

    const [keyframe, second] = client.snapshots;
    expect(keyframe!.baseTick).toBeNull();
    expect(second!.baseTick).toBe(keyframe!.tick);
  });

  it('omits entities that did not change', () => {
    const client = new FakeClient();
    world.addPlayer('p1', 'Sam', client.send, 't1');
    // Standing still with no input: after the first tick nothing about the
    // player changes, so they should cost nothing to replicate.
    tick(5);

    expect(client.snapshots.at(-1)!.entities).toHaveLength(0);
  });

  it('gives a resuming player back their avatar and chips', () => {
    const first = new FakeClient();
    const record = world.addPlayer('p1', 'Sam', first.send, 'resume-me');
    tick();

    world.disconnectPlayer('p1');

    const second = new FakeClient();
    const resumed = world.resumePlayer('resume-me', second.send);

    expect(resumed?.playerId).toBe('p1');
    expect(resumed?.entityId).toBe(record.entityId);
    tick();
    // A resumed client must get a fresh keyframe, not a delta against a
    // baseline it no longer holds.
    expect(second.snapshots[0]!.baseTick).toBeNull();
  });

  it('rejects an unknown resume token', () => {
    expect(world.resumePlayer('never-issued', new FakeClient().send)).toBeNull();
  });
});

describe('WorldInstance movement', () => {
  it('moves a player who sends input', () => {
    const client = new FakeClient();
    const record = world.addPlayer('p1', 'Sam', client.send, 't1');
    const start = { ...record.state };

    world.queueInput('p1', [
      frame(1, { moveZ: 1 }),
      frame(2, { moveZ: 1 }),
      frame(3, { moveZ: 1 }),
    ]);
    tick(3);

    expect(record.state.x).not.toBe(start.x);
  });

  it('consumes exactly one input frame per tick', () => {
    const client = new FakeClient();
    const record = world.addPlayer('p1', 'Sam', client.send, 't1');

    // A client batching 10 frames must not get 10 ticks of movement in one tick:
    // that is the classic speed hack.
    world.queueInput(
      'p1',
      Array.from({ length: 10 }, (_, i) => frame(i + 1, { moveZ: 1 })),
    );
    tick(1);

    expect(record.ackedInput).toBe(1);
  });

  it('ignores replayed and out-of-order sequence numbers', () => {
    const client = new FakeClient();
    const record = world.addPlayer('p1', 'Sam', client.send, 't1');

    world.queueInput('p1', [frame(5, { moveZ: 1 })]);
    // Replaying an older frame must not move the player a second time.
    world.queueInput('p1', [frame(3, { moveZ: 1 }), frame(5, { moveZ: 1 })]);
    tick(4);

    expect(record.ackedInput).toBe(5);
  });

  it('acknowledges the highest consumed input in the snapshot', () => {
    const client = new FakeClient();
    world.addPlayer('p1', 'Sam', client.send, 't1');

    world.queueInput('p1', [frame(1), frame(2)]);
    tick(2);

    expect(client.snapshots.at(-1)!.ackedInput).toBe(2);
  });

  it('keeps applying gravity when input stops arriving', () => {
    const client = new FakeClient();
    const record = world.addPlayer('p1', 'Sam', client.send, 't1');

    world.queueInput('p1', [frame(1, { buttons: 1 })]); // jump
    tick(1);
    expect(record.state.y).toBeGreaterThan(0);

    // No further input at all — a dropped connection must not leave the player
    // hanging in mid-air.
    tick(TICK_RATE * 2);
    expect(record.state.y).toBe(0);
  });
});

describe('WorldInstance tables', () => {
  /** Walks a player onto a table's seat by teleporting their sim state. */
  function seatPlayerNear(playerId: string, tableId: number): void {
    const record = world.getPlayer(playerId)!;
    const table = world.world.interactables.find((entry) => entry.id === tableId)!;
    record.state.x = table.x;
    record.state.z = table.z + 1.5;
  }

  it('seats a player who interacts in range', () => {
    const client = new FakeClient();
    world.addPlayer('p1', 'Sam', client.send, 't1');
    seatPlayerNear('p1', 1);

    world.handleInteract('p1', 1);
    tick();

    expect(world.getPlayer('p1')!.state.seatedAt).toBe(1);
    expect(client.events('table:seated')).toHaveLength(1);
  });

  it('refuses to seat a player who is nowhere near the table', () => {
    const client = new FakeClient();
    world.addPlayer('p1', 'Sam', client.send, 't1');
    // Range is checked against the server's own position, never the client's claim.
    world.handleInteract('p1', 1);

    expect(world.getPlayer('p1')!.state.seatedAt).toBeNull();
    expect(client.errors().at(-1)?.code).toBe('invalid_action');
  });

  it('accepts interaction anywhere a player can physically stand', () => {
    // A player walking straight at a table stops ~1.69m from its centre from
    // every approach angle, so every legitimate approach must be accepted.
    const table = world.world.interactables[0]!;
    for (let degrees = 0; degrees < 360; degrees += 45) {
      const angle = (degrees * Math.PI) / 180;
      const playerId = `p${degrees}`;
      world.addPlayer(playerId, `P${degrees}`, new FakeClient().send, `t${degrees}`);

      const record = world.getPlayer(playerId)!;
      record.state.x = table.x + Math.cos(angle) * 1.7;
      record.state.z = table.z + Math.sin(angle) * 1.7;
      world.handleInteract(playerId, table.id);

      expect(world.getPlayer(playerId)!.state.seatedAt).toBe(table.id);
      world.handleLeaveTable(playerId);
    }
  });

  it('rejects interaction from beyond the tolerated range', () => {
    const client = new FakeClient();
    world.addPlayer('p1', 'Sam', client.send, 't1');
    const table = world.world.interactables[0]!;
    const record = world.getPlayer('p1')!;

    // Just outside INTERACT_RANGE + tolerance (2.4 + 0.75).
    record.state.x = table.x + 3.4;
    record.state.z = table.z;
    world.handleInteract('p1', table.id);

    expect(record.state.seatedAt).toBeNull();
  });

  it('flags a seated player in the snapshot', () => {
    const client = new FakeClient();
    const record = world.addPlayer('p1', 'Sam', client.send, 't1');
    seatPlayerNear('p1', 1);
    world.handleInteract('p1', 1);
    tick();

    const entity = client.snapshots
      .flatMap((snapshot) => snapshot.entities)
      .findLast((candidate) => candidate.id === record.entityId);
    expect((entity?.flags ?? 0) & ENTITY_FLAG_SEATED).toBeTruthy();
  });

  it('rejects a wager from a player who is not at a table', () => {
    const client = new FakeClient();
    world.addPlayer('p1', 'Sam', client.send, 't1');

    world.handleWager('p1', 'x2', 100);

    expect(client.errors().at(-1)?.code).toBe('invalid_action');
  });

  it('debits a wager placed at a seated table', () => {
    const client = new FakeClient();
    world.addPlayer('p1', 'Sam', client.send, 't1');
    seatPlayerNear('p1', 1);
    world.handleInteract('p1', 1);
    tick();

    const before = world.balanceOf('p1');
    world.handleWager('p1', 'x2', 250);

    expect(world.balanceOf('p1')).toBe(before - 250);
  });

  it('refuses a wager the player cannot cover', () => {
    const client = new FakeClient();
    world.addPlayer('p1', 'Sam', client.send, 't1');
    seatPlayerNear('p1', 1);
    world.handleInteract('p1', 1);
    tick();

    const before = world.balanceOf('p1');
    world.handleWager('p1', 'x2', 999_999);

    expect(world.balanceOf('p1')).toBe(before);
    expect(client.errors().at(-1)?.code).toBeDefined();
  });

  it('refunds a live wager when the player stands up', () => {
    const client = new FakeClient();
    world.addPlayer('p1', 'Sam', client.send, 't1');
    seatPlayerNear('p1', 1);
    world.handleInteract('p1', 1);
    tick();

    const before = world.balanceOf('p1');
    world.handleWager('p1', 'x2', 200);
    world.handleLeaveTable('p1');

    expect(world.balanceOf('p1')).toBe(before);
    expect(world.getPlayer('p1')!.state.seatedAt).toBeNull();
  });

  it('refunds a live wager when the player disconnects', () => {
    const client = new FakeClient();
    world.addPlayer('p1', 'Sam', client.send, 't1');
    seatPlayerNear('p1', 1);
    world.handleInteract('p1', 1);
    tick();

    const before = world.balanceOf('p1');
    world.handleWager('p1', 'x2', 400);
    // Dropping mid-round must not cost the player their stake, and must not let
    // them dodge a bet either — bets lock before the wheel is seeded.
    world.disconnectPlayer('p1');

    expect(world.balanceOf('p1')).toBe(before);
  });

  it('plays a full round through to a payout event', () => {
    const client = new FakeClient();
    world.addPlayer('p1', 'Sam', client.send, 't1');
    seatPlayerNear('p1', 1);
    world.handleInteract('p1', 1);
    tick();

    world.handleWager('p1', 'x2', 100);

    // Run past the betting window and the resolve beat.
    for (let i = 0; i < 60; i += 1) {
      advance(1_000);
      tick();
    }

    const resolved = client.events('table:resolved');
    expect(resolved.length).toBeGreaterThan(0);
  });

  it('publishes a commitment to seated players before bets are placed', () => {
    const client = new FakeClient();
    world.addPlayer('p1', 'Sam', client.send, 't1');
    seatPlayerNear('p1', 1);
    world.handleInteract('p1', 1);
    tick(2);

    const states = client.events('table:state') as { state: { commitment: unknown } }[];
    expect(states.length).toBeGreaterThan(0);
    expect(states.at(-1)!.state.commitment).not.toBeNull();
  });
});

describe('WorldInstance chat', () => {
  it('delivers local chat to everyone on the floor', () => {
    const a = new FakeClient();
    const b = new FakeClient();
    world.addPlayer('p1', 'Sam', a.send, 't1');
    world.addPlayer('p2', 'Ada', b.send, 't2');

    world.handleChat('p1', 'local', 'hello floor');
    tick();

    expect(b.events('chat')).toContainEqual(
      expect.objectContaining({ from: 'Sam', text: 'hello floor' }),
    );
  });

  it('keeps table chat between the people at that table', () => {
    const a = new FakeClient();
    const b = new FakeClient();
    world.addPlayer('p1', 'Sam', a.send, 't1');
    world.addPlayer('p2', 'Ada', b.send, 't2');

    const seated = world.getPlayer('p1')!;
    const table = world.world.interactables[0]!;
    seated.state.x = table.x;
    seated.state.z = table.z + 1.5;
    world.handleInteract('p1', table.id);
    tick();
    b.clear();

    world.handleChat('p1', 'table', 'secret');
    tick();

    // Ada is standing, so she is not at Sam's table and must not hear it.
    expect(b.events('chat')).toHaveLength(0);
  });
});

describe('WorldInstance disconnection', () => {
  it('holds a disconnected player for the grace window, then removes them', () => {
    const client = new FakeClient();
    world.addPlayer('p1', 'Sam', client.send, 't1');
    tick();

    world.disconnectPlayer('p1');
    expect(world.getPlayer('p1')).toBeDefined();
    expect(world.playerCount).toBe(0);

    advance(200_000);
    tick();

    expect(world.getPlayer('p1')).toBeUndefined();
  });

  it('stops replicating to a disconnected client', () => {
    const client = new FakeClient();
    world.addPlayer('p1', 'Sam', client.send, 't1');
    tick();
    world.disconnectPlayer('p1');
    client.clear();

    tick(5);
    expect(client.messages).toHaveLength(0);
  });

  it('tells remaining players when someone is removed', () => {
    const a = new FakeClient();
    const b = new FakeClient();
    world.addPlayer('p1', 'Sam', a.send, 't1');
    world.addPlayer('p2', 'Ada', b.send, 't2');
    tick();
    b.clear();

    world.disconnectPlayer('p1');
    advance(200_000);
    tick();

    expect(b.events('player:left')).toContainEqual(expect.objectContaining({ name: 'Sam' }));
  });

  it('removes the departed entity from surviving clients', () => {
    const a = new FakeClient();
    const b = new FakeClient();
    const gone = world.addPlayer('p1', 'Sam', a.send, 't1');
    world.addPlayer('p2', 'Ada', b.send, 't2');
    tick();
    b.clear();

    world.disconnectPlayer('p1');
    tick();

    const removed = b.snapshots.flatMap((snapshot) => snapshot.removed);
    expect(removed).toContain(gone.entityId);
  });
});
