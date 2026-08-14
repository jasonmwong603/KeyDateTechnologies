# Shipping this as an app, not a URL

## First, the thing that trips everyone up

Genshin Impact, Honkai, Call of Duty Mobile — none of them ask a player for a URL, and
all of them connect to servers that absolutely do have addresses. `Genshin` resolves
domains and opens sockets to IPs exactly like this game does. The difference is only
that the address is **compiled into the client**, so the player never sees it.

That splits your question into two independent problems:

| Problem                                | Answer                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| "I don't want players typing a URL"    | Ship an installable app with the endpoint baked in                                                  |
| "I don't want a server address at all" | Not possible for internet multiplayer — but see [LAN play](#option-4-lan-play-genuinely-no-address) |

The server has to live somewhere reachable. What you are really removing is the player's
awareness of it.

## What is already done

`npm run bundle:client` produces `dist-client/` — a fully self-contained client with

- every module copied in and every path rewritten to be relative (an app has no web root),
- Three.js vendored,
- and **the server address injected as a constant**.

```bash
KEYDATE_SERVER_URL=wss://play.keydate.ca/the-floor npm run bundle:client
```

That directory is the payload every wrapper below consumes. It is verified in CI: the
client smoke test bundles it, serves it from a different origin with no server behind it,
and confirms it still joins the world — which is precisely the situation a packaged app
is in.

If you bundle without `KEYDATE_SERVER_URL`, the app builds but tells the player it has no
server configured, rather than silently trying to reach the device itself.

---

## Option 1: Home-screen install (already works, zero tooling)

Open the game once in a phone browser, then **Share → Add to Home Screen**. You get an
icon, a full-screen launch, and no address bar — visually indistinguishable from a small
native app.

The player types a URL exactly once, ever. For a group of friends this is genuinely
enough, and it costs nothing.

**Limits:** no store presence, no push notifications on iOS worth relying on, and you
cannot hand someone an installer file.

---

## Option 2: Real mobile apps with Capacitor (the Genshin-shaped answer)

Capacitor wraps `dist-client/` into genuine Android and iOS projects. The output is an
`.apk`/`.aab` and an `.ipa` — installable, sideloadable, store-submittable. There is a
`capacitor.config.json` in the repository already pointing at `dist-client`.

```bash
npm install --save-dev @capacitor/cli @capacitor/core @capacitor/android @capacitor/ios

KEYDATE_SERVER_URL=wss://play.keydate.ca/the-floor npm run bundle:client

npx cap add android
npx cap add ios
npx cap sync

npx cap open android   # builds in Android Studio
npx cap open ios       # builds in Xcode
```

After any client change: re-run `bundle:client`, then `npx cap sync`.

**What you need:** Android Studio for Android, and a Mac with Xcode for iOS. There is no
way around the Mac requirement for App Store builds.

> These wrapper builds were **not** compiled or verified here — this environment has
> neither Android Studio nor Xcode. The bundle they consume is verified; the native
> shells around it are not.

### The gambling-theme problem — read this before investing

Both stores treat casino-themed apps as a special category, and this is the most likely
thing to derail a launch:

- **Apple** (Guideline 5.3): apps with **simulated** gambling and no real-money prizes
  are allowed, but expect a 17+ age rating and a reviewer asking directly whether chips
  can be purchased or cashed out. Real-money gambling requires you to be a licensed
  entity in each territory — a completely different undertaking.
- **Google Play**: simulated gambling is permitted under the Real-Money Gambling policy
  provided there are no real-world prizes; expect age-gating and a content declaration.

Your design is already on the compliant side of that line — chips cannot be bought,
cashed out, or transferred, and there is no store to add — so this is a review question
to answer clearly, not a wall. `docs/responsible-play.md` exists partly so you have those
answers written down. **Do not add chip purchases** without understanding that it moves
the app into a licensed category in most jurisdictions.

**If you want to skip stores entirely:** distribute the Android `.apk` directly as a
download. Players sideload it. No review, no fee, no policy. iOS cannot do this outside
TestFlight (100 external testers, still reviewed) or an Enterprise/Ad-Hoc profile.

---

## Option 3: Desktop apps with Electron or Tauri

For PC, wrap the same `dist-client/` into a `.exe` / `.dmg` / `.AppImage`.

**Tauri** produces far smaller binaries (~5MB vs ~120MB) because it uses the OS webview
rather than shipping Chromium; **Electron** is simpler if you want to embed Node.

The interesting Electron variant: because the server is plain Node, a desktop build can
**embed the world server itself**. One friend launches the app, it starts a server on
their machine, and everyone else's client connects to them — no hosting bill, no
deployment, and the host's address is the only thing that needs sharing. Combine with
Option 4 and even that disappears on a LAN.

---

## Option 4: LAN play, genuinely no address

This is the only configuration with no address anywhere, and it is how local-multiplayer
party games work.

The host device runs the server and announces itself on the local network over UDP
broadcast or mDNS/Bonjour. Other clients listen, find the host automatically, and show
"Jason's Floor" in a list to tap. Nobody types anything.

**Not built yet.** It needs a small discovery service on both sides — a broadcast
announcement from the server and a listener in the client — and it only works on a single
Wi-Fi network. Say the word and it is a contained piece of work.

The catch: a browser cannot do UDP discovery. This option only exists for the Capacitor
or Electron builds, where native networking is available.

---

## Choosing

| You want                       | Do this                                           |
| ------------------------------ | ------------------------------------------------- |
| Friends playing tonight        | Option 1 — home screen, or just the URL           |
| An icon they install, no store | Option 2, distribute the `.apk` directly          |
| Public launch on phones        | Option 2 via the stores — read the policy section |
| A PC game with a launcher      | Option 3                                          |
| Same-room play, nothing typed  | Option 4, on top of Option 2 or 3                 |

Everything except Option 4 still needs the server deployed somewhere — see
[deploying.md](deploying.md). Options 1–3 all consume the same verified `dist-client/`
payload, so you can change your mind later without rebuilding the client.

## The one thing to decide early

**Where the server lives**, because the address gets compiled into every build you ship.
Point builds at `wss://play.keydate.ca/the-floor`, a domain you control, rather than a
raw Render or Fly hostname. Baking a platform hostname into an app that people have
installed means a migration requires all of them to reinstall.

The path matters too, which is why `LEGACY_SLUGS` exists: renaming the game without
listing its old slug would strand every installed build, since their endpoint is
compiled in and you cannot update it for them. See [deploying.md](deploying.md).
