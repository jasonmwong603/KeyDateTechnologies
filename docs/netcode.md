# Netcode

Three techniques do all the work: **prediction** for yourself, **interpolation** for
everyone else, and **reconciliation** to settle the difference between what you guessed
and what actually happened.

## Why you cannot just draw what the server sends

At 80ms round-trip, waiting for the server to confirm a keypress before moving means
80ms of input lag on every step. It feels broken. So the client applies input
immediately against the shared simulation and draws the result — a _prediction_ of what
the server will confirm.

The rest of the netcode exists to handle prediction being wrong.

## Prediction and reconciliation

`packages/netcode/src/prediction.ts`.

Every input frame gets a sequence number and is kept until the server acknowledges it:

```ts
const seq = prediction.record(frame); // remember it
localState = stepPlayer(localState, frame, world, TICK_DT); // apply immediately
```

Each snapshot carries `ackedInput` — the highest sequence the server had consumed when
it produced that state. On arrival the client:

1. Discards every buffered input at or below `ackedInput` (already baked into the
   server's state; replaying them would double-apply the movement).
2. Snaps to the server's authoritative position.
3. Replays every remaining input on top.

```ts
const corrected = prediction.reconcile({
  authoritative,
  ackedSeq: snapshot.ackedInput,
  step: (state, frame) => stepPlayer(state, frame, world, TICK_DT),
});
```

If the prediction was right, the replay lands exactly where the client already was and
nothing visible happens. If it was wrong — blocked by a player who was not visible
locally, say — the correction is applied once, rather than the client and server
fighting over the position every tick.

This only works because `step` is _literally the same function_ the server runs. See
[architecture.md](architecture.md) on why the client has no bundler.

### The correction tolerance

```ts
if (seatChanged || needsCorrection(localState, corrected)) { ... }
```

Snapping on every floating-point disagreement would jitter the camera constantly, so
sub-5cm drift is left alone. The tolerance is a 3D distance, not a per-axis check —
0.04 on each of three axes is under the threshold individually but ~0.069 combined,
which a per-axis test would wrongly wave through.

Seating is exempt. It is a server decision the client cannot anticipate, so it is always
taken verbatim rather than treated as drift.

## Interpolation

`packages/netcode/src/interpolation.ts`.

Remote players arrive as discrete snapshots at 30Hz. Drawing them at the newest
snapshot makes them stutter and teleport whenever a packet is late.

Instead the client renders them ~100ms **in the past** and interpolates between the two
snapshots straddling that render time. The cost is that you see other players where
they were 100ms ago. The benefit is motion that stays smooth through jitter and dropped
packets. For a social casino floor that is obviously the right trade; for a shooter you
would add server-side lag compensation on top.

When the buffer runs dry, the entity **holds still** rather than extrapolating.
Extrapolation guesses, and a wrong guess walks an avatar into a wall and then snaps it
back — worse than a brief pause.

Out-of-order arrivals are spliced into place rather than dropped, since a late packet
may still be the older half of a valid interpolation pair.

## The two clocks

The client runs two loops, and conflating them is the classic mistake:

| Clock      | Rate                             | Job                                                       |
| ---------- | -------------------------------- | --------------------------------------------------------- |
| Simulation | Fixed 30Hz, locked to the server | Sample input, predict movement                            |
| Render     | As fast as the display allows    | Draw, interpolating between the last two simulated states |

If simulation ran per rendered frame, movement speed would depend on framerate and
prediction would immediately disagree with the server.

`FixedTimestep` converts variable elapsed wall-clock time into a whole number of ticks,
and exposes `alpha` — how far into the next tick we are — which the renderer uses to
interpolate the local player between `previousState` and `localState`. Without that,
motion is visibly stepped on any display faster than 30Hz.

It also caps ticks per call. A backgrounded tab that returns after a minute would
otherwise try to simulate 1800 ticks in one frame and lock up the browser — the "spiral
of death". Dropped time is discarded rather than banked.

## Delta encoding

`packages/netcode/src/delta.ts`. At 30Hz with a full room, sending every field of every
entity every tick is mostly retransmitting unchanged numbers. `diffEntity` returns only
changed fields, or `null` when nothing changed so the entity can be omitted entirely.

Position and angle comparisons use an epsilon so floating-point noise does not register
as a change.

## Seeded randomness

`Math.random()` is banned anywhere an outcome is decided. Outcomes must be reproducible
from a seed so a disputed spin can be replayed and verified — see the commit–reveal
section of the [README](../README.md).

`createRng` is mulberry32: its entire state is one 32-bit integer, so storing the seed
is enough to replay a round exactly.

Shuffles use Fisher–Yates driven by that RNG. Sorting with a random comparator is both
statistically biased and non-reproducible, which would quietly break the fairness proof.

## Testing netcode

The tricky parts are tested directly:

- Reconciliation lands exactly where the client predicted when the server agrees.
- Reconciliation applies the correction when it does not.
- Interpolation holds still instead of extrapolating past the newest sample.
- Interpolation stays sorted through out-of-order arrival.
- The shuffle distributes the top card evenly across 52,000 deals — a biased shuffle
  would be a subtle and exploitable house advantage.
