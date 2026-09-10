import { config } from "./config.mjs";

/**
 * The feed session key and account, read from Frappe.
 *
 * The key is regenerated there every morning around 08:15, so the hub must not
 * hold one from boot - it reads a fresh pair on every connect, which is also
 * what makes an expired key self-healing: authentication fails, the socket
 * closes, and the reconnect picks up whatever Frappe has by then.
 *
 * The Frappe API token, by contrast, is long-lived and stays in the
 * environment. It is the one credential that does not rotate.
 */

const DOCTYPE = "Website live price";
const TIMEOUT_MS = 8000;

/**
 * A reconnect loop can fire several times a minute; this keeps that from
 * becoming several requests a minute to Frappe, while still being far shorter
 * than the daily rotation it has to notice.
 */
const CACHE_MS = 60_000;

let cached = null;

export async function getCredentials({ force = false } = {}) {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  // Local development can still short-circuit Frappe entirely.
  if (config.jkey && config.norenUidOverride) {
    return { jkey: config.jkey, uid: config.norenUidOverride };
  }

  if (!config.frappeUrl || !config.frappeToken) {
    throw new Error("FRAPPE_URL and FRAPPE_TOKEN are required to read the feed credentials");
  }

  const path = `/api/resource/${encodeURIComponent(DOCTYPE)}/${encodeURIComponent(DOCTYPE)}`;
  const response = await fetch(`${config.frappeUrl}${path}`, {
    headers: { Authorization: `token ${config.frappeToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`frappe ${response.status} reading ${DOCTYPE}`);

  const body = await response.json();
  const jkey = body?.data?.jkey;
  const uid = body?.data?.uid;

  if (!jkey || !uid) throw new Error(`${DOCTYPE} has no jkey/uid`);

  const value = { jkey, uid, modified: body.data.modified };
  cached = { at: Date.now(), value };
  return value;
}

/** Called when the feed rejects a key, so the next attempt re-reads Frappe. */
export function invalidateCredentials() {
  cached = null;
}
