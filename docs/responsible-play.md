# Responsible play — design rules

This game is about gambling with friends. That theme is the point, and these rules exist
so it stays a game.

## The hard lines

**No real money, in either direction.**

- Chips cannot be purchased. There is no store, no IAP, no currency pack, no ad-for-chips.
- Chips cannot be cashed out, traded for anything of value, or moved between accounts.
- No loot boxes, no paid cosmetics tied to wagering, no "buy your way back in".

Chips exist to make the outcome of a hand _matter between the people at the table_ for
the length of the evening. The moment a chip is worth a cent, this stops being a party
game and becomes a regulated product in most of the world.

**Busting out is not a wall.** A player at exactly zero chips is topped back up
(`BAILOUT_CHIPS`, default 500). There is nothing to sell them and no reason to punish
them — a friend who is out of chips should be able to keep playing with everyone else,
not sit and watch.

The grant fires only at _exactly_ zero, so it cannot be farmed by betting down to a
single chip and cashing repeated top-ups.

## Where this shows up in the code

| Rule                               | Enforced by                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| Chips have no purchase path        | There is no code to add one; `ChipLedger` only credits from named in-game reasons |
| Balances cannot go negative        | `ChipLedger.debit` refuses partial debits                                         |
| Broke players keep playing         | `ChipLedger.bailout`, called after every table resolution                         |
| Outcomes are not rigged            | Commit–reveal, verified client-side; see the README                               |
| House edge stays mild              | 4–7%, with one spot at true odds; asserted by a 200k-spin test                    |
| A dropped connection costs nothing | Resume tokens; live wagers refunded on disconnect                                 |

## Things to keep out

Mechanics that are standard in real-money gambling products and deliberately absent here:

- **Losses disguised as wins** — a payout smaller than the stake, presented with the
  same celebration as a win.
- **Near-miss animation** — stopping the wheel one segment short of the jackpot more
  often than chance would. The wheel is seeded before bets are placed precisely so this
  is impossible.
- **Session-length pressure** — daily streaks, expiring bonuses, "one more round and
  your multiplier resets".
- **Loss chasing prompts** — offering a bigger stake immediately after a loss.

If a future feature request sounds like one of these, it belongs in this list rather
than in the game.

## Fairness is a feature, not a claim

The commit–reveal transcript is shown in the table panel and verified in the client. A
player who does not trust the server can check every round themselves, and a mismatch is
reported in red rather than swallowed.

**Before shipping to anyone outside a friends group**, replace the digest in
`packages/netcode/src/commitment.ts` with SHA-256. The current iterated FNV-1a gives a
genuine protocol and a verifiable transcript, but it is not collision-resistant, so the
guarantee it offers is weaker than the UI implies. The signature does not change.

## If the design ever changes

Adding real-money anything — purchases, cash-out, tradeable chips, or wagering against
another product's currency — changes what this software is. It would need legal review,
age verification, jurisdictional licensing, and self-exclusion tooling before a line of
it is written.

That is a product decision, not an engineering one. Nothing in this repository should
quietly move in that direction.
