# Playing the game

Three ways to get in, from quickest to most shareable.

The client is a web page, so **there is nothing to install on any device** — no app
store, no APK, no TestFlight. Anything with a modern browser plays: Windows, macOS,
Linux, Android, iPhone, iPad.

---

## 1. On your own computer (30 seconds)

```bash
npm install
npm start
```

`npm start` builds and then runs. When it boots it prints every address it can be
reached on:

```
  Beer Bets — world server running at 30Hz

  On this computer:   http://localhost:8080/beer-bets/

  On your phone or another device (same Wi-Fi):
    http://192.168.1.24:8080/beer-bets/
```

Open <http://localhost:8080/beer-bets/>, type a name, press **Enter the floor**.

To play against yourself while testing, open a second browser window — each tab is an
independent player with its own camera. Use two different browsers (or one normal and
one private window) if you want them to have separate chip stacks, since a plain
refresh deliberately reclaims the same player.

---

## 2. On your phone, over your own Wi-Fi (2 minutes)

This is the fastest way to try the phone controls and to play with people in the same
room.

1. Run `npm start` on your computer.
2. Read the LAN address it printed — the `192.168.x.x` one.
3. Type that address into your phone's browser, including the port and the game path.

Both devices must be on the same Wi-Fi network.

**If the phone cannot connect**, it is almost always the computer's firewall blocking
port 8080 rather than anything in the game:

| System  | What to do                                                                   |
| ------- | ---------------------------------------------------------------------------- |
| macOS   | System Settings → Network → Firewall → allow incoming connections for `node` |
| Windows | Windows Defender Firewall → Allow an app → tick **Private** for Node.js      |
| Linux   | `sudo ufw allow 8080/tcp`                                                    |

