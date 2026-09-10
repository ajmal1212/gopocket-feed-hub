const int = (value, fallback) => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  norenUrl: process.env.NOREN_WS_URL || "wss://skypro.skybroking.com/NorenWSWeb/",
  // Same host, HTTP side: TPSeries and the other REST calls.
  norenRestUrl: process.env.NOREN_REST_URL || "https://skypro.skybroking.com",
  // Session credentials now live in Frappe and rotate daily; these two are only
  // an override for local development against a key you already hold.
  jkey: process.env.FEED_JKEY || "",
  norenUidOverride: process.env.NOREN_UID || "",

  // Frappe holds the rotating key. This token does not rotate, so it stays here.
  frappeUrl: (process.env.FRAPPE_URL || "https://pulse.gopocket.in").replace(/\/$/, ""),
  frappeToken: process.env.FRAPPE_TOKEN || "",

  // Daily connection window, IST. Runs past the equity close because MCX
  // trades into the night.
  connectAt: process.env.CONNECT_AT || "09:00",
  disconnectAt: process.env.DISCONNECT_AT || "23:45",

  // Held open for the life of the session so the feed always has a live
  // subscription: Nifty 50 ticks through every market hour.
  alwaysSubscribe: (process.env.ALWAYS_SUBSCRIBE || "NSE|26000")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean),

  port: int(process.env.PORT, 8090),
  host: process.env.HOST || "127.0.0.1",
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),

  // Dashboard login. Set both to require signing in; leave either empty and the
  // monitor is open to anyone who can reach the host.
  // Where the manual connect/kill mode is remembered across restarts.
  stateFile: process.env.STATE_FILE || "/var/lib/feed-hub/state.json",

  dashboardUser: process.env.DASHBOARD_USER || "",
  dashboardPassword: process.env.DASHBOARD_PASSWORD || "",

  maxConnectionsPerIp: int(process.env.MAX_CONNECTIONS_PER_IP, 8),
  maxTokensPerClient: int(process.env.MAX_TOKENS_PER_CLIENT, 120),
  idleDisconnectMs: int(process.env.IDLE_DISCONNECT_MS, 5 * 60 * 1000),
};
