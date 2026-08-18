import { baccarat } from './baccarat.js';
import { blackjack } from './blackjack.js';
import { highCardDuel } from './highCardDuel.js';
import { roulette } from './roulette.js';
import type { TableGameDefinition } from './types.js';
import { wheelOfFortune } from './wheelOfFortune.js';

/**
 * Every table game the world knows how to run.
 *
 * Adding a game means writing a rules module and adding it here — the server,
 * the world builder and the client all resolve games through this map and need
 * no changes. See `docs/adding-a-table-game.md`.
 *
 * Ordered as the floor reads: the three card-and-wheel games people came for,
 * then the two house oddities.
 */
const DEFINITIONS: TableGameDefinition[] = [
  blackjack,
  roulette,
  baccarat,
  wheelOfFortune,
  highCardDuel,
];

const BY_ID = new Map<string, TableGameDefinition>(
  DEFINITIONS.map((definition) => [definition.id, definition]),
);

export function getTableGame(id: string): TableGameDefinition | undefined {
  return BY_ID.get(id);
}

export function listTableGames(): readonly TableGameDefinition[] {
  return DEFINITIONS;
}
