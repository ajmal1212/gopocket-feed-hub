/**
 * What the hub is doing right now, for the monitoring dashboard.
 *
 * Everything here is in memory and deliberately bounded - a monitoring surface
 * that grows without limit is a leak with a nice UI. Rates are counted into
 * one-second buckets over a rolling minute, which is enough to draw a live
 * sparkline and cheap enough to update on every tick.
 */

const WINDOW_SECONDS = 60;
const RECENT_TICKS = 40;
const TOP_TOKENS = 12;

const nowSecond = () => Math.floor(Date.now() / 1000);

class RollingRate {
  #buckets = new Map();

  add(count = 1) {
    const second = nowSecond();
    this.#buckets.set(second, (this.#buckets.get(second) || 0) + count);
    this.#prune(second);
  }

  #prune(second) {
    for (const key of this.#buckets.keys()) {
      if (key <= second - WINDOW_SECONDS) this.#buckets.delete(key);
    }
  }

  /** One value per second, oldest first, zero-filled so the chart has no gaps. */
  series() {
    const second = nowSecond();
    this.#prune(second);
    const out = [];
    for (let s = second - WINDOW_SECONDS + 1; s <= second; s++) {
      out.push(this.#buckets.get(s) || 0);
    }
    return out;
  }

  /** Excludes the second in progress, which is always partial. */
  perSecond() {
    const series = this.series().slice(0, -1);
    if (series.length === 0) return 0;
    return series.reduce((a, b) => a + b, 0) / series.length;
  }
}

export class Metrics {
  startedAt = Date.now();

  upstream = {
    connected: false,
    since: null,
    reconnects: 0,
    /** Times another session took the account away from us. */
    displacements: 0,
    lastTickAt: null,
  };

  clients = { current: 0, peak: 0, totalEver: 0 };

  ticks = new RollingRate();
  broadcasts = new RollingRate();

  totals = { ticks: 0, broadcasts: 0 };

  #recent = [];
  #perToken = new Map();

  upstreamStatus(connected, { displaced = false } = {}) {
    if (connected) {
      this.upstream.connected = true;
      this.upstream.since = Date.now();
      this.upstream.reconnects += 1;
    } else {
      this.upstream.connected = false;
      this.upstream.since = null;
      if (displaced) this.upstream.displacements += 1;
    }
  }

  clientOpened() {
    this.clients.current += 1;
    this.clients.totalEver += 1;
    this.clients.peak = Math.max(this.clients.peak, this.clients.current);
  }

  clientClosed() {
    this.clients.current = Math.max(0, this.clients.current - 1);
  }

  /** One tick as it arrives from upstream, already merged. */
  tick(token, merged) {
    this.totals.ticks += 1;
    this.ticks.add();
    this.upstream.lastTickAt = Date.now();
    this.#perToken.set(token, (this.#perToken.get(token) || 0) + 1);

    this.#recent.unshift({
      k: token,
      ts: merged.ts || token,
      lp: merged.lp || null,
      pc: merged.pc || null,
      at: Date.now(),
    });
    if (this.#recent.length > RECENT_TICKS) this.#recent.length = RECENT_TICKS;
  }

  broadcast(count) {
    if (count <= 0) return;
    this.totals.broadcasts += count;
    this.broadcasts.add(count);
  }

  snapshot({ tokensWatched, subscribedTokens }) {
    const top = [...this.#perToken.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_TOKENS)
      .map(([token, count]) => ({ token, count }));

    return {
      at: Date.now(),
      uptimeMs: Date.now() - this.startedAt,
      upstream: {
        ...this.upstream,
        // The hub holds exactly one session by design; showing it as a count
        // makes the invariant visible rather than assumed.
        connections: this.upstream.connected ? 1 : 0,
        staleMs: this.upstream.lastTickAt ? Date.now() - this.upstream.lastTickAt : null,
      },
      clients: { ...this.clients },
      tokensWatched,
      subscribedTokens,
      rates: {
        ticksPerSecond: Number(this.ticks.perSecond().toFixed(1)),
        broadcastsPerSecond: Number(this.broadcasts.perSecond().toFixed(1)),
        tickSeries: this.ticks.series(),
      },
      totals: { ...this.totals },
      recent: this.#recent.slice(0, 20),
      topTokens: top,
    };
  }
}

export const metrics = new Metrics();