Some Wi-Fi networks (most guest and hotel networks, and some ISP routers with "client
isolation" or "AP isolation" switched on) stop devices talking to each other at all. If
that is the case, use option 3.

### Add it to your home screen

Once the page is open on a phone, use **Share → Add to Home Screen** (iOS) or
**⋮ → Add to Home screen** (Android). It then launches full-screen with no browser
chrome, which matters a lot here — the address bar otherwise eats the bottom of a
full-screen 3D view.

---

## 3. Deploy it publicly (10 minutes)

Do this when you want to send a friend a link, or play from mobile data rather than
shared Wi-Fi. See [deploying.md](deploying.md) for the full walkthrough — there is a
`Dockerfile` and a `render.yaml` in the repository, and the server needs nothing but a
port.

Deployed, that becomes `https://play.keydate.ca/beer-bets/`. Anyone who opens it
lands on the public floor; anyone who types the same **session code** lands in a private
world together.

---

## Controls

### Computer

| Action                           | Key                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------ |
| Move                             | `W` `A` `S` `D`                                                                |
| Hit / stand / double             | Click the buttons in the table panel                                           |
| Look                             | Move the mouse (click the game once to capture the pointer; `Esc` releases it) |
| Sprint                           | `Shift` or `Ctrl`                                                              |
| Jump                             | `Space`                                                                        |
| Sit at a table, order at the bar | `E` — you keep facing the way you walked in                                    |
| Chat                             | `Enter`, type, `Enter` again                                                   |
| Switch camera                    | **Third person** button, top right                                             |

### Phone or tablet

**Hold the phone sideways.** Beer Bets is landscape-only: turn a phone upright and the
game covers itself with a note asking you to turn it back. Portrait leaves a letterbox
barely wider than the table panel, which is no way to look at a room. Turn it and the
note is gone — nothing to dismiss.

| Action                           | Gesture                                          |
| -------------------------------- | ------------------------------------------------ |
| Move                             | Drag anywhere on the **left half** of the screen |
| Look                             | Drag anywhere on the **right half**              |
| Jump                             | **Jump** button                                  |
| Sit at a table, order at the bar | **Use** button                                   |
| Chat                             | Tap the chat box                                 |
| Switch camera                    | **Third person** button, top right               |

There is no on-screen joystick to hit precisely — anywhere on the left half works as a
virtual stick from wherever your thumb lands.

---

## Playing together

Everyone who opens the URL with a blank session code lands on the **public floor** and
can see each other immediately.

For a private world, agree a **session code** — any 5 letters, e.g. `FRIED` — and have
everyone type it on the join screen. A code that nobody is using yet simply creates that
world, so there is no "create game" step. Codes avoid the letters `I` and `O` and all
digits, because they get read aloud and mistyped; the game folds the obvious
mishearings back for you.

Your session code is shown in the top-left corner once you are in.

---

## The loop

Chips come from exactly one place — the tables — and they buy exactly one thing: drinks.
The more you drink, the blurrier the room gets, and the harder it is to keep winning the
chips that pay for the next round.

1. **Walk to a table.** Six tables sit around the central plinth, each a half circle:
   dealer alone on the flat side, six stools around the curve. Every table has its curved
   side turned toward the middle of the room, so walking in off the floor brings you out
   among the empty seats. A prompt appears when you are close enough.
2. **Sit down** with `E` (or **Use**). You take the stool you walked up to, still looking
   at the felt the way you were looking at it a moment ago.
3. **Set your bet.** Type any whole number from the table minimum up to your whole stack
   into the bet box, then tap a betting spot to put it down. Your chips appear on the felt
   in front of your seat — red 5, green 25, black 100, purple 500, gold 1000 — so everyone
   can see what everyone is playing for.
4. **Start the round.** On the wheel, roulette and baccarat a timer is already running and
   the round goes when it runs out. **Blackjack has no timer** — nothing happens until
   somebody presses **Deal**, which gives everyone ten seconds of last call to get their
   bets down before the cards come out. Anyone with chips on the felt can press it.
5. **Watch the deal.** Cards come out of the shoe one at a time, turn over as they cross
   the felt, and land in front of whoever they belong to. The dealer's hole card stays
   face down until the hand is over.
6. **Play your hand**, if the game has one. Blackjack deals and then waits on you; the
   panel shows the cards and your buttons, and you get 15 seconds. Run out of time and
   the table plays a sensible hand for you rather than standing on 12.
7. **Check the fairness line** under the table panel. Before betting opens the server
   publishes a commitment; after the round it reveals the seed, and your browser
   verifies the two match. A mismatch shows in red.

### Playing more than one hand

Blackjack has three boxes. Bet on one and you play one hand; bet on two and you play two,
one after the other, each with its own stake and its own outcome. Each box has to meet the
table minimum on its own, so two hands cost at least twice the minimum and three at least
three times.

This is not splitting. A split reacts to a pair you have already been dealt; boxes are
chosen and paid for before a single card comes out.

### The games

| Game                 | Where                                 | What it is                                                                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Blackjack**        | Two tables, north-west and south-east | Eight decks on a continuous shuffler, dealer stands on all 17, blackjack pays 3 to 2. Hit, stand, or double on your first two cards. Play up to three boxes at once, each costing its own bet. Bet anything from 10 up to your whole stack, no table maximum, and the round starts when somebody calls the deal. |
| **Roulette**         | North-east                            | European single zero — one green pocket, not two. Red/black, odd/even, halves, dozens, and the zero straight up at 35 to 1.                                                                                                                                                                                      |
| **Baccarat**         | South-west                            | Punto banco. Back the player, the banker, or a tie; the drawing rules do the rest. Banker pays 0.95 to 1 after commission, a tie pays 9 to 1 and pushes the other two.                                                                                                                                           |
| **Wheel of Fortune** | West wall                             | The house game. The `9x` spot is priced at exactly true odds — the one bet on the floor with no house edge at all.                                                                                                                                                                                               |
| **High Card Duel**   | East wall                             | No house cut whatsoever. Everyone antes, highest card takes the pot. Needs two players.                                                                                                                                                                                                                          |

Every spot on every felt returns between 93% and 100% of what is staked on it, and there
is a test that fails if one ever climbs above 100% or drops below 93%. Roulette is
uniform: all ten spots return exactly 36/37, so where you put your chips is a question of
variance, not of value.

Two deliberate departures from a real pit, both in your favour: baccarat's tie pays 9 to
1 rather than the usual 8 (which would make it a bad bet dressed as an exciting one), and
the Wheel of Fortune is far kinder than the Big Six wheel it is based on.

Then **walk to the bar** in the north-west corner and press `E` to open the menu.

| Drink         | Cost | Effect                             |
| ------------- | ---- | ---------------------------------- |
| Lager         | 40   | A nudge                            |
| Stout         | 75   | Noticeable                         |
| House Whiskey | 130  | The short road to a blurry evening |
| Soda Water    | 25   | Buys back some of your eyesight    |

Intoxication wears off on its own — about two minutes from completely drunk back to
sober — so the question is never "can I recover", it is "can I afford to wait".

Chips are virtual, cannot be bought, and have no cash value. If you hit zero you are
topped back up automatically.

---

## Things worth knowing while you evaluate it

- **A refresh keeps your chips.** The client holds a resume token, so reloading puts you
  back in the same body with the same stack. Open a different browser to be a different
  player.
- **Chips reset when a world empties.** There is no persistence yet — see the
  [roadmap](roadmap.md).
- **Everyone sees everyone.** Fine for a roomful; it will not scale to hundreds until
  interest management lands.
- **The fairness digest is not yet cryptographic.** It must become SHA-256 before this
  goes anywhere public with people you do not know. See [../SECURITY.md](../SECURITY.md).

## Changing things

Fast, self-contained things to try first:

| To change                               | Edit                                                   |
| --------------------------------------- | ------------------------------------------------------ |
| Starting chips, bailout, player cap     | `apps/server/src/config.ts` (or environment variables) |
| Walk/sprint speed, jump height, gravity | `packages/sim/src/constants.ts`                        |
| The floor layout, table positions       | `packages/sim/src/world.ts`                            |
| Paytables and odds                      | one file per game in `packages/games/table-games/src/` |
| Blackjack house rules                   | `blackjack.ts` — deck count, S17, the 3:2 payout       |
| The ten-second last call                | `bettingWindowMs` in `blackjack.ts`                    |
| Deck count and how many boxes           | `SHOE_DECKS` and `MAX_BOXES` in `blackjack.ts`         |
| Chip colours and values                 | `DENOMINATIONS` in `apps/client/src/chips3d.js`        |
| Stools, and how far a seat sits out     | `SEAT_RADIUS` in `packages/sim/src/world.ts`           |
| How the cards fly out of the shoe       | `apps/client/src/cards3d.js`                           |
| How the cards animate in the panel      | `deal-in` in `apps/client/src/style.css`               |
| Which game sits where on the floor      | `tablePositions` in `packages/sim/src/world.ts`        |
| Drink prices, strength, sobering rate   | `apps/server/src/bar.ts`                               |
| How strong the blur gets                | `setDrunkenness` in `apps/client/src/hud.js`           |
| Betting window length                   | `bettingWindowMs` in each game definition              |
| Lighting, colours, camera distance      | `apps/client/src/renderer.js`                          |
| Carpet, wall and ceiling textures       | `apps/client/src/textures.js`                          |
| HUD and table panel                     | `apps/client/src/hud.js`, `apps/client/src/style.css`  |

Adding a whole new table game is four files — see
[adding-a-table-game.md](adding-a-table-game.md).

After any change to `packages/`, run `npm start` again to rebuild. Changes to
`apps/client` are plain files served straight to the browser, so a browser refresh is
enough.
