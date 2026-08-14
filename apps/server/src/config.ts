/** Server configuration, read once at boot from the environment. */

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: intFromEnv('PORT', 8080),
  host: process.env.HOST ?? '0.0.0.0',

  /** Players per world instance. Beyond this, joins are refused. */
  maxPlayersPerWorld: intFromEnv('MAX_PLAYERS_PER_WORLD', 32),

  /** Chips a new player starts with. */
  startingChips: intFromEnv('STARTING_CHIPS', 2_500),

  /**
   * Chips handed to a broke player so they can keep playing.
   *
   * These are virtual chips with no cash value and nothing to buy them with,
   * so there is no reason to make busting out a wall. See docs/responsible-play.md.
   */
  bailoutChips: intFromEnv('BAILOUT_CHIPS', 500),

  /** How long a disconnected player's avatar and chips are held for resume, in ms. */
  resumeGraceMs: intFromEnv('RESUME_GRACE_MS', 90_000),

  /** Drop a connection that has sent nothing at all for this long, in ms. */
  socketTimeoutMs: intFromEnv('SOCKET_TIMEOUT_MS', 30_000),

  /** Ceiling on messages per second from one socket before it is throttled. */
  maxMessagesPerSecond: intFromEnv('MAX_MESSAGES_PER_SECOND', 120),
} as const;
