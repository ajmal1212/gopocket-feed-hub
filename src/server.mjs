import { createServer as createHttpServer } from "node:http";
import { WebSocketServer } from "ws";
import { config } from "./config.mjs";
import { fetchCandles, isValidInterval, INTERVALS, DAILY } from "./candles.mjs";
import { metrics } from "./metrics.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PING_MS = 30_000;
const STATS_MS = 1_000;

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The dashboard is one file with no build step, read once at boot. If it is
 * missing the hub still runs - monitoring should never be able to take the
 * feed down.
 */
let dashboardHtml = "";
try {
  dashboardHtml = readFileSync(join(HERE, "..", "public", "dashboard.html"), "utf8");
} catch {
  dashboardHtml = "<!doctype html><title>Feed hub</title><p>Dashboard file missing.</p>";
}

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

/**
 * The browser-facing half of the hub.
 *
 * Clients speak our own tiny JSON protocol rather than Noren's, so the page
 * ships a ~2KB WebSocket client instead of a vendor SDK, and so the upstream
 * can be swapped without touching a single page:
 *
 *   client -> {"sub":["NSE|3045"]} | {"unsub":[...]}
 *   server -> {"type":"snap","ticks":{...}}    on subscribe, from cache
 *             {"type":"tick","tick":{...}}     on every update
 *             {"type":"status","up":true}      upstream connectivity
 */
