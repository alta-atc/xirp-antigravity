import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Filesystem layout of Google's Antigravity CLI (`agy`).
 *
 *   ${ANTIGRAVITY_CLI_HOME || ANTIGRAVITY_HOME || ~/.gemini/antigravity-cli}/
 *     brain/<conversation-uuid>/
 *       .system_generated/logs/transcript_full.jsonl  <- session file for squab
 *       .system_generated/logs/transcript.jsonl       (truncated sibling)
 *     cache/last_conversations.json        { "<abs cwd>": "<conversation-uuid>" }
 *     cache/conversation_metadata.json     { conversations: { <id>: { summary } } }
 *     settings.json                        global CLI settings (model, ...)
 *
 * Conversations are global, not per-cwd: the brain/ directory is flat and the
 * cwd -> conversation mapping lives only in cache/last_conversations.json
 * (rewritten on every launch) and in the WorkspaceURIs of
 * cache/conversation_metadata.json (refreshed only when the TUI lists
 * conversations, so it lags).
 *
 * A second, xirp-owned tree holds "handoff pseudo-sessions" -- transcripts
 * xirp renders for agy to read on a seeded launch, since agy conversations
 * cannot be fabricated on disk (see adapter.js):
 *
 *   ${XIRP_ANTIGRAVITY_HOME || ~/.xirp-antigravity}/handoff/<sessionId>/
 *     transcript.md            human/agent readable rendering
 *     transcript_full.jsonl    same step shape as agy, so the readers above work
 *     session.json             { id, cwd, createdAt, source }
 */

/** Canonical session file name inside a conversation's log directory. */
const TRANSCRIPT_FILE = "transcript_full.jsonl";
/** Truncated sibling agy also writes. Never used as the session file. */
const TRUNCATED_TRANSCRIPT_FILE = "transcript.jsonl";
const LOGS_DIR_NAME = "logs";
const SYSTEM_GENERATED_DIR_NAME = ".system_generated";
const BRAIN_DIR_NAME = "brain";
const CACHE_DIR_NAME = "cache";
const LAST_CONVERSATIONS_FILE = "last_conversations.json";
const CONVERSATION_METADATA_FILE = "conversation_metadata.json";
const SETTINGS_FILE = "settings.json";

const HANDOFF_DIR_NAME = "handoff";
const HANDOFF_MARKDOWN_FILE = "transcript.md";
const HANDOFF_SESSION_FILE = "session.json";

/** AppDataDir values that mark a conversation as belonging to the CLI. */
const CLI_APP_DATA_DIRS = new Set(["antigravity-cli", ""]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Root of agy's state.
 *
 * ANTIGRAVITY_CLI_HOME is the primary override; ANTIGRAVITY_HOME is accepted
 * as an alias so the repo's shared test helper can point every consumer at a
 * temporary tree with one variable.
 */
function agyHome() {
  for (const name of ["ANTIGRAVITY_CLI_HOME", "ANTIGRAVITY_HOME"]) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value;
  }
  return path.join(os.homedir(), ".gemini", "antigravity-cli");
}

/** Root of the xirp-owned handoff tree. */
function handoffHome() {
  const fromEnv = process.env.XIRP_ANTIGRAVITY_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv;
  return path.join(os.homedir(), ".xirp-antigravity");
}

function handoffRoot() {
  return path.join(handoffHome(), HANDOFF_DIR_NAME);
}

function handoffDir(sessionId) {
  return path.join(handoffRoot(), sessionId);
}

function handoffTranscriptFile(sessionId) {
  return path.join(handoffDir(sessionId), TRANSCRIPT_FILE);
}

function handoffMarkdownFile(sessionId) {
  return path.join(handoffDir(sessionId), HANDOFF_MARKDOWN_FILE);
}

function handoffSessionFile(sessionId) {
  return path.join(handoffDir(sessionId), HANDOFF_SESSION_FILE);
}

