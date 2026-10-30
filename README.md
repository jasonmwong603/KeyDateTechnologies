# KeyDate Technologies — Magic Apps

Props that run on a phone, on stage, in front of people. One app per trick.

They are not web apps that happen to be used on stage. A prop has to open in a basement
with no signal, survive a stranger picking it up and working out a tip on it, and give
away nothing about what it is — including to anyone who types its address into a
browser.

## The apps

| App                          | Address | What it is                                                        |
| ---------------------------- | ------- | ----------------------------------------------------------------- |
| [Clockwork](apps/clockwork/) | `/calc` | A calculator that is a calculator, and once a performance is not. |

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

**Only `public/` is ever served.** Everything beside it — the README that explains the
method, the tests that walk the whole routine — is unreachable over HTTP. That boundary
is a directory rather than a list of exclusions precisely so it cannot rot.

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
picked back up. The tag `beer-bets-shelved` marks the last commit where it was the
repository's subject.
