import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from './messages.js';
import {
  MAX_INPUT_FRAMES_PER_MESSAGE,
  parseClientMessage,
  sanitizeChat,
  sanitizeDisplayName,
  wrapAngle,
} from './validate.js';

/**
 * These tests are written from the attacker's side: every case is something a
 * modified client can actually send. The simulation trusts whatever gets past
 * this layer, so anything that slips through here is a live exploit.
 */

describe('parseClientMessage', () => {
  it('rejects non-objects and unknown types', () => {
    expect(parseClientMessage(null)).toBeNull();
    expect(parseClientMessage('hello')).toBeNull();
    expect(parseClientMessage([])).toBeNull();
    expect(parseClientMessage({ type: 'drop-table' })).toBeNull();
    expect(parseClientMessage({})).toBeNull();
  });

  it('rejects a hello from a mismatched protocol version', () => {
    expect(
      parseClientMessage({ type: 'hello', protocolVersion: 999, displayName: 'Sam' }),
    ).toBeNull();
  });

  it('accepts a well-formed hello', () => {
    const parsed = parseClientMessage({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      displayName: 'Sam',
      sessionCode: 'ABCDE',
    });
    expect(parsed).toEqual({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      displayName: 'Sam',
      sessionCode: 'ABCDE',
    });
  });

  it('clamps movement axes into range', () => {
    const parsed = parseClientMessage({
      type: 'input',
      // A speed hack: claim a movement axis far outside its legal range.
      frames: [{ seq: 1, moveX: 5000, moveZ: -5000, yaw: 0, pitch: 0, buttons: 0 }],
    });
    expect(parsed).toMatchObject({ type: 'input' });
    const frame = (parsed as { frames: { moveX: number; moveZ: number }[] }).frames[0];
    expect(frame.moveX).toBe(1);
    expect(frame.moveZ).toBe(-1);
  });

  it('scrubs NaN and Infinity out of movement axes', () => {
    const parsed = parseClientMessage({
      type: 'input',
      frames: [{ seq: 1, moveX: Number.NaN, moveZ: Number.POSITIVE_INFINITY, buttons: 0 }],
    });
    const frame = (parsed as { frames: { moveX: number; moveZ: number }[] }).frames[0];
    // NaN would poison the player's position irrecoverably on the first tick.
    expect(frame.moveX).toBe(0);
    expect(frame.moveZ).toBe(0);
  });

  it('clamps pitch to straight up and straight down', () => {
    const parsed = parseClientMessage({
      type: 'input',
      frames: [{ seq: 1, pitch: 99, buttons: 0 }],
    });
    const frame = (parsed as { frames: { pitch: number }[] }).frames[0];
    expect(frame.pitch).toBeCloseTo(Math.PI / 2, 6);
  });

  it('caps how many input frames one message can carry', () => {
    const frames = Array.from({ length: 500 }, (_, index) => ({ seq: index + 1, buttons: 0 }));
    const parsed = parseClientMessage({ type: 'input', frames });
    // Otherwise one message forces an unbounded amount of replay work.
    expect((parsed as { frames: unknown[] }).frames).toHaveLength(MAX_INPUT_FRAMES_PER_MESSAGE);
  });

  it('rejects input with a negative or missing sequence number', () => {
    expect(parseClientMessage({ type: 'input', frames: [{ seq: -1 }] })).toBeNull();
    expect(parseClientMessage({ type: 'input', frames: [{ buttons: 0 }] })).toBeNull();
    expect(parseClientMessage({ type: 'input', frames: [] })).toBeNull();
  });

  it('masks the button field to a single byte', () => {
    const parsed = parseClientMessage({
      type: 'input',
      frames: [{ seq: 1, buttons: 0xffffffff }],
    });
    const frame = (parsed as { frames: { buttons: number }[] }).frames[0];
    expect(frame.buttons).toBe(0xff);
  });

  it('rejects wagers that are zero, negative or non-numeric', () => {
    expect(parseClientMessage({ type: 'table:wager', spotId: 'x2', amount: 0 })).toBeNull();
    // A negative wager would credit the player instead of debiting them.
    expect(parseClientMessage({ type: 'table:wager', spotId: 'x2', amount: -500 })).toBeNull();
    expect(parseClientMessage({ type: 'table:wager', spotId: 'x2', amount: 'lots' })).toBeNull();
  });

  it('floors fractional wagers', () => {
    expect(parseClientMessage({ type: 'table:wager', spotId: 'x2', amount: 10.9 })).toEqual({
      type: 'table:wager',
      spotId: 'x2',
      amount: 10,
    });
  });

  it('rejects an over-long spot id', () => {
    expect(
      parseClientMessage({ type: 'table:wager', spotId: 'x'.repeat(100), amount: 10 }),
    ).toBeNull();
  });

  it('accepts a bare deal call', () => {
    expect(parseClientMessage({ type: 'table:deal' })).toEqual({ type: 'table:deal' });
  });

  it('ignores anything a client tries to attach to a deal call', () => {
    // It carries no payload on purpose: which table, and whether this player
    // has chips down, are the server's to know. Extra fields are dropped rather
    // than rejected, so a future client sending more cannot break an old server.
    expect(
      parseClientMessage({ type: 'table:deal', tableId: 7, playerId: 'someone-else' }),
    ).toEqual({ type: 'table:deal' });
  });

  it('accepts a table action and carries the id through untouched', () => {
    expect(parseClientMessage({ type: 'table:action', actionId: 'hit' })).toEqual({
      type: 'table:action',
      actionId: 'hit',
    });
  });

  it('rejects a table action with no id, or one that is not a string', () => {
    expect(parseClientMessage({ type: 'table:action' })).toBeNull();
    expect(parseClientMessage({ type: 'table:action', actionId: 7 })).toBeNull();
    expect(parseClientMessage({ type: 'table:action', actionId: null })).toBeNull();
    expect(parseClientMessage({ type: 'table:action', actionId: ['hit'] })).toBeNull();
    expect(parseClientMessage({ type: 'table:action', actionId: { id: 'hit' } })).toBeNull();
  });

  it('rejects an over-long action id', () => {
    // Bounded before it reaches the table, so a client cannot make the server
    // hold megabytes of string per message.
    expect(parseClientMessage({ type: 'table:action', actionId: 'h'.repeat(33) })).toBeNull();
  });

  it('passes a hostile action id through as an ordinary string', () => {
    // This layer does not judge meaning — the table rejects anything it did not
    // offer. What matters is that nothing here treats the id as a key or a
    // path, so a prototype-polluting name arrives as inert text.
    const parsed = parseClientMessage({ type: 'table:action', actionId: '__proto__' });
    expect(parsed).toEqual({ type: 'table:action', actionId: '__proto__' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('defaults an unknown chat channel to local rather than failing', () => {
    expect(parseClientMessage({ type: 'chat', channel: 'admin', text: 'hi' })).toEqual({
      type: 'chat',
      channel: 'local',
      text: 'hi',
    });
  });
});

describe('sanitizeDisplayName', () => {
  it('trims and collapses whitespace', () => {
    expect(sanitizeDisplayName('   Sam   Vimes  ')).toBe('Sam Vimes');
  });

  it('truncates to the maximum length', () => {
    expect(sanitizeDisplayName('x'.repeat(200))).toHaveLength(20);
  });

  it('strips zero-width and bidi characters used for impersonation', () => {
    // Without this, a player can render a name that reads as someone else's.
    expect(sanitizeDisplayName('Sa\u200Bm\u202E')).toBe('Sam');
  });

  it('strips control characters', () => {
    expect(sanitizeDisplayName('Sam\u0000\u001B[31m')).toBe('Sam[31m');
  });

  it('rejects a name with nothing printable left', () => {
    expect(sanitizeDisplayName('\u200B\uFEFF')).toBeNull();
    expect(sanitizeDisplayName('   ')).toBeNull();
    expect(sanitizeDisplayName(42)).toBeNull();
  });
});

describe('sanitizeChat', () => {
  it('truncates long messages', () => {
    expect(sanitizeChat('a'.repeat(5000))).toHaveLength(200);
  });

  it('rejects empty messages', () => {
    expect(sanitizeChat('   ')).toBeNull();
  });
});

/** True when two angles name the same direction. */
function sameDirection(a: number, b: number): boolean {
  const difference = Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  return difference < 1e-9;
}

describe('wrapAngle', () => {
  it('leaves an already-wrapped angle alone', () => {
    expect(wrapAngle(0.5)).toBeCloseTo(0.5, 6);
    expect(wrapAngle(-0.5)).toBeCloseTo(-0.5, 6);
  });

  it('wraps a spun-round angle to the equivalent direction', () => {
    // 3*PI and PI name the same direction; which representative comes back
    // (+PI or -PI) is not something callers should depend on.
    expect(sameDirection(wrapAngle(Math.PI * 3), Math.PI)).toBe(true);
    expect(sameDirection(wrapAngle(-Math.PI * 3), Math.PI)).toBe(true);
    expect(sameDirection(wrapAngle(Math.PI * 2 + 0.5), 0.5)).toBe(true);
  });

  it('returns an angle inside [-PI, PI] for any input', () => {
    for (const angle of [0, 7, -7, 1000, -1000, Math.PI * 3]) {
      const wrapped = wrapAngle(angle);
      expect(wrapped).toBeGreaterThanOrEqual(-Math.PI);
      expect(wrapped).toBeLessThanOrEqual(Math.PI);
    }
  });

  it('keeps very large angles in range', () => {
    const wrapped = wrapAngle(1000);
    expect(wrapped).toBeGreaterThanOrEqual(-Math.PI);
    expect(wrapped).toBeLessThanOrEqual(Math.PI);
  });
});
