import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { config } from "./config.mjs";

/**
 * Dashboard login.
 *
 * A username and password from the environment, exchanged for a signed cookie.
 * No session store: the cookie carries its own expiry and an HMAC over it, so a
 * restart does not sign everyone out and there is nothing to keep in memory.
 *
 * The signing key is derived from the credentials themselves, which means
 * changing the password invalidates every outstanding session for free.
 *
 * This guards the monitoring surface only. The price feed stays open, because
 * the website's visitors are anonymous by definition - what is protected here
 * is the view of what the feed is carrying and who is watching it.
 */

const COOKIE = "hub_session";
const MAX_AGE_SECONDS = 12 * 60 * 60;

export const authEnabled = () => Boolean(config.dashboardUser && config.dashboardPassword);

const signingKey = () =>
  createHmac("sha256", "gopocket-feed-hub")
    .update(`${config.dashboardUser}:${config.dashboardPassword}`)
    .digest();

const sign = (payload) => createHmac("sha256", signingKey()).update(payload).digest("base64url");

/** Constant-time compare that tolerates length differences. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    // Still compare something, so the timing does not leak the length.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function checkLogin(username, password) {
  if (!authEnabled()) return false;
  // Both compared, always, so a wrong username costs the same as a wrong password.
  const userOk = safeEqual(username || "", config.dashboardUser);
  const passOk = safeEqual(password || "", config.dashboardPassword);
  return userOk && passOk;
}

export function issueSession() {
  const payload = `${Date.now() + MAX_AGE_SECONDS * 1000}.${randomBytes(8).toString("base64url")}`;
  return `${payload}.${sign(payload)}`;
}

export function isValidSession(value) {
  if (!value) return false;
  const index = value.lastIndexOf(".");
  if (index < 1) return false;

  const payload = value.slice(0, index);
  const signature = value.slice(index + 1);
  if (!safeEqual(signature, sign(payload))) return false;

  const expiry = Number.parseInt(payload.split(".")[0], 10);
  return Number.isFinite(expiry) && Date.now() < expiry;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

/** True when the request may see the monitoring data. */
export function isAuthorised(req) {
  if (!authEnabled()) return true;
  return isValidSession(parseCookies(req.headers.cookie)[COOKIE]);
}

export function sessionCookie(req) {
  // Only mark Secure behind TLS, or the cookie is dropped on a plain-HTTP LAN
  // address and the login silently fails to stick.
  const https = req.headers["x-forwarded-proto"] === "https";
  return [
    `${COOKIE}=${issueSession()}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${MAX_AGE_SECONDS}`,
    https ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export const clearedCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
