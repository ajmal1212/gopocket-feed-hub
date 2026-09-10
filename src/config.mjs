import { readFileSync } from "node:fs";

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  norenUrl: process.env.NOREN_WS_URL || "wss://skypro.skybroking.com/NorenWSWeb/",
  // Same host, HTTP side: TPSeries and the other REST calls.
  norenRestUrl: process.env.NOREN_REST_URL || "https://skypro.skybroking.com",
  norenUid: process.env.NOREN_UID || "",
  jkey: process.env.FEED_JKEY || "",
  keyFile: process.env.KEY_FILE || "",

  port: int(process.env.PORT, 8090),
  host: process.env.HOST || "127.0.0.1",
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),

  // Set to require ?key=... on the dashboard. Worth setting the moment the
  // hub is reachable by anyone but you.
  dashboardToken: process.env.DASHBOARD_TOKEN || "",

  maxConnectionsPerIp: int(process.env.MAX_CONNECTIONS_PER_IP, 8),
  maxTokensPerClient: int(process.env.MAX_TOKENS_PER_CLIENT, 120),
  idleDisconnectMs: int(process.env.IDLE_DISCONNECT_MS, 5 * 60 * 1000),
};

/**
 * The session key rotates daily. Reading it fresh on every connect - rather
 * than once at boot - means whatever mints the key can drop a new one in
 * KEY_FILE and the hub picks it up on its next reconnect, no restart needed.
 *
 * When the key eventually comes from Frappe, this is the only function that
 * changes: make it an async fetch and the rest of the hub is unaffected.
 */
export async function getFreshKey() {
  if (config.keyFile) {
    return readFileSync(config.keyFile, "utf8").trim();
  }
  return config.jkey;
}
