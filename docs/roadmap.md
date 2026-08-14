# Roadmap

Ordered by what unblocks the most, not by what is most fun to build.

## Working today

Authoritative 30Hz simulation · client prediction and reconciliation · entity
interpolation · delta-compressed snapshots · first and third person cameras · desktop
and touch input · four tables across two games · commit–reveal fairness verified
client-side · chip ledger with bailouts · resume after disconnect · local and table chat
· private worlds by session code.

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

**More games.** The registry pattern means a new one touches four files — see
[adding-a-table-game.md](adding-a-table-game.md). Blackjack is the obvious next: it is
the first game needing per-player sequential decisions, which the current
all-bets-then-one-resolution phase machine does not model.

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
| Client spot hints duplicated        | A new game touches the client too                  | `apps/client/src/hud.js`             |
| Single-process                      | No horizontal scaling; a restart drops every world | `apps/server/src/index.ts`           |
| Client covered by smoke test only   | Broad checks, not fine-grained assertions          | `apps/client/smoke.mjs`              |

The last one is worth expanding on. `npm run test:client` drives a real browser and
catches whole-client breakage — it found a mirrored first-person camera, a third-person
camera that threw every frame, a full-screen HUD element that swallowed every touch on
phones, and a world that silently stopped being built at all. What it does not do is
assert fine-grained behaviour, because the prediction loop is still entangled with the
DOM and WebGL. Extracting that loop from `main.js` into something unit-testable is still
worth doing before the client grows further.
