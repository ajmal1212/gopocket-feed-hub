import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config } from "./config.mjs";
import { getCredentials, invalidateCredentials } from "./credentials.mjs";

const HEARTBEAT_MS = 10_000;
const SUBSCRIBE_DEBOUNCE_MS = 200;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

/**
 * The single connection to the Noren feed for the whole site.
 *
 * The feed permits exactly one live session per account - a second connection
 * authenticates fine and then closes the first one, cleanly, with code 1000.
 * That is why this class exists at all, and why a "normal" close we did not ask
 * for is logged as loudly as an error: it almost always means something else
 * logged in with the same account, and this hub is now the one being kicked.
 */
export class NorenUpstream extends EventEmitter {
  #ws = null;
  #authed = false;
  #heartbeat = null;
  #reconnect = null;
  #attempt = 0;
  #closing = false;
  #paused = false;
  uid = "";

  /** Tokens the registry wants; the source of truth across reconnects. */
  #wanted = new Set();
  /** Batched diffs, flushed together so a burst of page loads is one frame. */
  #pendingSub = new Set();
  #pendingUnsub = new Set();
  #flush = null;

  get connected() {
    return this.#authed;
  }

  async connect() {
    if (this.#ws || this.#closing || this.#paused) return;

    let credentials;
    try {
      credentials = await getCredentials();
    } catch (error) {
      console.error(`[upstream] cannot read credentials: ${error.message}`);
      this.#scheduleReconnect();
      return;
    }

    this.uid = credentials.uid;

    const ws = new WebSocket(config.norenUrl);
    this.#ws = ws;
    const openedAt = Date.now();

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          t: "c",
          susertoken: credentials.jkey,
          actid: credentials.uid,
          uid: credentials.uid,
          source: "WEB",
        }),
      );
    });

    ws.on("message", (raw) => this.#onMessage(raw));

    ws.on("error", (err) => console.error("[upstream] socket error:", err.message));

    ws.on("close", (code) => {
      const wasAuthed = this.#authed;
      const aliveMs = Date.now() - openedAt;
      this.#teardown();

      if (this.#closing) return;

      // Authenticated, then closed within seconds, without us asking: that is
      // the displacement signature, not a network blip.
      const displaced = wasAuthed && code === 1000 && aliveMs < 30_000;
      if (displaced) {
        console.error(
          `[upstream] displaced after ${(aliveMs / 1000).toFixed(1)}s - another session is using ${this.uid}. ` +
            "The hub needs an account of its own; reconnecting will just fight over it.",
        );
      } else {
        console.warn(`[upstream] closed (code ${code}) after ${(aliveMs / 1000).toFixed(1)}s`);
      }

      this.emit("status", false, { displaced });
      this.#scheduleReconnect();
    });
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.t === "ck") {
      if (msg.s === "OK") {
        this.#authed = true;
        this.#attempt = 0;
        console.log(`[upstream] authenticated as ${this.uid}`);
        // Everything the registry wants, re-sent from scratch: the server keeps
        // no memory of a session that just died.
        if (this.#wanted.size > 0) this.#send("t", [...this.#wanted]);
        this.#startHeartbeat();
        this.emit("status", true);
      } else {
        // A rejected key is stale. Drop the cached copy so the next attempt
        // re-reads Frappe, which rotates it every morning around 08:15.
        invalidateCredentials();
        console.error("[upstream] authentication rejected - session key is stale or wrong");
        this.#ws?.close();
      }
      return;
    }

    if (msg.t === "tk" || msg.t === "tf") {
      // `tf` carries only the fields that changed, so the merge happens in the
      // registry cache. Exchange must be part of the key: BSE|1 is SENSEX and
      // NSE|1 is something else entirely.
      if (!msg.e || !msg.tk) return;
      this.emit("tick", `${msg.e}|${msg.tk}`, msg);
    }
  }

  /** Ask the feed for these tokens; safe to call repeatedly with overlap. */
  subscribe(tokens) {
    for (const t of tokens) {
      this.#wanted.add(t);
      this.#pendingUnsub.delete(t);
      this.#pendingSub.add(t);
    }
    this.#scheduleFlush();
  }

  unsubscribe(tokens) {
    for (const t of tokens) {
      this.#wanted.delete(t);
      this.#pendingSub.delete(t);
      this.#pendingUnsub.add(t);
    }
    this.#scheduleFlush();
  }

  #scheduleFlush() {
    if (this.#flush) return;
    this.#flush = setTimeout(() => {
      this.#flush = null;
      if (this.#pendingSub.size > 0) this.#send("t", [...this.#pendingSub]);
      if (this.#pendingUnsub.size > 0) this.#send("u", [...this.#pendingUnsub]);
      this.#pendingSub.clear();
      this.#pendingUnsub.clear();
    }, SUBSCRIBE_DEBOUNCE_MS);
  }

  #send(type, tokens) {
    if (!this.#authed || this.#ws?.readyState !== WebSocket.OPEN) return;
    this.#ws.send(JSON.stringify({ t: type, k: tokens.join("#") }));
  }

  #startHeartbeat() {
    clearInterval(this.#heartbeat);
    this.#heartbeat = setInterval(() => {
      if (this.#ws?.readyState === WebSocket.OPEN) {
        this.#ws.send(JSON.stringify({ t: "h", k: "" }));
      }
    }, HEARTBEAT_MS);
  }

  #scheduleReconnect() {
    if (this.#reconnect || this.#closing || this.#paused) return;
    const delay = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)];
    this.#attempt += 1;
    console.log(`[upstream] reconnecting in ${delay / 1000}s`);
    this.#reconnect = setTimeout(() => {
      this.#reconnect = null;
      this.connect();
    }, delay);
  }

  #teardown() {
    clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    this.#authed = false;
    this.#ws = null;
  }

  /** Used by the idle timer, and on shutdown. Keeps `#wanted` intact. */
  disconnect() {
    clearTimeout(this.#reconnect);
    this.#reconnect = null;
    const ws = this.#ws;
    this.#teardown();
    ws?.close();
  }

  /**
   * Hold the session closed until resumed. Distinct from `disconnect()`, which
   * the reconnect loop is free to undo - outside the daily window the hub must
   * stay off the account entirely, because only one session may hold it.
   */
  pause() {
    if (this.#paused) return;
    this.#paused = true;
    this.disconnect();
  }

  resume() {
    if (!this.#paused) return;
    this.#paused = false;
    this.#attempt = 0;
    this.connect();
  }

  get paused() {
    return this.#paused;
  }

  shutdown() {
    this.#closing = true;
    this.disconnect();
  }
}
