import { config, getFreshKey } from "./config.mjs";

/**
 * Historical candles, from Noren's TPSeries.
 *
 * This lives in the hub rather than in Frappe because TPSeries authenticates
 * with the same session key the hub already holds and refreshes daily, and
 * because its `{exch, token}` pair is exactly the `EXCHANGE|TOKEN` the live feed
 * uses - `NSE|1333` needs no translation. Keeping both halves here means the
 * site has one market-data boundary and one credential to rotate.
 *
 * Two things about the upstream that shape the code below:
 *
 * - `jData` must NOT be URL-encoded. Encoding it earns
 *   "Invalid Input : jData is not valid json object", which reads like a
 *   malformed payload and is really just percent-escaping.
 * - Rows come back newest-first, and the first row is the candle still forming.
 *   Charts want oldest-first, and that forming candle is the only row that can
 *   change - which is what makes the rest of the series safe to cache.
 */

const TPSERIES_PATH = "/NorenWClientWeb/TPSeries";
const TIMEOUT_MS = 15_000;

/** Minutes per candle, as the upstream accepts them. 60 is the hourly. */
export const INTERVALS = [1, 2, 3, 4, 5, 10, 15, 30, 45, 60];

/**
 * A closed candle is immutable, so the only reason to refetch is the one still
 * forming. Half a minute keeps a busy page cheap without letting the newest
 * candle go visibly stale - and the live feed moves the last price meanwhile.
 */
const CACHE_TTL_MS = 30_000;
const cache = new Map();

const num = (value) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** "NSE|1333" -> { exch: "NSE", token: "1333" } */
export function splitKey(key) {
  const [exch, token] = String(key).split("|");
  if (!exch || !token) return null;
  return { exch, token };
}

export function isValidInterval(interval) {
  return INTERVALS.includes(Number(interval));
}

/**
 * Fetch one series. `from` and `to` are epoch seconds.
 *
 * Returns candles oldest-first as `{ t, o, h, l, c, v }`, where `t` is epoch
 * seconds and `v` is the volume traded within the candle, not the day's
 * running total.
 */
export async function fetchCandles({ key, interval, from, to }) {
  const parts = splitKey(key);
  if (!parts) throw new Error("bad token");
  if (!isValidInterval(interval)) throw new Error("bad interval");

  const cacheKey = `${key}|${interval}|${from}|${to}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.candles;

  const jKey = await getFreshKey();
  if (!jKey) throw new Error("no session key");

  const jData = JSON.stringify({
    uid: config.norenUid,
    exch: parts.exch,
    token: parts.token,
    st: String(from),
    et: String(to),
    intrv: String(interval),
  });

  const response = await fetch(`${config.norenRestUrl}${TPSERIES_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    // Deliberately assembled by hand: URLSearchParams would percent-encode
    // jData, which the upstream rejects.
    body: `jData=${jData}&jKey=${jKey}`,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`upstream ${response.status}`);

  const body = await response.json();

  // An error comes back as an object, a series as an array.
  if (!Array.isArray(body)) {
    throw new Error(body?.emsg || "upstream error");
  }

  const candles = body
    .filter((row) => row?.stat === "Ok" && row.ssboe)
    .map((row) => ({
      t: Number.parseInt(row.ssboe, 10),
      o: num(row.into),
      h: num(row.inth),
      l: num(row.intl),
      c: num(row.intc),
      v: num(row.intv) ?? 0,
    }))
    .filter((candle) => candle.o !== null && candle.c !== null)
    .sort((a, b) => a.t - b.t);

  cache.set(cacheKey, { at: Date.now(), candles });

  // The cache is keyed by window, and a page that keeps moving its window would
  // otherwise grow it without limit.
  if (cache.size > 500) {
    for (const [k, v] of cache) {
      if (Date.now() - v.at > CACHE_TTL_MS) cache.delete(k);
    }
  }

  return candles;
}
