import { config } from "./config.mjs";
import { Registry } from "./registry.mjs";
import { NorenUpstream } from "./upstream.mjs";
import { createServer } from "./server.mjs";
import { metrics } from "./metrics.mjs";

const QUOTE_PIN_MS = 60_000;
const QUOTE_WAIT_MS = 2_000;

const registry = new Registry();
const upstream = new NorenUpstream();

/**
 * A stand-in watcher for tokens an SSR render asked about. It keeps the token
 * subscribed for a minute after the request, so the next render of the same
 * page - which is the common case - is served straight from cache.
 */
const ssrWatcher = Symbol("ssr");
const pinned = new Map();

function pin(token) {
  clearTimeout(pinned.get(token));
  pinned.set(
    token,
    setTimeout(() => {
      pinned.delete(token);
      const dropped = registry.remove(ssrWatcher, [token]);
      if (dropped.length > 0) upstream.unsubscribe(dropped);
    }, QUOTE_PIN_MS),
  );
}

async function ensureQuote(tokens) {
  const missing = tokens.filter((t) => !registry.cached(t));

  if (missing.length > 0) {
    const fresh = registry.add(ssrWatcher, missing);
    if (fresh.length > 0) upstream.subscribe(fresh);
    for (const token of missing) pin(token);

    // Give the feed a moment to send the opening snapshot, then answer with
    // whatever arrived. A slow feed must not hold up a page render.
    const deadline = Date.now() + QUOTE_WAIT_MS;
    while (Date.now() < deadline && missing.some((t) => !registry.cached(t))) {
      await new Promise((r) => setTimeout(r, 100));
    }
  } else {
    for (const token of tokens) if (pinned.has(token)) pin(token);
  }

  return registry.snapshot(tokens);
}

const server = createServer({ registry, upstream, ensureQuote });

upstream.on("tick", (token, packet) => {
  const merged = registry.merge(token, packet);
  metrics.tick(token, merged);
  metrics.broadcast(server.broadcast(token, merged));
});

upstream.on("status", (up, info) => {
  console.log(`[hub] upstream ${up ? "up" : "down"}`);
  metrics.upstreamStatus(up, info);
  server.announceStatus(up);
});

// Nobody watching means no reason to hold the account's one session. Overnight
// the hub sits idle with no upstream connection, and wakes on the next visitor.
setInterval(() => {
  if (registry.watchedCount === 0 && upstream.connected) {
    console.log("[hub] idle, releasing upstream session");
    upstream.disconnect();
  } else if (registry.watchedCount > 0 && !upstream.connected) {
    upstream.connect();
  }
}, config.idleDisconnectMs).unref();

server.listen();
upstream.connect();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[hub] ${signal}, shutting down`);
    upstream.shutdown();
    server.close();
    setTimeout(() => process.exit(0), 500);
  });
}
