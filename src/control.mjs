import { readFileSync, writeFileSync } from "node:fs";
import { config } from "./config.mjs";

/**
 * Manual override of the upstream connection.
 *
 * Three modes, and the point of the whole file is that two of them outrank
 * everything else:
 *
 *   auto - the daily window decides (the normal state)
 *   on   - hold the session open regardless of the window
 *   off  - stay off the account entirely
 *
 * `off` is a safeguard, so nothing may quietly undo it: not the schedule, not a
 * reconnect, and not a visitor subscribing to a price on the website. A kill
 * switch that traffic can override is not a kill switch.
 *
 * The mode is written to disk because a restart must not silently reconnect an
 * account someone deliberately took offline - that is precisely the moment the
 * safeguard matters. Mount a volume for it, or a recreated container comes back
 * on `auto`.
 */

export const MODES = ["auto", "on", "off"];

let mode = "auto";
let changedAt = null;

function persist() {
  if (!config.stateFile) return;
  try {
    writeFileSync(config.stateFile, JSON.stringify({ mode, changedAt }), "utf8");
  } catch (error) {
    console.warn(`[control] could not save mode: ${error.message}`);
  }
}

export function loadMode() {
  if (!config.stateFile) return mode;
  try {
    const saved = JSON.parse(readFileSync(config.stateFile, "utf8"));
    if (MODES.includes(saved?.mode)) {
      mode = saved.mode;
      changedAt = saved.changedAt ?? null;
      if (mode !== "auto") {
        console.log(`[control] restored manual mode "${mode}" from ${config.stateFile}`);
      }
    }
  } catch {
    // No state yet, or it is unreadable; auto is the right default either way.
  }
  return mode;
}

export const getMode = () => mode;

export function setMode(next) {
  if (!MODES.includes(next)) throw new Error(`unknown mode: ${next}`);
  mode = next;
  changedAt = Date.now();
  persist();
  return mode;
}

export const controlState = () => ({ mode, changedAt });
