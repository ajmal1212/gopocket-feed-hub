import { config } from "./config.mjs";

/**
 * When the hub should hold a session open.
 *
 * The window is a daily one - open at 09:00, close at 23:45 IST by default -
 * rather than driven by whether anyone is watching. Two reasons: the account
 * allows exactly one live session, so reconnecting on demand risks colliding
 * with whatever else might be starting up; and the window has to run past the
 * equity close because MCX trades into the night.
 *
 * Everything here is computed in IST explicitly. The container's clock is UTC
 * and its timezone database is not something to depend on for a market that
 * runs on a fixed local schedule.
 */

const IST_OFFSET = 5.5 * 60 * 60;
const DAY = 24 * 60 * 60;

/** "09:00" -> seconds past midnight IST. */
function parseTime(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return fallback;
  return hours * 3600 + minutes * 60;
}

export const OPEN_AT = parseTime(config.connectAt, 9 * 3600);
export const CLOSE_AT = parseTime(config.disconnectAt, 23 * 3600 + 45 * 60);

/** Seconds past midnight IST for a given epoch. */
const istSeconds = (epoch) => (((epoch + IST_OFFSET) % DAY) + DAY) % DAY;

export function isWindowOpen(epoch = Math.floor(Date.now() / 1000)) {
  const now = istSeconds(epoch);
  // A window that wraps past midnight is still one window.
  return CLOSE_AT > OPEN_AT ? now >= OPEN_AT && now < CLOSE_AT : now >= OPEN_AT || now < CLOSE_AT;
}

/** Human-readable state, for the dashboard and the logs. */
export function windowState(epoch = Math.floor(Date.now() / 1000)) {
  const now = istSeconds(epoch);
  const open = isWindowOpen(epoch);
  const target = open ? CLOSE_AT : OPEN_AT;
  let seconds = target - now;
  if (seconds <= 0) seconds += DAY;

  const hhmm = (value) =>
    String(Math.floor(value / 3600)).padStart(2, "0") + ":" + String(Math.floor((value % 3600) / 60)).padStart(2, "0");

  return {
    open,
    opensAt: hhmm(OPEN_AT),
    closesAt: hhmm(CLOSE_AT),
    secondsToChange: seconds,
  };
}