export function createServer({ registry, upstream, ensureQuote }) {
  const clients = new Set();
  const statsClients = new Set();
  const connectionsPerIp = new Map();

  const snapshot = () =>
    metrics.snapshot({
      tokensWatched: registry.watchedCount,
      subscribedTokens: registry.watchedTokens(),
    });

  const http = createHttpServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/" || url.pathname === "/dashboard") {
      if (config.dashboardToken && url.searchParams.get("key") !== config.dashboardToken) {
        return json(res, 401, { error: "dashboard key required" });
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(dashboardHtml);
      return;
    }

    if (url.pathname === "/stats") {
      return json(res, 200, snapshot());
    }

    if (url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        upstream: upstream.connected,
        clients: clients.size,
        tokensWatched: registry.watchedCount,
      });
    }

    // Server-side rendering reads prices from here, so a stock page ships real
    // numbers in its HTML instead of dashes that fill in after hydration.
    if (url.pathname === "/quote") {
      const tokens = (url.searchParams.get("tokens") || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, config.maxTokensPerClient);

      if (tokens.length === 0) return json(res, 400, { error: "tokens required" });

      ensureQuote(tokens)
        .then((ticks) => {
          res.writeHead(200, {
            "Content-Type": "application/json",
            // Brief edge/browser caching absorbs a burst of renders of the same
            // page without another round trip, and costs at most one stale tick.
            "Cache-Control": "public, max-age=2",
          });
          res.end(JSON.stringify({ ticks }));
        })
        .catch(() => json(res, 502, { error: "upstream unavailable" }));
      return;
    }

    // Historical candles for the chart on a stock page. The live feed extends
    // the newest candle in the browser, so this only has to be roughly current.
    if (url.pathname === "/candles") {
      const key = url.searchParams.get("token") || "";
      const raw = url.searchParams.get("interval") || "5";
      // Daily is a different upstream keyed by trading symbol, not by token.
      const interval = raw === DAILY ? DAILY : Number(raw);
      const symbol = url.searchParams.get("symbol") || "";
      const now = Math.floor(Date.now() / 1000);
      const to = Number(url.searchParams.get("to") || now);
      const from = Number(url.searchParams.get("from") || to - 24 * 60 * 60);

      if (!isValidInterval(interval)) {
        return json(res, 400, {
          error: "interval must be " + DAILY + " or one of " + INTERVALS.join(","),
        });
      }
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
        return json(res, 400, { error: "bad from/to" });
      }

      fetchCandles({ key, interval, from, to, symbol })
        .then((candles) => {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": interval === DAILY ? "public, max-age=900" : "public, max-age=30",
          });
          res.end(JSON.stringify({ interval, candles }));
        })
        .catch((error) => json(res, 502, { error: String(error.message || error) }));
      return;
    }

    json(res, 404, { error: "not found" });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  http.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin;
    if (config.allowedOrigins.length > 0 && origin && !config.allowedOrigins.includes(origin)) {
      socket.destroy();
      return;
    }

    // Behind nginx, the socket address is always the proxy.
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
    if ((connectionsPerIp.get(ip) || 0) >= config.maxConnectionsPerIp) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.ip = ip;
      connectionsPerIp.set(ip, (connectionsPerIp.get(ip) || 0) + 1);
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    ws.tokens = new Set();
    ws.isAlive = true;
    clients.add(ws);
    metrics.clientOpened();
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    send(ws, { type: "status", up: upstream.connected });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (Array.isArray(msg.sub)) {
        const tokens = msg.sub.filter(isValidToken).slice(0, config.maxTokensPerClient);
        const room = config.maxTokensPerClient - ws.tokens.size;
        const accepted = tokens.slice(0, Math.max(0, room));
        for (const t of accepted) ws.tokens.add(t);

        const fresh = registry.add(ws, accepted);
        if (fresh.length > 0) upstream.subscribe(fresh);

        // Whatever we already know goes out immediately - a new tab should not
        // wait for the next print to show a price.
        const snap = registry.snapshot(accepted);
        if (Object.keys(snap).length > 0) send(ws, { type: "snap", ticks: snap });
      }

      // The dashboard asks for stats instead of prices. It is counted as a
      // client like any other, because it is one.
      if (msg.stats === true) {
        statsClients.add(ws);
        send(ws, { type: "stats", stats: snapshot() });
        return;
      }

      if (Array.isArray(msg.unsub)) {
        const tokens = msg.unsub.filter(isValidToken);
        for (const t of tokens) ws.tokens.delete(t);
        const dropped = registry.remove(ws, tokens);
        if (dropped.length > 0) upstream.unsubscribe(dropped);
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      statsClients.delete(ws);
      metrics.clientClosed();
      const dropped = registry.remove(ws, [...ws.tokens]);
      if (dropped.length > 0) upstream.unsubscribe(dropped);
      const left = (connectionsPerIp.get(ws.ip) || 1) - 1;
      if (left <= 0) connectionsPerIp.delete(ws.ip);
      else connectionsPerIp.set(ws.ip, left);
    });
  });

  const statsTimer = setInterval(() => {
    if (statsClients.size === 0) return;
    const payload = JSON.stringify({ type: "stats", stats: snapshot() });
    for (const ws of statsClients) {
      if (isOpenSocket(ws)) ws.send(payload);
      else statsClients.delete(ws);
    }
  }, STATS_MS);

  // Idle sockets through a proxy die silently; this notices and reclaims them.
  const pinger = setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, PING_MS);

  return {
    listen: () =>
      http.listen(config.port, config.host, () =>
        console.log(`[server] listening on ${config.host}:${config.port}`),
      ),

    broadcast(token, tick) {
      const watchers = registry.watchersOf(token);
      if (!watchers) return 0;
      const payload = JSON.stringify({ type: "tick", tick });
      let sent = 0;
      for (const ws of watchers) {
        // Not every watcher is a socket: an SSR quote pins a token with a
        // placeholder watcher that has nothing to send to.
        if (isOpenSocket(ws)) {
          ws.send(payload);
          sent += 1;
        }
      }
      return sent;
    },

    announceStatus(up) {
      const payload = JSON.stringify({ type: "status", up });
      for (const ws of clients) {
        if (isOpenSocket(ws)) ws.send(payload);
      }
    },

    get clientCount() {
      return clients.size;
    },

    close() {
      clearInterval(pinger);
      clearInterval(statsTimer);
      for (const ws of clients) ws.close();
      http.close();
    },
  };
}

const WS_OPEN = 1;

const isOpenSocket = (ws) => typeof ws?.send === "function" && ws.readyState === WS_OPEN;

const send = (ws, obj) => {
  if (isOpenSocket(ws)) ws.send(JSON.stringify(obj));
};

/** "NSE|3045" - an exchange and a token, both non-empty. */
const isValidToken = (t) => {
  if (typeof t !== "string" || t.length > 40) return false;
  const parts = t.split("|");
  return parts.length === 2 && parts[0].trim() !== "" && parts[1].trim() !== "";
};
