# Deploying

The server is one Node process serving both the client and the WebSocket endpoint on a
single port. There is no database, no cache and no build artifact to ship separately.

## The one requirement

**The host must proxy WebSockets.** This is the only thing that meaningfully narrows the
choice of platform, and the failure mode is confusing: the page loads perfectly, then
sits on the join screen forever because the socket never upgrades.

Anything that supports WebSockets works. Render, Fly.io, Railway, Heroku, a plain VPS,
and Cloud Run all do. Classic serverless targets (Lambda, Vercel functions, Netlify
functions) do not, because the whole design is a long-lived process holding a 30Hz tick
loop and every player's connection in memory.

## Render (simplest)

There is a `render.yaml` in the repository.

1. Push this repository to GitHub.
2. In Render: **New → Blueprint**, pick the repo, **Apply**.
3. Wait for the first build, then open the URL it gives you.

Render terminates TLS, so the client connects over `wss://` automatically — it picks the
scheme from the page it was served on.

The free plan sleeps after inactivity. The first visitor after a sleep waits ~30 seconds
for a cold start, and **every world's chips reset**, since state lives in memory.

## Fly.io (better latency)

There is a `fly.toml` and a `Dockerfile`.

```bash
fly launch --no-deploy      # claim a name, keep the existing fly.toml
fly deploy
```

Change `primary_region` to one near your players. For a real-time game this is worth
caring about: at 30Hz, a server on another continent adds 150ms+ to every correction, and
prediction papers over that less and less as it grows.

`auto_stop_machines` is deliberately off. A stopped machine drops every live session.

## Docker anywhere

```bash
docker build -t beer-bets .
docker run -p 8080:8080 beer-bets
```

The image is multi-stage, runs as the unprivileged `node` user, and exposes `/healthz`.

## A plain VPS

```bash
git clone <your-repo> && cd KeyDateTechnologies
npm ci
npm run build
PORT=8080 npm run serve
```

Put nginx or Caddy in front for TLS. If you use nginx, WebSockets need the upgrade
headers forwarded explicitly — this is the single most common way to end up with a
site that loads but never connects:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    # Longer than the idle timeout of a player standing still at a table.
    proxy_read_timeout 900s;
}
```

Caddy does this automatically:

```
keydate.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

## Putting it on play.keydate.ca

The target layout is `https://play.keydate.ca/beer-bets/`. The apex domain is left
completely alone — this is a new subdomain, so nothing about keydate.ca's DNS,
hosting or content changes.

### DNS

Add **one** record at your DNS provider. Do not touch the existing `keydate.ca`
records.

| Type  | Name   | Value                                |
| ----- | ------ | ------------------------------------ |
| CNAME | `play` | the hostname your platform gives you |

On Render that is the `onrender.com` hostname shown under **Settings → Custom Domains**
after you add `play.keydate.ca`. On Fly, run `fly certs add play.keydate.ca` and it
prints the records to create. Both then issue TLS for the subdomain automatically.

Because the apex is untouched, `keydate.ca` and `www.keydate.ca` keep resolving exactly
where they do today. You can confirm before and after:

```bash
dig +short keydate.ca        # unchanged
dig +short play.keydate.ca   # points at your game host
```

### The resulting URLs

| URL                          | What happens            |
| ---------------------------- | ----------------------- |
| `play.keydate.ca/beer-bets/` | The game                |
| `play.keydate.ca/beer-bets`  | 301 to the above        |
| `play.keydate.ca/`           | 301 to the current game |
| `play.keydate.ca/healthz`    | Health probe            |
| `keydate.ca`                 | Untouched               |

### Renaming the game later

Change one variable, and list the old name so nothing breaks:

```bash
GAME_SLUG=high-roller
LEGACY_SLUGS=beer-bets
```

Requests to `/beer-bets/...` then 301 to `/high-roller/...` with the rest of the path
intact. This matters more than it looks: shared links and bookmarks survive, and so do
**already-installed apps**, which have their address compiled in and cannot be updated
by you. Keep old slugs listed indefinitely — they cost nothing.

`LEGACY_SLUGS` takes a comma-separated list, so a game can be renamed more than once.

## Where the game gets mounted

The game serves everything — client, assets and the WebSocket — under one
configurable path prefix, so it can share a host with other properties instead of
owning the domain root.

```bash
GAME_SLUG=beer-bets npm run serve     # served at  https://<host>/beer-bets/
GAME_SLUG= npm run serve              # served at  https://<host>/
```

`GAME_SLUG` is the only place the name appears. Renaming the game later, or standing
a second one up beside it, is a change to this value and nothing else — the client
discovers its own base path from the document at runtime rather than being built for a
particular URL.

The host root and the slug without a trailing slash both `301` to the canonical
`/<slug>/`, and `/healthz` stays at the domain root so platform probes do not need to
know where the game is mounted.

### Behind a reverse proxy

To serve the game at `play.example.com/beer-bets` while other things live on the same
host, forward the prefix and leave everything else alone:

```nginx
location /beer-bets/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 900s;
}
```

Note the game keeps its own prefix — do **not** strip it in the proxy, because the
server uses it to build the page's `<base href>` and the socket path.

## Configuration

All optional — the defaults are playable.

| Variable                  | Default     | Meaning                                               |
| ------------------------- | ----------- | ----------------------------------------------------- |
| `GAME_SLUG`               | `beer-bets` | Path the game is served under; empty means the root   |
| `GAME_TITLE`              | `Beer Bets` | Name shown on the join screen                         |
| `PORT`                    | `8080`      | HTTP + WebSocket port                                 |
| `HOST`                    | `0.0.0.0`   | Bind address                                          |
| `MAX_PLAYERS_PER_WORLD`   | `32`        | Players per world instance                            |
| `STARTING_CHIPS`          | `2500`      | Opening stack                                         |
| `BAILOUT_CHIPS`           | `500`       | Granted at exactly zero chips                         |
| `RESUME_GRACE_MS`         | `90000`     | How long a dropped player's avatar and chips are held |
| `SOCKET_TIMEOUT_MS`       | `30000`     | Idle socket cull                                      |
| `MAX_MESSAGES_PER_SECOND` | `120`       | Per-socket rate limit                                 |

## Before anyone outside a trusted group plays

- **Replace the commitment digest with SHA-256.** The current iterated FNV-1a gives a
  real transcript but is not collision-resistant, and the UI tells players rounds are
  verified. See [../SECURITY.md](../SECURITY.md).
- **Decide what happens to chips on restart.** Today they vanish. On a free tier that
  sleeps, that is every few hours.
- **Think about world capacity.** Every client replicates every other client, so a
  single busy world costs bandwidth quadratic in players. 32 is a sensible ceiling until
  interest management lands.

## Sizing

A world instance is a few hundred KB plus per-player state. The 30Hz tick is cheap —
movement for 32 players is microseconds — so the practical limit is bandwidth from
replication, not CPU. A 512MB shared instance comfortably runs several dozen players.
