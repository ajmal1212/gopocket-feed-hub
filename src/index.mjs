import { config } from "./config.mjs";
import { Registry } from "./registry.mjs";
import { NorenUpstream } from "./upstream.mjs";
import { createServer } from "./server.mjs";
import { metrics } from "./metrics.mjs";
import { isWindowOpen, windowState } from "./schedule.mjs";
import { getMode, loadMode, setMode } from "./control.mjs";

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

const server = createServer({ registry, upstream, ensureQuote, setControlMode });

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

/**
 * Tokens the hub subscribes to for its own sake, held by a watcher that never
 * goes away. Nifty 50 prints through every market hour, so the feed always has
 * something flowing - which keeps the connection demonstrably alive rather than
 * merely open, and gives the dashboard a heartbeat when no visitor is on the
 * site.
 */
const alwaysWatcher = Symbol("always");
if (config.alwaysSubscribe.length > 0) {
  const fresh = registry.add(alwaysWatcher, config.alwaysSubscribe);
  if (fresh.length > 0) upstream.subscribe(fresh);
  console.log(`[hub] always subscribed: ${config.alwaysSubscribe.join(", ")}`);
}

/**
 * The daily window, rather than connecting on demand.
 *
 * The account permits one live session, so the hub either holds it or stays off
 * it - reconnecting whenever a visitor appears would risk colliding with
 * whatever else is starting up. Checked every half minute; the boundary matters
 * to the minute, not the second.
 */
let lastDesired = null;
function applySchedule(force = false) {
  const mode = getMode();
  // "off" and "on" outrank the clock; only "auto" consults it.
  const desired = mode === "off" ? false : mode === "on" ? true : isWindowOpen();

  if (!force && desired === lastDesired) return;
  lastDesired = desired;

  const state = windowState();
  if (desired) {
    const why = mode === "on" ? "manually started" : `window open (${state.opensAt}-${state.closesAt} IST)`;
    console.log(`[hub] ${why}, connecting`);
    // resume() reconnects when it was paused; connect() covers the case where
    // it never was. Both are guarded against opening a second session.
    upstream.resume();
    upstream.connect();
  } else {
    const why = mode === "off" ? "manually killed - staying off the account" : `window closed until ${state.opensAt} IST`;
    console.log(`[hub] ${why}, releasing the session`);
    upstream.pause();
  }
}

/** Called by the dashboard. Applies immediately rather than waiting for the tick. */
function setControlMode(next) {
  const mode = setMode(next);
  applySchedule(true);
  return mode;
}

setInterval(() => applySchedule(), 30_000).unref();

loadMode();
server.listen();
applySchedule(true);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[hub] ${signal}, shutting down`);
    upstream.shutdown();
    server.close();
    setTimeout(() => process.exit(0), 500);
  });
}
