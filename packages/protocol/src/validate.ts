import { PROTOCOL_VERSION, type ClientMessage, type InputFrame } from './messages.js';

/**
 * Hand-rolled validation of untrusted client frames.
 *
 * Everything arriving on a socket is hostile until proven otherwise: a modified
 * client can send any JSON at all. These guards run before a message reaches the
 * simulation, so the simulation itself can assume well-formed, in-range input.
 */

export const MAX_INPUT_FRAMES_PER_MESSAGE = 16;
export const MAX_DISPLAY_NAME_LENGTH = 20;
export const MAX_CHAT_LENGTH = 200;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Clamps to [-1, 1] and scrubs NaN, so a hacked client cannot inject huge axes. */
function clampAxis(value: unknown): number {
  if (!isFiniteNumber(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

/** Wraps an angle into [-PI, PI]. */
export function wrapAngle(radians: number): number {
  const twoPi = Math.PI * 2;
  const wrapped = (((radians + Math.PI) % twoPi) + twoPi) % twoPi;
  return wrapped - Math.PI;
}

function parseInputFrame(raw: unknown): InputFrame | null {
  if (!isObject(raw)) return null;
  if (!isFiniteNumber(raw.seq) || raw.seq < 0) return null;

  const pitch = isFiniteNumber(raw.pitch) ? raw.pitch : 0;
  return {
    seq: Math.floor(raw.seq),
    moveX: clampAxis(raw.moveX),
    moveZ: clampAxis(raw.moveZ),
    yaw: wrapAngle(isFiniteNumber(raw.yaw) ? raw.yaw : 0),
    // Looking further than straight up or down is meaningless; clamp rather
    // than reject so ordinary clients are never disconnected over rounding.
    pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch)),
    buttons: isFiniteNumber(raw.buttons) ? Math.floor(raw.buttons) & 0xff : 0,
  };
}

/**
 * C0/C1 control characters, zero-width joiners, and the bidirectional
 * override family. These render as nothing (or as reversed text) on other
 * players' screens, which makes them the standard tool for impersonating
 * another player's name in a chat log.
 */
function isUnsafeCodePoint(code: number): boolean {
  return (
    code <= 0x1f || // C0 controls
    (code >= 0x7f && code <= 0x9f) || // DEL and C1 controls
    (code >= 0x200b && code <= 0x200f) || // zero-width + LTR/RTL marks
    (code >= 0x2028 && code <= 0x202e) || // line/paragraph separators + bidi overrides
    (code >= 0x2066 && code <= 0x2069) || // bidi isolates
    code === 0xfeff // zero-width no-break space
  );
}

function stripUnsafeChars(value: string): string {
  let out = '';
  for (const char of value) {
    if (!isUnsafeCodePoint(char.codePointAt(0) ?? 0)) out += char;
  }
  return out;
}

/**
 * Sanitizes a display name into something safe to render on every other
 * player's screen. Returns null when nothing printable survives.
 */
export function sanitizeDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = stripUnsafeChars(raw)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

export function sanitizeChat(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = stripUnsafeChars(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_CHAT_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Parses a raw socket payload into a `ClientMessage`, or returns null.
 *
 * Returning null (rather than throwing) keeps the socket handler branchless:
 * a null is answered with a `bad_message` error and the connection survives.
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isObject(raw) || typeof raw.type !== 'string') return null;

  switch (raw.type) {
    case 'hello': {
      if (raw.protocolVersion !== PROTOCOL_VERSION) return null;
      const displayName = sanitizeDisplayName(raw.displayName);
      if (displayName === null) return null;
      const message: ClientMessage = {
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        displayName,
      };
      if (typeof raw.sessionCode === 'string') message.sessionCode = raw.sessionCode;
      if (typeof raw.resumeToken === 'string') message.resumeToken = raw.resumeToken;
      return message;
    }

    case 'input': {
      if (!Array.isArray(raw.frames) || raw.frames.length === 0) return null;
      // Cap the batch so a client cannot force unbounded replay work per message.
      const frames: InputFrame[] = [];
      for (const candidate of raw.frames.slice(0, MAX_INPUT_FRAMES_PER_MESSAGE)) {
        const frame = parseInputFrame(candidate);
        if (frame === null) return null;
        frames.push(frame);
      }
      return { type: 'input', frames };
    }

    case 'interact': {
      if (!isFiniteNumber(raw.entityId)) return null;
      return { type: 'interact', entityId: Math.floor(raw.entityId) };
    }

    case 'table:leave':
      return { type: 'table:leave' };

    case 'table:wager': {
      if (typeof raw.spotId !== 'string' || raw.spotId.length > 32) return null;
      if (!isFiniteNumber(raw.amount)) return null;
      const amount = Math.floor(raw.amount);
      // The balance check belongs to the table; here we only reject nonsense.
      if (amount <= 0) return null;
      return { type: 'table:wager', spotId: raw.spotId, amount };
    }

    case 'table:action': {
      if (typeof raw.actionId !== 'string' || raw.actionId.length > 32) return null;
      // Whether the action is legal, and whether it is even this player's turn,
      // is the table's business. This layer only rejects nonsense shapes.
      return { type: 'table:action', actionId: raw.actionId };
    }

    case 'bar:buy': {
      if (typeof raw.drinkId !== 'string' || raw.drinkId.length > 32) return null;
      // Whether the drink exists, and whether it can be afforded, is the
      // server's business — this layer only rejects nonsense shapes.
      return { type: 'bar:buy', drinkId: raw.drinkId };
    }

    case 'table:clear':
      return { type: 'table:clear' };

    case 'table:ready':
      return { type: 'table:ready', ready: raw.ready === true };

    case 'chat': {
      const text = sanitizeChat(raw.text);
      if (text === null) return null;
      const channel = raw.channel === 'table' ? 'table' : 'local';
      return { type: 'chat', channel, text };
    }

    case 'view-mode': {
      const mode = raw.mode === 'first-person' ? 'first-person' : 'third-person';
      return { type: 'view-mode', mode };
    }

    case 'ping': {
      if (!isFiniteNumber(raw.clientTime)) return null;
      return { type: 'ping', clientTime: raw.clientTime };
    }

    default:
      return null;
  }
}
