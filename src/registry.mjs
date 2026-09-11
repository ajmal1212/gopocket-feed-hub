/** Fields only a depth subscription keeps current - see `stripDepth()`. */
const DEPTH_ONLY = /^(?:[bs][pq][2-5]|[bs]o[1-5]|tbq|tsq|ltq|ltt)$/;

/**
 * Who is watching what, and the last known state of everything watched.
 *
 * This is the same register/unregister/union bookkeeping the trading app does
 * inside its React context, moved up one level: here a "watcher" is a browser
 * connection rather than a component, and the union is what the single upstream
 * connection subscribes to.
 */
export class Registry {
  /** token -> Set<watcher> */
  #watchers = new Map();
  /** token -> merged tick, so a new watcher gets a price immediately. */
  #cache = new Map();

  /** Returns the tokens that nobody was watching until now. */
  add(watcher, tokens) {
    const fresh = [];
    for (const token of tokens) {
      let set = this.#watchers.get(token);
      if (!set) {
        set = new Set();
        this.#watchers.set(token, set);
        fresh.push(token);
      }
      set.add(watcher);
    }
    return fresh;
  }

  /** Returns the tokens that no longer have any watcher. */
  remove(watcher, tokens) {
    const dropped = [];
    for (const token of tokens) {
      const set = this.#watchers.get(token);
      if (!set) continue;
      set.delete(watcher);
      if (set.size === 0) {
        this.#watchers.delete(token);
        dropped.push(token);
      }
    }
    return dropped;
  }

  removeWatcher(watcher) {
    return this.remove(watcher, [...this.#watchers.keys()]);
  }

  watchersOf(token) {
    return this.#watchers.get(token);
  }

  get watchedCount() {
    return this.#watchers.size;
  }

  /** Every token currently wanted, with how many watchers each has. */
  watchedTokens() {
    return [...this.#watchers.entries()].map(([token, set]) => ({
      token,
      watchers: set.size,
    }));
  }

  /**
   * Merge a `tk` snapshot or `tf` delta into the cache and return the merged
   * record. `tf` carries only changed fields, so anything absent must survive.
   */
  merge(token, packet) {
    const previous = this.#cache.get(token) || { k: token };
    const merged = { ...previous };
    for (const [field, value] of Object.entries(packet)) {
      if (field === "t" || value === null || value === undefined || value === "") continue;
      merged[field] = value;
    }
    merged.k = token;
    this.#cache.set(token, merged);
    return merged;
  }

  /**
   * Forget the depth a token no longer has anyone watching.
   *
   * Touchline keeps refreshing the best bid and ask (level 1), but levels 2-5,
   * the order counts, the totals and the last trade would freeze at whatever
   * they were when depth stopped - and a later snapshot would hand them out as
   * if they were current. The 52-week range and circuit limits stay: they hold
   * for the whole day, and a stock page is better off rendering them from
   * cache than waiting for the socket.
   */
  stripDepth(token) {
    const tick = this.#cache.get(token);
    if (!tick) return;
    for (const field of Object.keys(tick)) {
      if (DEPTH_ONLY.test(field)) delete tick[field];
    }
  }

  snapshot(tokens) {
    const out = {};
    for (const token of tokens) {
      const tick = this.#cache.get(token);
      if (tick) out[token] = tick;
    }
    return out;
  }

  /**
   * Cached prices outlive their watchers on purpose: an SSR render at 3am
   * should still be able to put yesterday's close in the HTML.
   */
  cached(token) {
    return this.#cache.get(token);
  }
}
