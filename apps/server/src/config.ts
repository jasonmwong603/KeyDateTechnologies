/** Server configuration, read once at boot from the environment. */

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Normalises a game slug into a URL base path.
 *
 * Accepts what someone would naturally set — `floor`, `/floor`, `/floor/` —
 * and returns either `/floor` or `''` for a root mount. Everything the server
 * exposes hangs off this, so getting it consistent in one place avoids a
 * double-slash bug in one route and a missing slash in another.
 */
export function normalizeBasePath(slug: string): string {
  const trimmed = slug.trim().replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '' : `/${trimmed}`;
}

/**
 * The path segment this game is served under, e.g. `the-floor` in
 * `play.keydate.ca/the-floor`.
 *
 * This is the knob to turn when the game is renamed. Nothing else in the
 * codebase hard-codes it: the client discovers its own base path from the
 * document, and the WebSocket endpoint is derived from the same value.
 */
const gameSlug = process.env.GAME_SLUG ?? 'the-floor';

export const config = {
  port: intFromEnv('PORT', 8080),
  host: process.env.HOST ?? '0.0.0.0',

  gameSlug,
  /** `/the-floor`, or `''` when serving from the root of a domain. */
  basePath: normalizeBasePath(process.env.BASE_PATH ?? gameSlug),

  /**
   * Slugs the game used to be served under, comma-separated.
   *
   * Renaming a game breaks every bookmark, shared link and — worse — every
   * already-installed app that had the old address compiled into it. Listing
   * the old slug here keeps those working: requests to it are redirected to
   * the current one, path and all.
   */
  legacySlugs: (process.env.LEGACY_SLUGS ?? '')
    .split(',')
    .map((entry) => normalizeBasePath(entry))
    .filter((entry) => entry !== ''),
  /** Shown on the join screen and in the browser tab. */
  gameTitle: process.env.GAME_TITLE ?? 'The Keydate Floor',

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
