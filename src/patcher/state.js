// Reads/writes the xirp-antigravity state marker at ~/.xirp-antigravity/state.json,
// which records what was patched and with what hashes so `apply`/`remove`/`status`
// can detect drift (e.g. Xirp updated since the last apply).

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, chownSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Directory holding the state marker. Injectable for tests via `home`.
 */
export function stateDir(home = os.homedir()) {
  return path.join(home, ".xirp-antigravity");
}

export function stateFilePath(home = os.homedir()) {
  return path.join(stateDir(home), "state.json");
}

/**
 * Read the state marker, or null if none exists.
 */
export function readState(home = os.homedir()) {
  const file = stateFilePath(home);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Corrupt xirp-antigravity state file at ${file}: ${err.message}`);
  }
}

/**
 * Write the state marker, creating ~/.xirp-antigravity if needed.
 * `state` shape: { xirpVersion, chunkPath, chunkSha256Original,
 * chunkSha256Patched, harnessSha256, patchVersion, appliedAt, origOwnedByUs }
 */
// When run under sudo (needed on macOS because of App Management protection),
// keep the state marker owned by the invoking user so later unprivileged
// `status`/`doctor` runs and future applies can still read and replace it.
function chownToSudoUser(p) {
  const uid = Number(process.env.SUDO_UID);
  const gid = Number(process.env.SUDO_GID);
  if (process.getuid?.() !== 0 || !Number.isInteger(uid) || uid <= 0) return;
  try {
    chownSync(p, uid, Number.isInteger(gid) && gid >= 0 ? gid : -1);
  } catch (err) {
    process.stderr.write(`warning: could not chown ${p} to uid ${uid}: ${err.message}\n`);
  }
}

export function writeState(state, home = os.homedir()) {
  const dir = stateDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(stateFilePath(home), JSON.stringify(state, null, 2) + "\n", "utf8");
  chownToSudoUser(dir);
  chownToSudoUser(stateFilePath(home));
  return state;
}

/**
 * Delete the state marker, if present. No-op if it doesn't exist.
 */
export function clearState(home = os.homedir()) {
  const file = stateFilePath(home);
  if (existsSync(file)) rmSync(file);
}
