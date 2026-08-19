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
/**
 * Parses the legacy slug list, dropping anything that is not actually legacy.
 *
 * A slug equal to the one currently being served would redirect to itself, and
 * the server would answer every request under it with an endless 301 loop —
 * every bookmark, every installed app, and the domain root, all dead at once
 * with the process still passing its health check.
 *
 * That is not hypothetical. `GAME_SLUG` was left at `the-floor` on the host
 * after the game was renamed, while the default legacy list still named
 * `the-floor`, and the site went down until this filter was added. A stale
 * environment variable should at worst leave the game reachable under its old
 * name; it must never take the whole site off the air.
 */
export function parseLegacySlugs(raw: string, basePath: string): string[] {
  const seen = new Set<string>();
  return raw
    .split(',')
    .map((entry) => normalizeBasePath(entry))
    .filter((entry) => {
      if (entry === '' || entry === basePath || seen.has(entry)) return false;
      seen.add(entry);
      return true;
    });
}

const gameSlug = process.env.GAME_SLUG ?? 'beer-bets';
const basePath = normalizeBasePath(process.env.BASE_PATH ?? gameSlug);

export const config = {
  port: intFromEnv('PORT', 8080),
  host: process.env.HOST ?? '0.0.0.0',

  gameSlug,
  /** `/beer-bets`, or `''` when serving from the root of a domain. */
  basePath,

  /**
   * Slugs the game used to be served under, comma-separated.
   *
   * Renaming a game breaks every bookmark, shared link and — worse — every
   * already-installed app that had the old address compiled into it. Listing
   * the old slug here keeps those working: requests to it are redirected to
   * the current one, path and all.
   */
  legacySlugs: parseLegacySlugs(process.env.LEGACY_SLUGS ?? 'the-floor', basePath),
  /** Shown on the join screen and in the browser tab. */
  gameTitle: process.env.GAME_TITLE ?? 'Beer Bets',

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
