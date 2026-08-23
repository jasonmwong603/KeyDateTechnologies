# Roadmap

Ordered by what unblocks the most, not by what is most fun to build.

## Working today

Authoritative 30Hz simulation · client prediction and reconciliation · entity
interpolation · delta-compressed snapshots · first and third person cameras · desktop
and touch input · six half-circle tables across five games, seats and bets visible on the
felt · blackjack with real hit/stand/double decisions and up to three boxes a player ·
cards dealt in 3D out of the shoe · commit–reveal fairness verified
client-side · chip ledger with bailouts · resume after disconnect · local and table chat
· private worlds by session code · landscape-only on phones.

## Next

**SHA-256 commitments.** The current digest is an iterated FNV-1a. It gives a real
protocol and a verifiable transcript, but it is not collision-resistant. `node:crypto`
on the server, WebCrypto in the browser; the signature in `commitment.ts` does not
change. This blocks letting anyone outside a friends group play.

**Persistence.** A world's chips live in memory and vanish when it empties. Players
expect their stack to survive a session. Needs an identity that outlives a resume token,
which is a bigger decision than it sounds — accounts imply a login, and a login implies
everything that comes with holding user data.

**Interest management.** Every client currently replicates every other client. Correct
for 32 players in one room, wrong for 500 across several. The snapshot format already
supports it — `removed` exists so an entity can leave a client's interest set without
leaving the world.

## After that

**Binary snapshot encoding.** JSON is roughly 4× the bytes it needs to be. Worth doing
once player counts justify it, not before — the message shapes in `protocol` are already
laid out to make the swap mechanical.

**A second room.** The world is one floor because zone handoff is only worth building
when there is somewhere to hand off to. A second space turns `SessionRegistry` from a
map into something that has to move players between instances.

**Server-side lag compensation.** Not needed for a casino floor, where nothing is
aim-dependent. It becomes necessary the moment any interaction is timing-critical.

**More games.** The registry pattern means a new one touches three files — see
[adding-a-table-game.md](adding-a-table-game.md). Blackjack, roulette and baccarat are
built; blackjack brought the `decisions` phase with it, so a game needing per-player
sequential choices no longer needs a new phase machine, only an `InteractiveTableGame`.

**Splitting in blackjack.** Still left out, though the ground under it has shifted:
playing several _boxes_ is supported now, so the turn order, the action panel and the wire
state all handle one player holding three hands at once. What splitting still needs is the
part boxes do not have — reacting to a pair _after_ it is dealt, which means creating a
hand mid-round and taking chips for it at that moment. Insurance and surrender are the
same shape of decision and are absent for the same reason.

**Sequential betting.** Poker, and anything else where a bet depends on what the person
before you bet, still does not fit: the betting window is one shared window, not a
rotation. The `decisions` phase is close to what that needs but is currently only
reachable _after_ betting closes.

**Avatar customisation and voice.** The social half of a social casino. Both are large
and neither blocks anything else.

**LAN discovery.** A host device announcing itself over UDP broadcast or mDNS, so players
on the same Wi-Fi see "Jason's Floor" in a list and tap it — no address typed anywhere.
Only usable from a Capacitor or Electron build, since browsers cannot do UDP. See
[distribution.md](distribution.md).

## Known limitations

| Limitation                          | Consequence                                        | Where                                |
| ----------------------------------- | -------------------------------------------------- | ------------------------------------ |
| Non-cryptographic commitment digest | Fairness proof is weaker than the UI implies       | `packages/netcode/src/commitment.ts` |
| No persistence                      | Chips reset when a world empties                   | `apps/server/src/ledger.ts`          |
| Everyone replicates everyone        | Bandwidth is O(n²) in players                      | `WorldInstance.replicate`            |
| No splitting in blackjack           | The one basic-strategy move a player cannot make   | `packages/games/.../blackjack.ts`    |
| Avatars are placeholder figures     | A black pill with limbs, not a character           | `WorldRenderer.addAvatar`            |
| Half-disc tables collide as slabs   | The curve is a three-step staircase up close       | `packages/sim/src/world.ts`          |
| Single-process                      | No horizontal scaling; a restart drops every world | `apps/server/src/index.ts`           |
| Client covered by smoke test only   | Broad checks, not fine-grained assertions          | `apps/client/smoke.mjs`              |

The last one is worth expanding on. `npm run test:client` drives a real browser and
catches whole-client breakage — it found a mirrored first-person camera, a third-person
camera that threw every frame, a full-screen HUD element that swallowed every touch on
phones, a world that silently stopped being built at all, and a blackjack Stand button
that rebuilt itself out from under the click. What it does not do is
assert fine-grained behaviour, because the prediction loop is still entangled with the
DOM and WebGL. Extracting that loop from `main.js` into something unit-testable is still
worth doing before the client grows further.
