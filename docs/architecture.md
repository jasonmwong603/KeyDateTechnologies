# Architecture

## The one rule

**The server is authoritative.** Clients send inputs and intents. They never send state.

Anything a client asserts about where it is, how many chips it holds, or how a wager
turned out is discarded. This is not paranoia about a hypothetical cheater — in a game
where chips change hands between friends, a client that can assert its own balance is a
game with no stakes at all.

Everything else in this document follows from that rule.

## The tick loop

The world advances in fixed 30Hz steps. `apps/server/src/index.ts` owns the master
timer, and it deliberately does **not** trust `setInterval` to fire on time:

```ts
accumulator += now - lastTickAt;
while (accumulator >= tickIntervalMs && ticks < MAX_CATCHUP_TICKS) {
  accumulator -= tickIntervalMs;
  registry.update();
}
```

`setInterval` drifts, and under load it drifts consistently in one direction. Without
accumulating real elapsed time, the simulation slowly falls behind the wall clock and
every client's prediction ends up running ahead of the server — which presents as
constant rubber-banding that gets worse the longer the server has been up.

`MAX_CATCHUP_TICKS` bounds the other failure: after a long GC pause or a suspended
process, the accumulator holds a huge backlog, and running it all in one pass freezes
the server for as long as it takes to simulate. Dropping the excess is the right
trade — a stalled server should resume in the present, not replay the past.

One `WorldInstance.update()` does, in order:

1. **Simulate players.** One input frame per player per tick — never more.
2. **Update tables.** Phase transitions, betting timers, resolution, payouts.
3. **Expire disconnections.** Remove players past their resume grace window.
4. **Replicate.** Build one snapshot per client and send it.

### One input frame per tick

`simulatePlayers()` consumes exactly one queued frame per player per tick, and the
queue is capped:

```ts
const frame = record.inputQueue.shift();
```

If a client batches ten input frames into one message, draining the queue in a single
tick would give it ten ticks of movement — the classic speed hack. Instead the backlog
drains at one frame per tick, so a client that floods input gains nothing.

The other half of that guard is in `queueInput()`, which drops any frame whose sequence
number is not strictly greater than the highest seen. Duplicated and reordered packets
are routine on a real network; replaying one would apply a movement twice.

When no frame is available — packet loss, or a genuinely idle player — the simulation
still runs with a neutral input carrying the last known facing. It must never simply
skip the player, because gravity has to keep applying. A player who disconnects
mid-jump should land, not hang in the air.

## Replication

Each client gets a delta-encoded snapshot per tick, computed against **that client's
own** baseline:

- The first snapshot on a connection is a keyframe (`baseTick: null`).
- Every later snapshot carries only fields that changed, plus the entity id.
- An entity that did not change at all is omitted entirely, so an idle player at a
  table costs nothing per tick.
- A resumed client is forcibly given a fresh keyframe, because it no longer holds a
  usable baseline.

Position comparisons use an epsilon (`packages/netcode/src/delta.ts`), so sub-millimetre
floating-point noise does not count as "changed".

Chip balances are replicated publicly, on purpose. Seeing who is up and who is
desperate is most of the point of playing with friends.

### What is not built

Every client currently receives every other client. That is correct for 32 players in
one room and wrong for 500 across several. Interest management — only replicating what
a player could plausibly perceive — is the next thing to build here, and the snapshot
format already supports it: `removed` exists precisely so an entity can leave a
client's interest set without being deleted from the world.

## Where the boundaries are

| Concern                          | Lives in           | Why there                                                                                                                |
| -------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Parsing, rate limiting, identity | `Gateway`          | Everything security-relevant about an inbound message happens in one place, so the world never sees an unvalidated frame |
| Tick loop, replication, interest | `WorldInstance`    | Holds no global state, so a session code maps to one instance and extra shards are just extra instances                  |
| Chip balances                    | `ChipLedger`       | One writer means "balances never go negative" is enforced once, not re-checked at every call site                        |
| Betting windows, commit–reveal   | `TableRuntime`     | The phase machine and the fairness transcript are the same concern                                                       |
| Game rules                       | `packages/games/*` | Pure functions of (wagers, rng), which is what makes an outcome replayable                                               |
| Movement, collision              | `packages/sim`     | Shared with the client verbatim                                                                                          |

`WorldInstance` knows nothing about sockets — callers supply a `send` function per
player. That is what lets the entire world be tested without a network, which
`apps/server/src/worldInstance.test.ts` does.

## Chips

`ChipLedger` is the only thing that writes a balance. It refuses partial debits: a
half-placed wager has no meaning, so a debit either moves the whole amount or nothing.

`TableRuntime` never touches balances directly — it asks its host to debit and reports
credits back. That indirection is why the same table code can be unit-tested against a
fake ledger with a fake clock.

A player at exactly zero chips is topped up (`bailout`). The grant only fires at
_exactly_ zero, so it cannot be farmed by repeatedly betting down to one chip. These
are virtual chips that cannot be bought, so there is no reason to make busting out a
wall — see [responsible-play.md](responsible-play.md).

## Sessions

A session code maps to one `WorldInstance`. Joining an unrecognised but well-formed code
**creates** that world rather than failing, which is how "make up a code and tell your
friends" works with no separate create step. Empty private worlds are collected; the
public world is never collected.

Codes use a 24-letter alphabet with `I`, `O` and all digits removed, because they get
read aloud over voice chat and typed on phones. `normalizeSessionCode` folds the
predictable mishearings (`0`→`O`→`Q`, `1`→`I`→`J`) back onto legal letters.

## Disconnection

A dropped socket does not immediately destroy a player. Their avatar and chips are held
for `RESUME_GRACE_MS`, and a `resumeToken` reclaims them. A flaky mobile connection
should not cost someone their stack.

On disconnect the player is also stood up from any table, which refunds live wagers.
That is not a way to dodge a losing bet: bets lock before the wheel is seeded, so by the
time an outcome exists there is nothing left to dodge.
