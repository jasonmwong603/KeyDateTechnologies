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
  The Keydate Floor — world server running at 30Hz

  On this computer:   http://localhost:8080

  On your phone or another device (same Wi-Fi):
    http://192.168.1.24:8080
```

Open <http://localhost:8080>, type a name, press **Enter the floor**.

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
3. Type that address into your phone's browser, including `:8080`.

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

Once deployed you get a URL like `https://keydate.onrender.com`. Anyone who opens it
lands on the public floor; anyone who types the same **session code** lands in a private
world together.

---

## Controls

### Computer

| Action                    | Key                                                                            |
| ------------------------- | ------------------------------------------------------------------------------ |
| Move                      | `W` `A` `S` `D`                                                                |
| Look                      | Move the mouse (click the game once to capture the pointer; `Esc` releases it) |
| Sprint                    | `Shift`                                                                        |
| Jump                      | `Space`                                                                        |
| Sit at a table / stand up | `E`                                                                            |
| Chat                      | `Enter`, type, `Enter` again                                                   |
| Switch camera             | **Third person** button, top right                                             |

### Phone or tablet

| Action                    | Gesture                                          |
| ------------------------- | ------------------------------------------------ |
| Move                      | Drag anywhere on the **left half** of the screen |
| Look                      | Drag anywhere on the **right half**              |
| Jump                      | **Jump** button                                  |
| Sit at a table / stand up | **Use** button                                   |
| Chat                      | Tap the chat box                                 |
| Switch camera             | **Third person** button, top right               |

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

## What to do in there

1. **Walk to a table.** Four tables sit around the central bar. A prompt appears when
   you are close enough.
2. **Sit down** with `E` (or **Use**).
3. **Pick a stake** — 10, 50, 250 or 1000 — then tap a betting spot.
4. **Watch the timer.** Betting closes when it runs out, or as soon as everyone at the
   table is ready.
5. **Check the fairness line** under the table panel. Before betting opens the server
   publishes a commitment; after the round it reveals the seed, and your browser
   verifies the two match. A mismatch shows in red.

**Wheel of Fortune** is the house game — the `9x` spot is priced at exactly true odds,
so it is the one bet with no house edge. **High Card Duel** takes no house cut at all:
everyone antes, highest card takes the pot.

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
| Paytable and odds                       | `packages/games/table-games/src/wheelOfFortune.ts`     |
| Betting window length                   | `bettingWindowMs` in each game definition              |
| Lighting, colours, camera distance      | `apps/client/src/renderer.js`                          |
| HUD and table panel                     | `apps/client/src/hud.js`, `apps/client/src/style.css`  |

Adding a whole new table game is four files — see
[adding-a-table-game.md](adding-a-table-game.md).

After any change to `packages/`, run `npm start` again to rebuild. Changes to
`apps/client` are plain files served straight to the browser, so a browser refresh is
enough.
