# Wire protocol

Version 1. JSON over WebSocket at `/ws`.

JSON is the current encoding because it is debuggable and the message volume is small.
The message shapes in `packages/protocol/src/messages.ts` are deliberately
binary-friendly — flat objects, numeric flags rather than string enums, short field
names on hot messages — so moving snapshots to a binary encoding later does not require
redesigning the protocol.

`PROTOCOL_VERSION` is checked on `hello`. A mismatch is rejected outright rather than
tolerated: a client running last week's simulation constants will desync in ways that
look like a netcode bug.

## Client → Server

| Message        | Purpose                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------- |
| `hello`        | First message on a socket. Carries display name, optional session code, optional resume token |
| `input`        | A batch of input frames. The only way to move                                                 |
| `interact`     | Use whatever you are standing at — a table seat                                               |
| `table:leave`  | Stand up                                                                                      |
| `table:wager`  | Stake chips on a betting spot                                                                 |
| `table:clear`  | Pull your chips back while betting is open                                                    |
| `table:ready`  | Declare readiness so the table can resolve early                                              |
| `table:action` | Take your turn at a table that has one — `hit`, `stand`, `double`                             |
| `chat`         | `local` (whole floor) or `table` (your table only)                                            |
| `view-mode`    | Cosmetic; which camera you are using                                                          |
| `ping`         | Latency and clock-offset probe                                                                |

### Input frames

```ts
{
  (seq, moveX, moveZ, yaw, pitch, buttons);
}
```

`seq` is monotonic per connection and is what reconciliation hangs off. `moveX`/`moveZ`
are axes in `[-1, 1]`, not velocities. `yaw` is needed server-side because it determines
movement direction; `pitch` is look-only and is replicated so others can see where you
are looking.

`buttons` is a bitmask (`INPUT_BUTTON_JUMP`, `_SPRINT`, `_INTERACT`, `_CROUCH`).

Frames are batched — at 30Hz, one packet per frame is 30 tiny packets per second per
client. Coalescing three costs a couple of milliseconds and cuts packet overhead
sharply.

## Server → Client

| Message    | Purpose                                                              |
| ---------- | -------------------------------------------------------------------- |
| `welcome`  | Identity, resume token, tick rate, and the static world              |
| `snapshot` | Delta-encoded authoritative state for one tick                       |
| `events`   | Discrete things that happened, delivered once rather than replicated |
| `pong`     | Latency response                                                     |
| `error`    | Typed rejection; never fatal to the connection                       |

### Snapshots

```ts
{
  (tick, baseTick, ackedInput, entities, removed);
}
```

`baseTick` is the tick this delta is encoded against, or `null` for a keyframe. A client
that no longer holds `baseTick` discards the snapshot and waits for the next keyframe.

`ackedInput` is the highest input sequence the server consumed for this client. It is
the single most important field in the protocol — everything about prediction depends
on it.

`entities` carries only changed fields. Absent field means unchanged. An entity absent
entirely means nothing about it changed. `removed` lists entities that left this
client's interest set.

### Events

Events are for things that _happen_, as opposed to state that _is_: `table:seated`,
`table:state`, `table:resolved`, `chips:changed`, `chat`, `player:joined`,
`player:left`. They are queued per client and flushed with each tick's snapshot.

Table state is pushed at ~5Hz to seated players, but phase changes push immediately —
betting opening, bets locking, and the turn passing to you are the moments the UI must
not miss.

### Table state

`table:state` carries everything the client needs to draw the felt without knowing which
game it is: `displayName`, the full `spots` list, `minWager`, `maxWager`,
`bettingWindowMs`, the seats, the wagers, the commitment, and the last result. Adding a
game does not mean editing the client.

The `phase` runs `idle → betting → [decisions] → resolving → payout`. `decisions` is
entered only by games that have a per-player turn — blackjack, so far — and when it is
active a `decision` block rides along:

```ts
{
  actor: string | null,        // whose turn; everyone sees it, only they may act
  actions: { id, label, hint }[],
  msRemaining: number,         // before the table decides for them
  view: Record<string, unknown> // the hand, as everyone may see it
}
```

`view` is produced by the rules module, never dumped from its state — the rest of the
shoe and the dealer's hole card are in that state, and neither goes out until the hand is
over.

`lastResult` carries the revealed seed **and the round's action log**. A one-shot round is
reproducible from its seed alone; an interactive one is reproducible from (seed, actions),
because the seed fixes the shoe and the log fixes what was done with it. See
`replayInteractiveRound` in `packages/games/table-games`.

## Validation

`parseClientMessage` runs before anything reaches the simulation, so the simulation can
assume well-formed, in-range input. Everything arriving on a socket is treated as
hostile: a modified client can send any JSON at all.

It **returns null rather than throwing**, so the socket handler stays branchless — a
null is answered with `bad_message` and the connection survives. Disconnecting on a
malformed frame would let one bad packet drop a legitimate player.

What it enforces:

| Guard                                                          | Attack it stops                                        |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| Axes clamped to `[-1, 1]`                                      | Claiming a movement axis of 5000 to fly across the map |
| `NaN`/`Infinity` scrubbed to 0                                 | Poisoning a position irrecoverably on the first tick   |
| Pitch clamped to ±π/2                                          | Nonsensical look angles                                |
| Buttons masked to one byte                                     | Setting flags that do not exist                        |
| ≤16 input frames per message                                   | Forcing unbounded replay work with one packet          |
| Wagers must be positive integers                               | A negative wager crediting instead of debiting         |
| Spot ids ≤32 chars                                             | Unbounded string handling                              |
| Names/chat stripped of control, zero-width and bidi characters | Rendering a name that reads as another player's        |
| Unknown chat channel defaults to `local`                       | — (fails safe rather than rejecting)                   |

Range and ownership checks that need world state — is this player seated, can they cover
this wager, are they close enough to that table — live in `WorldInstance` and
`TableRuntime`, not here.

## Error codes

`bad_message`, `protocol_mismatch`, `session_not_found`, `world_full`, `name_rejected`,
`not_authorized`, `invalid_action`, `insufficient_chips`, `table_locked`, `rate_limited`.

An error never closes the socket. The client surfaces them in the chat log.

## Rate limiting

A sliding window per socket, defaulting to 120 messages/second — well above the expected
30Hz input plus pings and table actions, so it only catches genuine flooding rather than
a client on a bad connection catching up.
