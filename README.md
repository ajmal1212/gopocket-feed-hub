# Feed hub

One connection to the market feed, fanned out to every visitor of the site.

## Why this exists

The Noren feed allows **exactly one live session per account**. A second
connection authenticates successfully and then closes the first one with code
1000. Measured:

```
t+0.3s   A OPEN, AUTH OK
t+14.2s  B OPEN, AUTH OK
t+14.3s  A *** CLOSED 1000 ***     <- displaced 0.1s after B authenticated
```

So visitors cannot connect to the feed themselves - visitor #2 would disconnect
visitor #1, and with real traffic nobody would hold a connection for more than a
second. This service holds the single session and rebroadcasts.

It also means the hub needs an account **of its own**, and **one account per
environment**. If a developer runs the hub locally against the production
account, production goes dark until they stop.

## Protocol

Browsers speak this, not Noren's protocol - so the page ships ~2KB of client
code instead of a vendor SDK, and the upstream can be replaced without touching
a page.

```
client -> {"sub":   ["NSE|3045","NSE|26000"]}
client -> {"unsub": ["NSE|3045"]}

server -> {"type":"snap","ticks":{"NSE|3045":{...}}}   immediately on subscribe
server -> {"type":"tick","tick":{...}}                 on every update
server -> {"type":"status","up":true}                  upstream connectivity
```

Tick fields come from Noren: `lp` last price, `pc` percent change, `c` previous
close, `o/h/l/v`, `ap` average price, `bp1/sp1/bq1/sq1` best bid/ask, `ts` the
instrument name, `k` the `EXCHANGE|TOKEN` key.

Two details worth knowing:

- `tf` packets are **partial** - only the fields that changed. The hub merges
  them into a cached record, so clients always receive a complete tick.
- The key must include the exchange. `BSE|1` is SENSEX; a bare `1` collides.

## HTTP

- `GET /health` - upstream state, client count, tokens watched.
- `GET /quote?tokens=NSE|3045,NSE|26000` - last known prices, for SSR. A token
  nobody is watching is subscribed on demand, waited on for up to 2s, and kept
  warm for a minute.

## Deploying with Portainer

The repo is a self-contained stack: `docker-compose.yml` at the root, no build
step beyond the image.

**Stacks -> Add stack -> Repository**

- Repository URL: this repo
- Compose path: `docker-compose.yml`
- Add these environment variables in the stack's *Environment variables* panel
  (they are referenced by the compose file, so the key never lives in git):

| Variable | Value |
| --- | --- |
| `NOREN_UID` | the hub's own feed account |
| `FEED_JKEY` | today's session key |
| `ALLOWED_ORIGINS` | `https://gopocket.in,https://www.gopocket.in,http://localhost:4321` |
| `NOREN_WS_URL` | `wss://skypro.skybroking.com/NorenWSWeb/` (default) |

Deploy, then check the container log for:

```
[server] listening on 0.0.0.0:8090
[upstream] authenticated as <uid>
[hub] upstream up
```

The container has a `HEALTHCHECK` on `/health`, so Portainer shows it as
*healthy* once the hub answers.

### Putting it behind TLS

The compose file publishes to `127.0.0.1:8090` only, expecting a reverse proxy
in front. Browsers need `wss://`, so TLS is not optional.

- **Nginx Proxy Manager:** add a proxy host for e.g. `mktfeed.gopocket.in` ->
  `feed-hub:8090`, request a certificate, and **enable "Websockets Support"** -
  without it the upgrade is dropped and the site sees a connection that opens
  and immediately closes.
- **Traefik:** put the container on the proxy network and label it as usual; no
  special WebSocket configuration is needed.
- **Plain nginx on the host:** use `deploy/nginx.conf`, which has the upgrade
  headers and the long read timeout already.

Whichever you use, raise the proxy read timeout to an hour. A 60s default cuts
connections during a quiet market and the site looks broken at lunchtime.

Do **not** name the host `feed.gopocket.in` - that is the upstream Noren feed.

Verify from outside:

```bash
curl https://mktfeed.gopocket.in/health
curl 'https://mktfeed.gopocket.in/quote?tokens=NSE|3045'
```

### Without Docker

`deploy/feed-hub.service` and `deploy/nginx.conf` run it straight on a host
under systemd; the README history of this file has the long form.

## The session key

`FEED_JKEY` rotates daily. Rather than restarting the service, set `KEY_FILE`
and have whatever mints the key write it there - the hub re-reads that file on
every reconnect, and re-reads it automatically when the feed rejects a stale
key. `getFreshKey()` in `src/config.mjs` is the single place to change when the
key starts coming from Frappe instead.

## Local development

```bash
npm install
FEED_JKEY=... NOREN_UID=... ALLOWED_ORIGINS=http://localhost:4321 npm run dev
```

Remember the displacement rule: use a non-production account, or production goes
dark while you work.
