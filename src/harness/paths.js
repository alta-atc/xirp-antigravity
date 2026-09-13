import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

/**
 * Filesystem layout of Grok Build sessions.
 *
 *   ${GROK_HOME || ~/.grok}/sessions/<bucket>/<sessionId>/
 *     chat_history.jsonl   <- canonical session file for squab
 *     summary.json
 *     updates.jsonl
 *
 * bucket = encodeURIComponent(cwd), or "<slug>-<hash>" when the encoded name
 * would exceed 255 bytes. In the long-name case Grok writes the original path
 * into a ".cwd" file inside the bucket directory, so lookups fall back to
 * scanning bucket dirs for a matching ".cwd".
 */

/** Canonical session file name. A spike may switch this to "summary.json". */
const SESSION_FILE = "chat_history.jsonl";
const SUMMARY_FILE = "summary.json";
const UPDATES_FILE = "updates.jsonl";
const CWD_MARKER_FILE = ".cwd";
const MAX_BUCKET_BYTES = 255;

function grokHome() {
  const fromEnv = process.env.GROK_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv;
  return path.join(os.homedir(), ".grok");
}

function sessionsRoot() {
  return path.join(grokHome(), "sessions");
}

/**
 * Truncate an encodeURIComponent result without splitting a %XX escape.
 * The encoded form is pure ASCII, so character length equals byte length.
 */
function truncateEncoded(encoded, maxBytes) {
  const out = encoded.slice(0, maxBytes);
  if (out.length >= 1 && out[out.length - 1] === "%") return out.slice(0, -1);
  if (out.length >= 2 && out[out.length - 2] === "%") return out.slice(0, -2);
  return out;
}

/** Directory name Grok uses for a working directory. */
function bucketName(cwd) {
  const encoded = encodeURIComponent(cwd);
  if (Buffer.byteLength(encoded) <= MAX_BUCKET_BYTES) return encoded;
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const suffix = "-" + hash;
  const slug = truncateEncoded(encoded, MAX_BUCKET_BYTES - suffix.length);
  return slug + suffix;
}

/** Synchronous best-guess bucket directory (squab calls sessionRoot unguarded). */
function bucketDirFor(cwd) {
  return path.join(sessionsRoot(), bucketName(cwd));
}

async function isDirectory(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the on-disk bucket dir for cwd, falling back to a ".cwd" scan when
 * the direct (encoded) name is absent. Returns null when nothing matches.
 */
async function resolveBucketDir(cwd) {
  const direct = bucketDirFor(cwd);
  if (await isDirectory(direct)) return direct;
  const root = sessionsRoot();
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name);
    let marker;
    try {
      marker = await fsp.readFile(path.join(candidate, CWD_MARKER_FILE), "utf-8");
    } catch {
      continue;
    }
    if (marker.trim() === cwd) return candidate;
  }
  return null;
}

function sessionDirFor(bucketDir, sessionId) {
  return path.join(bucketDir, sessionId);
}

function sessionFileIn(sessionDir) {
  return path.join(sessionDir, SESSION_FILE);
}

function summaryFileIn(sessionDir) {
  return path.join(sessionDir, SUMMARY_FILE);
}

function updatesFileIn(sessionDir) {
  return path.join(sessionDir, UPDATES_FILE);
}

/** Session dir that contains a given session file path. */
function sessionDirOf(sessionFilePath) {
  return path.dirname(sessionFilePath);
}

/** Session id implied by a session file path (the containing directory name). */
function sessionIdFromPath(sessionFilePath) {
  return path.basename(path.dirname(sessionFilePath));
}

/** List session dirs (absolute paths) inside a bucket dir. */
async function listSessionDirs(bucketDir) {
  let entries;
  try {
    entries = await fsp.readdir(bucketDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(bucketDir, e.name));
}

/** List every bucket dir under the sessions root. */
async function listBucketDirs() {
  const root = sessionsRoot();
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
}

/** Newest existing session file (by mtime) among the given session dirs. */
async function newestSessionFile(sessionDirs) {
  const stats = await Promise.all(
    sessionDirs.map(async (dir) => {
      const file = sessionFileIn(dir);
      try {
        const st = await fsp.stat(file);
        if (!st.isFile()) return null;
        return { path: file, mtime: st.mtimeMs, name: path.basename(dir) };
      } catch {
        return null;
      }
    }),
  );
  const found = stats.filter((s) => s !== null);
  if (found.length === 0) return null;
  found.sort((a, b) =>
    b.mtime !== a.mtime ? b.mtime - a.mtime : a.name < b.name ? 1 : a.name > b.name ? -1 : 0,
  );
  return found[0].path;
}

export {
  SESSION_FILE,
  SUMMARY_FILE,
  UPDATES_FILE,
  CWD_MARKER_FILE,
  MAX_BUCKET_BYTES,
  grokHome,
  sessionsRoot,
  bucketName,
  bucketDirFor,
  resolveBucketDir,
  sessionDirFor,
  sessionFileIn,
  summaryFileIn,
  updatesFileIn,
  sessionDirOf,
  sessionIdFromPath,
  listSessionDirs,
  listBucketDirs,
  newestSessionFile,
  isDirectory,
};
