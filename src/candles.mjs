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
const EOD_PATH = "/NorenWClientWeb/EODChartData";
const TIMEOUT_MS = 15_000;

/** Minutes per candle, as the upstream accepts them. 60 is the hourly. */
export const INTERVALS = [1, 2, 3, 4, 5, 10, 15, 30, 45, 60];

/** Daily candles come from a different endpoint, so they get their own name. */
export const DAILY = "day";

/**
 * Daily candles are closed history - yesterday's bar will never change - so
 * they are held far longer than intraday. The current day is absent from the
 * response anyway; the live feed supplies today.
 */
const DAILY_TTL_MS = 15 * 60 * 1000;

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
  return interval === DAILY || INTERVALS.includes(Number(interval));
}

/**
 * Daily candles, from EODChartData.
 *
 * Two things differ from TPSeries and both bite silently. It is keyed by
 * `EXCHANGE:TRADING_SYMBOL` - "NSE:HDFCBANK-EQ" - and a numeric token returns
 * an empty array rather than an error, so a caller passing the feed token gets
 * a blank chart and no clue why. And each element of the array is a JSON
 * *string*, not an object, so every row needs parsing on its own.
 *
 * Indices are not covered: "NSE:NIFTY 50" returns empty. An index page has no
 * daily history to draw from this source.
 */
async function fetchDaily({ exch, symbol, from, to }) {
  if (!symbol) throw new Error("daily candles need a trading symbol");

  const cacheKey = `${exch}:${symbol}|day|${from}|${to}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < DAILY_TTL_MS) return hit.candles;

  const jKey = await getFreshKey();
  if (!jKey) throw new Error("no session key");

  const jData = JSON.stringify({ sym: `${exch}:${symbol}`, from, to });

  const response = await fetch(`${config.norenRestUrl}${EOD_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `jData=${jData}&jKey=${jKey}`,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`upstream ${response.status}`);

  const body = await response.json();
  if (!Array.isArray(body)) throw new Error(body?.emsg || "upstream error");

  const candles = body
    .map((row) => {
      try {
        return typeof row === "string" ? JSON.parse(row) : row;
      } catch {
        return null;
      }
    })
    .filter((row) => row?.ssboe)
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
  return candles;
}

/**
 * Fetch one series. `from` and `to` are epoch seconds.
 *
 * Returns candles oldest-first as `{ t, o, h, l, c, v }`, where `t` is epoch
 * seconds and `v` is the volume traded within the candle, not the day's
 * running total.
 */
export async function fetchCandles({ key, interval, from, to, symbol }) {
  const parts = splitKey(key);
  if (!parts) throw new Error("bad token");
  if (!isValidInterval(interval)) throw new Error("bad interval");

  if (interval === DAILY) {
    return fetchDaily({ exch: parts.exch, symbol, from, to });
  }

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