/** True when a session file path belongs to a handoff pseudo-session. */
function isHandoffTranscriptPath(sessionFilePath) {
  if (typeof sessionFilePath !== "string" || !sessionFilePath) return false;
  const root = path.resolve(handoffRoot());
  const resolved = path.resolve(sessionFilePath);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function brainDir() {
  return path.join(agyHome(), BRAIN_DIR_NAME);
}

function conversationDir(conversationId) {
  return path.join(brainDir(), conversationId);
}

/** Log directory inside a conversation dir. */
function logsDirIn(conversationDirPath) {
  return path.join(conversationDirPath, SYSTEM_GENERATED_DIR_NAME, LOGS_DIR_NAME);
}

/** Session file inside a conversation dir. */
function transcriptFileIn(conversationDirPath) {
  return path.join(logsDirIn(conversationDirPath), TRANSCRIPT_FILE);
}

function transcriptFileFor(conversationId) {
  return transcriptFileIn(conversationDir(conversationId));
}

/**
 * Conversation (or handoff session) id implied by a transcript path.
 *
 * Real agy: <brain>/<id>/.system_generated/logs/transcript_full.jsonl
 * Handoff:  <handoffRoot>/<id>/transcript_full.jsonl
 */
function conversationIdFromPath(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return "";
  const dir = path.dirname(transcriptPath);
  if (path.basename(dir) === LOGS_DIR_NAME) {
    return path.basename(path.dirname(path.dirname(dir)));
  }
  return path.basename(dir);
}

function cacheDir() {
  return path.join(agyHome(), CACHE_DIR_NAME);
}

function lastConversationsFile() {
  return path.join(cacheDir(), LAST_CONVERSATIONS_FILE);
}

function metadataFile() {
  return path.join(cacheDir(), CONVERSATION_METADATA_FILE);
}

function settingsFile() {
  return path.join(agyHome(), SETTINGS_FILE);
}

async function isDirectory(candidate) {
  try {
    return (await fsp.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(candidate) {
  try {
    return (await fsp.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/** Conversation ids that have a directory under brain/. */
async function listConversationIds() {
  let entries;
  try {
    entries = await fsp.readdir(brainDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/** Absolute conversation dirs under brain/. */
async function listConversationDirs() {
  return (await listConversationIds()).map((id) => conversationDir(id));
}

/** Handoff pseudo-session ids. */
async function listHandoffIds() {
  let entries;
  try {
    entries = await fsp.readdir(handoffRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * Newest existing transcript (by mtime) among the given transcript paths.
 * Ties break on the id descending, so the result is stable across runs.
 */
async function newestTranscript(transcriptPaths) {
  const stats = await Promise.all(
    transcriptPaths.map(async (file) => {
      try {
        const stat = await fsp.stat(file);
        if (!stat.isFile()) return null;
        return { path: file, mtime: stat.mtimeMs, id: conversationIdFromPath(file) };
      } catch {
        return null;
      }
    }),
  );
  const found = stats.filter((entry) => entry !== null);
  if (found.length === 0) return null;
  found.sort((a, b) =>
    b.mtime !== a.mtime ? b.mtime - a.mtime : a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
  );
  return found[0].path;
}

/** Decode a "file:///abs/path" workspace URI to an absolute path. */
function pathFromFileUri(uri) {
  if (typeof uri !== "string" || !uri.startsWith("file://")) return null;
  const withoutScheme = uri.slice("file://".length);
  // agy writes host-less file URIs ("file:///Users/..."), so whatever follows
  // the scheme is already the absolute path; only percent-decoding is needed.
  try {
    return decodeURIComponent(withoutScheme) || null;
  } catch {
    return withoutScheme || null;
  }
}

export {
  TRANSCRIPT_FILE,
  TRUNCATED_TRANSCRIPT_FILE,
  BRAIN_DIR_NAME,
  HANDOFF_MARKDOWN_FILE,
  HANDOFF_SESSION_FILE,
  CLI_APP_DATA_DIRS,
  UUID_PATTERN,
  agyHome,
  handoffHome,
  handoffRoot,
  handoffDir,
  handoffTranscriptFile,
  handoffMarkdownFile,
  handoffSessionFile,
  isHandoffTranscriptPath,
  brainDir,
  conversationDir,
  logsDirIn,
  transcriptFileIn,
  transcriptFileFor,
  conversationIdFromPath,
  cacheDir,
  lastConversationsFile,
  metadataFile,
  settingsFile,
  isDirectory,
  isFile,
  listConversationIds,
  listConversationDirs,
  listHandoffIds,
  newestTranscript,
  pathFromFileUri,
};
