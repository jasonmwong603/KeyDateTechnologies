import type { Rng } from '@keydate/netcode';
import { buildShoe, cardCode, deal, publicCard, type Card } from './cards.js';
import type { TableGameDefinition, TableResolution, Wager } from './types.js';

/**
 * Baccarat — punto banco.
 *
 * The game with no decisions in it. Two hands are dealt, Player and Banker, and
 * whether either draws a third card is fixed by a table of rules that has not
 * changed in a century. Nobody at the table chooses anything; they only choose
 * which hand to back. That is exactly why it belongs here alongside blackjack:
 * one game is all decision, the other is none, and the drawing rules below are
 * the whole of it.
 *
 * Two departures from a real pit, both deliberate:
 *
 *   - **Tie pays 9 to 1, not 8 to 1.** At 8 to 1 the tie bet returns 85.6%,
 *     which is a genuinely bad bet dressed up as an exciting one. At 9 to 1 it
 *     returns 95.2% and sits alongside everything else on the felt.
 *   - **The shoe is reshuffled every round.** Chips do not persist between
 *     sessions here, so a persistent shoe would buy nothing but the illusion
 *     that counting it means something.
 */

const SHOE_DECKS = 8;

/** Banker's 5% commission, as the fraction of a winning stake actually paid. */
export const BANKER_PAYOUT = 0.95;

/**
 * Baccarat's reading of a card: aces 1, faces and tens 0, everything else face
 * value. Nothing else in the codebase counts cards this way.
 */
export function cardPoints(card: Card): number {
  if (card.rank === 'A') return 1;
  if (card.rank === '10' || card.rank === 'J' || card.rank === 'Q' || card.rank === 'K') return 0;
  return Number(card.rank);
}

/** A hand's total, modulo ten. Baccarat has no bust; 7 + 8 is 5. */
export function handTotal(cards: readonly Card[]): number {
  return cards.reduce((sum, card) => sum + cardPoints(card), 0) % 10;
}

/**
 * The banker's third-card rule.
 *
 * Conditional on the *value* of the player's third card, which is the part
 * everybody gets wrong from memory. When the player stood pat, the banker
 * simply draws on 0–5, exactly as the player would have.
 */
export function bankerDraws(bankerTotal: number, playerThird: number | null): boolean {
  if (bankerTotal >= 7) return false;
  if (playerThird === null) return bankerTotal <= 5;

  switch (bankerTotal) {
    case 0:
    case 1:
    case 2:
      return true;
    case 3:
      return playerThird !== 8;
    case 4:
      return playerThird >= 2 && playerThird <= 7;
    case 5:
      return playerThird >= 4 && playerThird <= 7;
    case 6:
      return playerThird === 6 || playerThird === 7;
    default:
      return false;
  }
}

export interface BaccaratCoup {
  player: Card[];
  banker: Card[];
  playerTotal: number;
  bankerTotal: number;
  outcome: 'player' | 'banker' | 'tie';
  /** True when either hand held 8 or 9 on the first two cards. */
  natural: boolean;
}

/** Deals one coup off the top of a shoe, applying the drawing rules in order. */
export function dealCoup(shoe: readonly Card[]): BaccaratCoup {
  // Real tables alternate the deal — player, banker, player, banker — and
  // because the shoe order is committed to in advance, the order cards come off
  // it is part of what the seed determines. So it is done properly.
  const opening = deal(shoe, 0, 4);
  const player = [opening[0] as Card, opening[2] as Card];
  const banker = [opening[1] as Card, opening[3] as Card];
  let cursor = 4;

  const naturalPlayer = handTotal(player);
  const naturalBanker = handTotal(banker);
  const natural = naturalPlayer >= 8 || naturalBanker >= 8;

  if (!natural) {
    let playerThird: number | null = null;
    if (handTotal(player) <= 5) {
      const card = deal(shoe, cursor, 1)[0] as Card;
      cursor += 1;
      player.push(card);
      playerThird = cardPoints(card);
    }

    if (bankerDraws(handTotal(banker), playerThird)) {
      banker.push(deal(shoe, cursor, 1)[0] as Card);
      cursor += 1;
    }
  }

  const playerTotal = handTotal(player);
  const bankerTotal = handTotal(banker);

  return {
    player,
    banker,
    playerTotal,
    bankerTotal,
    outcome: playerTotal === bankerTotal ? 'tie' : playerTotal > bankerTotal ? 'player' : 'banker',
    natural,
  };
}

export const baccarat: TableGameDefinition = {
  id: 'baccarat',
  displayName: 'Baccarat',
  minPlayers: 1,
  maxPlayers: 6,
  minWager: 10,
  maxWager: 5_000,
  bettingWindowMs: 20_000,
  spots: [
    {
      id: 'player',
      label: 'Player',
      payout: 1,
      description: 'Punto. Even money. Wins slightly less often than the banker.',
    },
    {
      id: 'banker',
      label: 'Banker',
      payout: BANKER_PAYOUT,
      description: 'Banco. Wins more often, so it pays 0.95 to 1 — a 5% commission.',
    },
    {
      id: 'tie',
      label: 'Tie',
      payout: 9,
      description: 'Both hands equal. Pays 9 to 1. Player and banker bets push.',
    },
  ],

  resolve(wagers: readonly Wager[], rng: Rng): TableResolution {
    const shoe = buildShoe(SHOE_DECKS, rng);
    const coup = dealCoup(shoe);

    const credits = wagers.flatMap((wager) => {
      // A tie returns player and banker stakes untouched. Swallowing them would
      // roughly double the edge on both, and it is not how the game is played.
      if (coup.outcome === 'tie' && (wager.spotId === 'player' || wager.spotId === 'banker')) {
        return [{ playerId: wager.playerId, amount: wager.amount }];
      }
      if (wager.spotId !== coup.outcome) return [];

      if (wager.spotId === 'banker') {
        // Chips are integers, so the commission has to round somewhere. It
        // rounds against the player, as it does in a pit — rounding the other
        // way would make small banker bets marginally +EV and give anyone
        // paying attention a reason to flat-bet the minimum forever.
        return [
          {
            playerId: wager.playerId,
            amount: wager.amount + Math.floor(wager.amount * BANKER_PAYOUT),
          },
        ];
      }
      if (wager.spotId === 'tie') {
        return [{ playerId: wager.playerId, amount: wager.amount * 10 }];
      }
      return [{ playerId: wager.playerId, amount: wager.amount * 2 }];
    });

    const written = (cards: readonly Card[]): string => cards.map(cardCode).join(' ');
    const summary =
      coup.outcome === 'tie'
        ? `Tie on ${coup.playerTotal}. Player and banker bets push.`
        : `${coup.outcome === 'player' ? 'Player' : 'Banker'} wins, ${Math.max(coup.playerTotal, coup.bankerTotal)} over ${Math.min(coup.playerTotal, coup.bankerTotal)}.`;

    return {
      summary: coup.natural ? `${summary} Natural.` : summary,
      detail: {
        player: coup.player.map(publicCard),
        banker: coup.banker.map(publicCard),
        playerTotal: coup.playerTotal,
        bankerTotal: coup.bankerTotal,
        outcome: coup.outcome,
        natural: coup.natural,
        written: `Player ${written(coup.player)} · Banker ${written(coup.banker)}`,
      },
      credits,
    };
  },
};
