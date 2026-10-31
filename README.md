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

## Secrecy

Two different things get confused here, so they are worth separating.

**Someone who found the address.** They get the app and nothing else: no index, no
directory listing, no app names in `/healthz`, a flat 404 at the bare domain, and only
`public/` served — `/<slug>/README.md` is a 404, not the method. Codenamed folders mean
the address itself gives nothing away either.

**Someone who found the repository.** They get everything — every app README, every
commit message, this file. No naming scheme touches that, so repository visibility is
the control that matters and everything above is what you do on top of it, not instead
of it. Check which it currently is rather than trusting this paragraph:

```bash
gh repo view --json visibility -q .visibility
```

Making it private changes nothing operationally. The apps are self-contained static
files, Render keeps deploying from a private repository once the connection is
authorised, and **the served site stays public either way** — which it must, since the
phone has to reach it to install the app. A private repository is not a private app.

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
