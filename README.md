# KeyDate Technologies — Magic Apps

Props that run on a phone, on stage, in front of people. One app per trick.

They are not web apps that happen to be used on stage. A prop has to open in a basement
with no signal, survive a stranger picking it up and working out a tip on it, and give
away nothing about what it is — including to anyone who types its address into a
browser.

## The apps

| App                          | Address |
| ---------------------------- | ------- |
| [Clockwork](apps/clockwork/) | `/calc` |

Folders are codenames and this table does not say what any of them do. What a trick is
lives in its own README, one level down — a single file mapping every codename to its
effect would undo the point of having codenames.

## Running them

```bash
npm install
npm start
```

Every app is served under its own slug: <http://localhost:8080/calc/>. There is no build
step — the apps are plain files and the host is plain Node, which is also why a deploy is
a checkout and a process start.

```bash
npm test             # the host, then every app's arithmetic
npm run test:browser # drives real Chromium at phone size
```

`npm run check` is the one that matters for a performance. If it ever reports less than
100% exact, the room's calculators disagree with the phone.

## Adding a trick

```
apps/<name>/
  app.json        {"name": "…", "slug": "…"}   ← the whole registration
  public/         everything the world can see
  check.mjs       proves the arithmetic
  smoke.mjs       drives a browser
  README.md       the method. Never served.
```

Drop the folder in and the host finds it. No shared code changes, so a new trick cannot
break one that is being performed tonight.

### Addresses

Every app is served at `play.keydate.ca/<slug>`, and the slug defaults to the folder
name — `apps/heron/` is at `/heron` with nothing configured.

**Folders are codenames, so the default is usually right.** The address is the one part
of a prop an audience can see: it is on screen the whole time you install it, and again
every time you hand someone the phone. `/mindreader` announces what is coming; `/heron`
says nothing at all. Set `slug` only when the codename happens to read as something, or
when the address should look like a category of ordinary app — which is why Clockwork is
served at `/calc`.

A codename protects against that glance and against nothing else. See
[Secrecy](#secrecy).

Lower-case letters, digits and hyphens only. Two apps claiming one address, an app
sitting on a route the host answers itself, or an address that would need escaping all
stop the host from starting, naming the folder and the fix. The alternative is an app
that is silently unreachable, and the place that gets found out is a stage.

**Only `public/` is ever served.** Everything beside it — the README that explains the
method, the tests that walk the whole routine — is unreachable over HTTP. That boundary
is a directory rather than a list of exclusions precisely so it cannot rot.

## What is hidden, and what is not

**The methods are public, on purpose.** This repository is open and the licence is MIT.
Every app README explains exactly how its trick works, and the commit history explains
why it works that way. If you found this and want to build one for yourself, take it —
that is the intent, not an oversight, and there is nothing here to be careful about on
the author's behalf.

**What is protected is the performance, not the secret.** A prop is handed to people. It
is unlocked, in someone else's hand, with its address on screen — and the person holding
it has every reason to look. Everything below exists for that minute and no other:

- Folders are codenames, so the address says nothing. `/heron`, not `/mindreader`.
- Only `public/` is served, so `/<slug>/README.md` is a 404 rather than the method.
- No index, no directory listing, no app names in `/healthz`, a flat 404 at the bare
  domain. Nothing invites a look around.

None of that is undone by the repository being readable. Somebody at the back of a room
with your phone in their hand is not going to find the GitHub repository in the ninety
seconds they have it; they might well tap the address bar. These measures are aimed at
the person in the room, which is the only person who can actually spoil anything.

The served site is public either way — it has to be, since the phone must reach it to
install the app. A private repository would not have changed that.

## Deploying

`render.yaml` is a Render blueprint: `npm ci --omit=dev` and `npm start`, no build. The
host has no runtime dependencies at all.

Each app's address can be changed on the host without a commit — `SLUG_CLOCKWORK`, named
after the folder. Setting one empty takes that app off the air. The address is the only
part of a prop an audience could ever see, so it should stay dull.

Note that a value set in the Render dashboard overrides the blueprint and is not updated
by re-applying it.

## Beer Bets

The multiplayer casino game that used to be this repository is in
[`shelved/beer-bets/`](shelved/beer-bets/), complete and passing its tests, waiting to be
picked back up. The branch `claude/gaming-repo-setup-mf80i9` still points at `f8164e6`,
the last commit where it was this repository's subject, so the whole thing as it stood is
one checkout away.
