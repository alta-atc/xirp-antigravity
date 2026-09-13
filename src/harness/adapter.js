import fsp from "node:fs/promises";
import path from "node:path";

import {
  SESSION_FILE,
  CWD_MARKER_FILE,
  MAX_BUCKET_BYTES,
  grokHome,
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
} from "./paths.js";

import {
  EPOCH_ZERO,
  isPlainObject,
  asString,
  emptyUsage,
  addUsage,
  inspectHistory,
  buildTimeline,
  emptyTimeline,
  historyToMessages,
  messagesToHistory,
  toParsedMessages,
  applyParseOpts,
} from "./transcript.js";

import { grokHookCapabilities, grokHookScript, grokHookInstallEntry } from "./hooks.js";

const AGENT = "grok";
const PARSED_SCHEMA = "squab.session-parsed/v1";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_MODEL = "grok-4.6";
const DEFAULT_SYSTEM_PROMPT =
  "You are Grok Build, xAI's coding agent, running in the user's terminal.";
const SYSTEM_SEED_SCAN_LIMIT = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESUME_CONFLICT_FLAGS = new Set([
  "--session-id",
  "-s",
  "--resume",
  "-r",
  "-c",
  "--continue",
  "--fork-session",
]);

function fail(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

async function readTextOrNull(filePath) {
  try {
    return await fsp.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function readJsonOrNull(filePath) {
  const text = await readTextOrNull(filePath);
  if (text === null) return null;
  try {
    const value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

async function readSummaryFor(sessionFilePath) {
  return readJsonOrNull(summaryFileIn(sessionDirOf(sessionFilePath)));
}

function summaryInfo(summary) {
  return summary && isPlainObject(summary.info) ? summary.info : null;
}

async function timelineFor(sessionFilePath) {
  const text = await readTextOrNull(updatesFileIn(sessionDirOf(sessionFilePath)));
  return text === null ? emptyTimeline() : buildTimeline(text);
}

async function isFile(candidate) {
  try {
    return (await fsp.lstat(candidate)).isFile();
  } catch {
    return false;
  }
}

/**
 * Reuse the system prompt of the most recently touched real Grok session so a
 * handed-off transcript keeps Grok's own instructions. Falls back to a short
 * generic prompt when no session exists yet.
 */
async function seedSystemPrompt() {
  const candidates = [];
  for (const bucket of await listBucketDirs()) {
    for (const dir of await listSessionDirs(bucket)) {
      const file = sessionFileIn(dir);
      try {
        const stat = await fsp.stat(file);
        if (stat.isFile()) candidates.push({ path: file, mtime: stat.mtimeMs });
      } catch {
        /* ignore unreadable session dirs */
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const candidate of candidates.slice(0, SYSTEM_SEED_SCAN_LIMIT)) {
    const text = await readTextOrNull(candidate.path);
    if (!text) continue;
    const firstLine = text.split("\n", 1)[0];
    try {
      const parsed = JSON.parse(firstLine);
      if (isPlainObject(parsed) && parsed.type === "system" && typeof parsed.content === "string") {
        return parsed.content;
      }
    } catch {
      /* not a system line; try the next session */
    }
  }
  return DEFAULT_SYSTEM_PROMPT;
}

/** Ensure a long-path bucket dir carries the ".cwd" marker Grok looks for. */
async function ensureCwdMarker(bucketDir, cwd) {
  if (Buffer.byteLength(encodeURIComponent(cwd)) <= MAX_BUCKET_BYTES) return;
  const marker = path.join(bucketDir, CWD_MARKER_FILE);
  try {
    await fsp.writeFile(marker, `${cwd}\n`, { mode: FILE_MODE });
  } catch {
    /* best effort: the direct bucket name still resolves */
  }
}

async function writeSessionFiles(bucketDir, cwd, sessionId, messages) {
  const sessionDir = sessionDirFor(bucketDir, sessionId);
  await fsp.mkdir(sessionDir, { recursive: true, mode: DIR_MODE });
  await ensureCwdMarker(bucketDir, cwd);

  const now = new Date().toISOString();
  const historyLines = messagesToHistory(messages, { modelId: DEFAULT_MODEL });
  const summary = {
    info: { id: sessionId, cwd },
    session_summary: "",
    created_at: now,
    updated_at: now,
    last_active_at: now,
    num_messages: 0,
    num_chat_messages: historyLines.length,
    current_model_id: DEFAULT_MODEL,
    chat_format_version: 1,
    grok_home: grokHome(),
    agent_name: "general-purpose",
    sandbox_profile: "off",
    reasoning_effort: "high",
  };
  const systemLine = { type: "system", content: await seedSystemPrompt() };
  const body = [systemLine, ...historyLines].map((line) => JSON.stringify(line)).join("\n");

  await fsp.writeFile(summaryFileIn(sessionDir), `${JSON.stringify(summary, null, 2)}\n`, {
    mode: FILE_MODE,
  });
  const sessionFile = sessionFileIn(sessionDir);
  await fsp.writeFile(sessionFile, `${body}\n`, { mode: FILE_MODE });
  return sessionFile;
}

const settingsCatalogItems = [
  {
    id: "config",
    label: "config.toml",
    description: "Global Grok configuration",
    scope: "global",
    format: "toml",
    path: "~/.grok/config.toml",
  },
  {
    id: "config",
    label: "config.toml",
    description: "Project Grok configuration",
    scope: "project",
    format: "toml",
    path: "<cwd>/.grok/config.toml",
  },
  {
    id: "instructions",
    label: "AGENTS.md",
    description: "Project Grok instructions",
    scope: "project",
    format: "markdown",
    path: "<cwd>/AGENTS.md",
  },
  {
    id: "hooks",
    label: "xirp.json",
    description: "Grok hook definitions installed by xirp",
    scope: "global",
    format: "json",
    path: "~/.grok/hooks/xirp.json",
  },
  {
    id: "mcp",
    label: ".mcp.json",
    description: "Project MCP server definitions",
    scope: "project",
    format: "json",
    path: "<cwd>/.mcp.json",
  },
];

const grokAdapter = {
  agent: AGENT,

  sessionRoot(cwd) {
    return bucketDirFor(cwd);
  },

  async locateLatest(cwd) {
    const bucketDir = await resolveBucketDir(cwd);
    if (!bucketDir) return null;
    return newestSessionFile(await listSessionDirs(bucketDir));
  },

  async findBySessionId(cwd, sessionId) {
    if (!sessionId) return null;
    const bucketDir = await resolveBucketDir(cwd);
    if (!bucketDir) return null;
    const candidate = sessionFileIn(sessionDirFor(bucketDir, sessionId));
    return (await isFile(candidate)) ? candidate : null;
  },

  async findImportTranscript(cwd, requestedSessionId) {
    if (!requestedSessionId) {
      const latest = await this.locateLatest(cwd);
      if (!latest) return null;
      const summary = await readSummaryFor(latest);
      const info = summaryInfo(summary);
      return {
        path: latest,
        root: sessionDirOf(latest),
        nativeSessionId: asString(info?.id) || sessionIdFromPath(latest),
        nativeCwd: asString(info?.cwd) || null,
      };
    }

    const prefix = requestedSessionId.toLowerCase();
    const matches = [];
    for (const bucketDir of await listBucketDirs()) {
      for (const sessionDir of await listSessionDirs(bucketDir)) {
        const id = path.basename(sessionDir);
        if (!id.toLowerCase().startsWith(prefix)) continue;
        const candidate = sessionFileIn(sessionDir);
        if (!(await isFile(candidate))) continue;
        matches.push({ path: candidate, root: sessionDir, nativeSessionId: id });
      }
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple grok sessions match "${requestedSessionId}"; use a longer session ID`,
      );
    }
    if (matches.length === 0) return null;
    const summary = await readSummaryFor(matches[0].path);
    const info = summaryInfo(summary);
    return { ...matches[0], nativeCwd: asString(info?.cwd) || null };
  },

  async readEmbeddedSessionId(sessionFilePath) {
    const summary = await readSummaryFor(sessionFilePath);
    const info = summaryInfo(summary);
    const fromSummary = asString(info?.id);
    if (fromSummary) return fromSummary;
    return sessionIdFromPath(sessionFilePath) || null;
  },

  async readNative(sessionFilePath) {
    const text = await readTextOrNull(sessionFilePath);
    if (text === null) return [];
    const summary = await readSummaryFor(sessionFilePath);
    const timeline = await timelineFor(sessionFilePath);
    const { messages } = historyToMessages(text, {
      timeline,
      baseTime: asString(summary?.created_at) || EPOCH_ZERO,
    });
    return messages;
  },

  async writeNative(messages, dir, cwd, sessionId) {
    return writeSessionFiles(dir, cwd, sessionId, messages);
  },

  async writeNoticeSeed(dir, cwd, sessionId, text) {
    const timestamp = new Date().toISOString();
    return writeSessionFiles(dir, cwd, sessionId, [
      { type: "user_message", text, timestamp },
    ]);
  },

  resumeArgs(sessionFilePath) {
    return ["--resume", sessionIdFromPath(sessionFilePath)];
  },

  formatResumeCommand(sessionFilePath, binary) {
    const bin = binary || "grok";
    return `${bin} --resume ${sessionIdFromPath(sessionFilePath)}`;
  },

  freshLaunchArgs(sessionId, argv) {
    const args = Array.isArray(argv) ? argv : [];
    const conflicts = args.some(
      (arg) =>
        RESUME_CONFLICT_FLAGS.has(arg) ||
        arg.startsWith("--session-id=") ||
        arg.startsWith("--resume=") ||
        arg.startsWith("--fork-session="),
    );
    // Grok's --session-id must be a UUID; squab ids are crypto.randomUUID()
    // in practice, but if a caller hands us something else, fall back to
    // squab's recency discovery instead of making grok reject the launch.
    if (conflicts || !UUID_RE.test(String(sessionId))) return [];
    return ["--session-id", sessionId];
  },

  terminateKeystrokes() {
    // Verified against grok 1.0.30 through a pty: double Ctrl-C and ctrl+q do
    // not quit the TUI, "/exit" does. Ctrl-C first cancels any running turn
    // so the slash command lands on an idle prompt.
    return [{ bytes: "\x03" }, { bytes: "/exit\r", afterMs: 150 }];
  },

  sanitize(messages) {
    return messages;
  },

  async forkNative(srcPath, newSessionId, cwd, destDir) {
    const srcDir = sessionDirOf(srcPath);
    const oldSessionId = sessionIdFromPath(srcPath);
    const destSessionDir = sessionDirFor(destDir, newSessionId);
    await fsp.mkdir(destDir, { recursive: true, mode: DIR_MODE });
    await fsp.cp(srcDir, destSessionDir, { recursive: true });
    await ensureCwdMarker(destDir, cwd);

    const summaryPath = summaryFileIn(destSessionDir);
    const summary = await readJsonOrNull(summaryPath);
    if (summary) {
      if (!isPlainObject(summary.info)) summary.info = {};
      summary.info.id = newSessionId;
      summary.info.cwd = cwd;
      await fsp.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
        mode: FILE_MODE,
      });
    }

    const updatesPath = updatesFileIn(destSessionDir);
    const updatesText = await readTextOrNull(updatesPath);
    if (updatesText !== null) {
      const rewritten = updatesText
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;
          let record;
          try {
            record = JSON.parse(trimmed);
          } catch {
            return line;
          }
          if (!isPlainObject(record) || !isPlainObject(record.params)) return line;
          if (typeof record.params.sessionId === "string") {
            record.params.sessionId = newSessionId;
          }
          const meta = record.params._meta;
          if (isPlainObject(meta) && typeof meta.eventId === "string") {
            if (oldSessionId && meta.eventId.startsWith(`${oldSessionId}-`)) {
              meta.eventId = newSessionId + meta.eventId.slice(oldSessionId.length);
            }
          }
          return JSON.stringify(record);
        })
        .join("\n");
      await fsp.writeFile(updatesPath, rewritten, { mode: FILE_MODE });
    }

    return sessionFileIn(destSessionDir);
  },

  async parseSessionFile(sessionFilePath, opts) {
    const options = opts ?? {};
    let stat;
    try {
      stat = await fsp.stat(sessionFilePath);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        throw fail(
          "SessionFileMissingError",
          `session file ${sessionFilePath} no longer exists on disk`,
        );
      }
      throw error;
    }
    if (typeof options.maxBytes === "number" && stat.size > options.maxBytes) {
      throw fail(
        "ParseFileTooLargeError",
        `session file too large: ${sessionFilePath} is ${stat.size} bytes; refusing to parse beyond ${options.maxBytes}`,
      );
    }

    const text = (await readTextOrNull(sessionFilePath)) ?? "";
    const summary = await readSummaryFor(sessionFilePath);
    const info = summaryInfo(summary);
    const timeline = await timelineFor(sessionFilePath);
    const { messages } = historyToMessages(text, {
      timeline,
      baseTime: asString(summary?.created_at) || EPOCH_ZERO,
    });
    const parsedMessages = toParsedMessages(messages);

    const totalUsage = emptyUsage();
    for (const turn of timeline.usageTurns) addUsage(totalUsage, turn);
    const latestUsage =
      timeline.usageTurns.length > 0 ? timeline.usageTurns[timeline.usageTurns.length - 1] : null;

    let model = asString(summary?.current_model_id) || null;
    if (!model) {
      for (const entry of inspectHistory(text).entries) {
        if (entry.type === "assistant" && asString(entry.model_id)) model = asString(entry.model_id);
      }
    }

    const sessionId =
      asString(info?.id) || sessionIdFromPath(sessionFilePath) || timeline.sessionId || "";
    if (!sessionId) {
      throw new Error(
        `grokAdapter.parseSessionFile: ${sessionFilePath} has no extractable sessionId`,
      );
    }

    let lastUserMessage = null;
    for (const row of parsedMessages) {
      if (row.role === "user" && row.type === "message" && row.text) {
        lastUserMessage = { text: row.text, ts: row.ts };
      }
    }

    const sessionDir = sessionDirOf(sessionFilePath);
    const sessionSummary =
      asString(summary?.session_summary) ||
      asString(summary?.generated_title) ||
      asString(summary?.last_turn_summary) ||
      null;

    return {
      schema: PARSED_SCHEMA,
      sessionId,
      agent: AGENT,
      model,
      metadataWatchPaths: [summaryFileIn(sessionDir), updatesFileIn(sessionDir)],
      summary: sessionSummary,
      lastUserMessage,
      messageCount: parsedMessages.length,
      totalUsage,
      latestUsage,
      contextWindowSize: null,
      messages: applyParseOpts(parsedMessages, options),
    };
  },

  settingsCatalog: {
    lastUpdated: "2026-09-12",
    list: () => settingsCatalogItems.map((item) => ({ ...item })),
  },

  hookCapabilities: grokHookCapabilities,
  hookScript: grokHookScript,
  hookInstallEntry: grokHookInstallEntry,
};

const grokHarnessDef = {
  flag: "--launch-grok",
  cmd: "launch-grok",
  agentName: AGENT,
  binary: "grok",
  installHint: "Install Grok Build: curl -fsSL https://x.ai/cli/install.sh | bash",
  description: "Hand the terminal over to xAI's `grok` CLI (Grok Build).",
  visibility: "public",
  lifecycle: {
    install: {
      kind: "vendor-script",
      url: "https://x.ai/cli/install.sh",
      interpreter: ["bash"],
      binDir: "~/.grok/bin",
    },
    update: { kind: "self-update", args: ["update"] },
    uninstall: { kind: "none" },
  },
};

/**
 * Entry point squab's patched bundle calls: registers the harness definition
 * first, then the session adapter.
 */
function registerGrok(registerAdapter, registerHarness) {
  registerHarness(grokHarnessDef);
  registerAdapter(grokAdapter);
}

export { AGENT, SESSION_FILE, grokAdapter, grokHarnessDef, registerGrok, settingsCatalogItems };
