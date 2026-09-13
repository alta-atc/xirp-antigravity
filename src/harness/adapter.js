import fsp from "node:fs/promises";
import path from "node:path";

import {
  TRANSCRIPT_FILE,
  CLI_APP_DATA_DIRS,
  agyHome,
  handoffDir,
  handoffTranscriptFile,
  handoffMarkdownFile,
  handoffSessionFile,
  handoffRoot,
  isHandoffTranscriptPath,
  brainDir,
  conversationDir,
  transcriptFileFor,
  conversationIdFromPath,
  lastConversationsFile,
  metadataFile,
  settingsFile,
  isFile,
  listConversationIds,
  listHandoffIds,
  newestTranscript,
  pathFromFileUri,
} from "./paths.js";

import {
  EPOCH_ZERO,
  isPlainObject,
  asString,
  emptyUsage,
  transcriptToMessages,
  messagesToTranscript,
  messagesToMarkdown,
  toParsedMessages,
  applyParseOpts,
} from "./transcript.js";

import {
  antigravityHookCapabilities,
  antigravityHookScript,
  antigravityHookInstallEntry,
} from "./hooks.js";

const AGENT = "antigravity";
const PARSED_SCHEMA = "squab.session-parsed/v1";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const HANDOFF_SOURCE = "xirp-handoff";

/**
 * The prompt a seeded launch starts with. `agy -i "<prompt>"` runs it once and
 * then stays interactive, which is exactly the handoff shape we want.
 */
function handoffPrompt(markdownPath) {
  return `Continue the conversation whose transcript is in ${markdownPath}. Read it first, then carry on from where it left off.`;
}

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

/** The cwd spellings a conversation might be recorded under (raw and resolved). */
async function cwdVariants(cwd) {
  const variants = [];
  const push = (value) => {
    if (typeof value === "string" && value && !variants.includes(value)) variants.push(value);
  };
  push(cwd);
  try {
    push(await fsp.realpath(cwd));
  } catch {
    /* cwd may not exist yet; the raw spelling is still worth looking up */
  }
  return variants;
}

/** cache/last_conversations.json: { "<abs cwd>": "<conversation-uuid>" }. */
async function readLastConversations() {
  return (await readJsonOrNull(lastConversationsFile())) ?? {};
}

/**
 * cache/conversation_metadata.json summaries, restricted to conversations that
 * belong to the CLI. `AppDataDir: "antigravity"` marks an IDE conversation,
 * whose transcript does not live under this home at all.
 */
async function readCliConversationSummaries() {
  const metadata = await readJsonOrNull(metadataFile());
  const conversations = isPlainObject(metadata?.conversations) ? metadata.conversations : {};
  const out = [];
  for (const [id, entry] of Object.entries(conversations)) {
    if (!isPlainObject(entry)) continue;
    const summary = isPlainObject(entry.summary) ? entry.summary : null;
    if (!summary) continue;
    if (!CLI_APP_DATA_DIRS.has(asString(summary.AppDataDir))) continue;
    out.push({ id: asString(summary.ID) || id, summary });
  }
  return out;
}

/** Absolute workspace paths recorded on a conversation summary. */
function workspacePathsOf(summary) {
  const uris = Array.isArray(summary?.WorkspaceURIs) ? summary.WorkspaceURIs : [];
  return uris.map((uri) => pathFromFileUri(uri)).filter((value) => value !== null);
}

/** The handoff pseudo-session descriptor for an id, or null. */
async function readHandoffSession(sessionId) {
  return readJsonOrNull(handoffSessionFile(sessionId));
}

/** Transcript path for a conversation id, only when it really exists. */
async function existingTranscriptFor(conversationId) {
  if (!conversationId) return null;
  const candidate = transcriptFileFor(conversationId);
  return (await isFile(candidate)) ? candidate : null;
}

/**
 * Write a handoff pseudo-session and return its transcript path.
 *
 * Why this exists instead of fabricating a native conversation: an agy
 * conversation is server-synced state backed by SQLite and protobuf, and the
 * JSONL under `brain/<id>/.system_generated/logs/` is a *log* of that state,
 * not its source of truth. Dropping a hand-written directory into `brain/`
 * would not produce a conversation agy can resume, and the CLI offers no flag
 * or environment variable that presets a conversation id on a fresh launch.
 * So a handoff is a *seeded launch*: xirp renders the incoming transcript to
 * Markdown, and the resume command tells a brand-new agy conversation to read
 * that file and continue. The sibling transcript_full.jsonl uses agy's own
 * step shape so readNative / readEmbeddedSessionId / parseSessionFile treat a
 * handoff exactly like a real session.
 */
async function writeHandoffSession(messages, cwd, sessionId) {
  const dir = handoffDir(sessionId);
  await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE });

  const list = Array.isArray(messages) ? messages : [];
  const markdownPath = handoffMarkdownFile(sessionId);
  const transcriptPath = handoffTranscriptFile(sessionId);

  const steps = messagesToTranscript(list);
  const jsonl = steps.map((step) => JSON.stringify(step)).join("\n");

  await fsp.writeFile(markdownPath, messagesToMarkdown(list, { cwd, title: "Handed-off conversation" }), {
    mode: FILE_MODE,
  });
  await fsp.writeFile(transcriptPath, jsonl.length > 0 ? `${jsonl}\n` : "", { mode: FILE_MODE });
  await fsp.writeFile(
    handoffSessionFile(sessionId),
    `${JSON.stringify({ id: sessionId, cwd, createdAt: new Date().toISOString(), source: HANDOFF_SOURCE }, null, 2)}\n`,
    { mode: FILE_MODE },
  );

  return transcriptPath;
}

/**
 * Settings surfaces of the Antigravity CLI, as documented by the CLI's own
 * bundled reference (`agy`'s antigravity_guide skill and its embedded hooks /
 * customization docs). Only surfaces those docs substantiate are listed.
 */
const settingsCatalogItems = [
  {
    id: "config",
    label: "settings.json",
    description: "Global Antigravity CLI settings (model, verbosity, permissions)",
    scope: "global",
    format: "json",
    path: "~/.gemini/antigravity-cli/settings.json",
  },
  {
    id: "hooks",
    label: "hooks.json",
    description: "Global lifecycle hooks, shared by the CLI and the backend",
    scope: "global",
    format: "json",
    path: "~/.gemini/config/hooks.json",
  },
  {
    id: "mcp",
    label: "mcp_config.json",
    description: "Global MCP server definitions",
    scope: "global",
    format: "json",
    path: "~/.gemini/config/mcp_config.json",
  },
  {
    id: "skills",
    label: "skills",
    description: "Global skills directory",
    scope: "global",
    format: "directory",
    path: "~/.gemini/config/skills",
  },
  {
    id: "instructions",
    label: "AGENTS.md",
    description: "Project rules loaded as context",
    scope: "project",
    format: "markdown",
    path: "<cwd>/AGENTS.md",
  },
  {
    id: "hooks",
    label: ".agents/hooks.json",
    description: "Workspace-local lifecycle hooks",
    scope: "project",
    format: "json",
    path: "<cwd>/.agents/hooks.json",
  },
];

const antigravityAdapter = {
  agent: AGENT,

  /**
   * Conversations are global, so every cwd shares one root. squab hands this
   * value back as `dir` to writeNative / forkNative, both of which ignore it:
   * a handoff cannot live in `brain/` (see writeHandoffSession).
   */
  sessionRoot() {
    return brainDir();
  },

  /**
   * Most recent conversation for a working directory.
   *
   * `cache/last_conversations.json` is authoritative and is rewritten on every
   * launch, so it is tried first. `cache/conversation_metadata.json` is only
   * refreshed when the TUI lists conversations and can be days stale, so it is
   * a fallback. A handoff pseudo-session is the last resort, which is what
   * makes a just-seeded session discoverable before agy has created a real
   * conversation of its own.
   */
  async locateLatest(cwd) {
    const variants = await cwdVariants(cwd);

    const lastConversations = await readLastConversations();
    for (const variant of variants) {
      const found = await existingTranscriptFor(asString(lastConversations[variant]));
      if (found) return found;
    }

    const fromMetadata = [];
    for (const { id, summary } of await readCliConversationSummaries()) {
      if (!workspacePathsOf(summary).some((workspace) => variants.includes(workspace))) continue;
      const found = await existingTranscriptFor(id);
      if (found) fromMetadata.push(found);
    }
    if (fromMetadata.length > 0) return newestTranscript(fromMetadata);

    const fromHandoff = [];
    for (const id of await listHandoffIds()) {
      const session = await readHandoffSession(id);
      if (!session || !variants.includes(asString(session.cwd))) continue;
      const candidate = handoffTranscriptFile(id);
      if (await isFile(candidate)) fromHandoff.push(candidate);
    }
    if (fromHandoff.length > 0) return newestTranscript(fromHandoff);

    return null;
  },

  /**
   * agy conversations are global rather than scoped to a working directory, so
   * cwd is not consulted: an id either names a conversation on this machine or
   * it does not.
   */
  async findBySessionId(cwd, sessionId) {
    if (!sessionId) return null;
    const handoff = handoffTranscriptFile(sessionId);
    if (await isFile(handoff)) return handoff;
    return existingTranscriptFor(sessionId);
  },

  async findImportTranscript(cwd, requestedSessionId) {
    if (!requestedSessionId) {
      const latest = await this.locateLatest(cwd);
      if (!latest) return null;
      const id = conversationIdFromPath(latest);
      return {
        path: latest,
        root: isHandoffTranscriptPath(latest) ? handoffDir(id) : conversationDir(id),
        nativeSessionId: id,
        nativeCwd: await this.nativeCwd(latest),
      };
    }

    const prefix = requestedSessionId.toLowerCase();
    const matches = [];
    for (const id of await listConversationIds()) {
      if (!id.toLowerCase().startsWith(prefix)) continue;
      const candidate = await existingTranscriptFor(id);
      if (!candidate) continue;
      matches.push({ path: candidate, root: conversationDir(id), nativeSessionId: id });
    }
    for (const id of await listHandoffIds()) {
      if (!id.toLowerCase().startsWith(prefix)) continue;
      const candidate = handoffTranscriptFile(id);
      if (!(await isFile(candidate))) continue;
      matches.push({ path: candidate, root: handoffDir(id), nativeSessionId: id });
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple antigravity conversations match "${requestedSessionId}"; use a longer conversation ID`,
      );
    }
    if (matches.length === 0) return null;
    return { ...matches[0], nativeCwd: await this.nativeCwd(matches[0].path) };
  },

  /**
   * The working directory a transcript was recorded in, from the handoff
   * descriptor, the live cwd map, or the (possibly stale) metadata cache.
   */
  async nativeCwd(sessionFilePath) {
    const id = conversationIdFromPath(sessionFilePath);
    if (!id) return null;

    if (isHandoffTranscriptPath(sessionFilePath)) {
      const session = await readHandoffSession(id);
      return asString(session?.cwd) || null;
    }

    const lastConversations = await readLastConversations();
    for (const [cwd, conversationId] of Object.entries(lastConversations)) {
      if (conversationId === id) return cwd;
    }

    for (const entry of await readCliConversationSummaries()) {
      if (entry.id !== id) continue;
      const [first] = workspacePathsOf(entry.summary);
      return first ?? null;
    }
    return null;
  },

  async readEmbeddedSessionId(sessionFilePath) {
    const id = conversationIdFromPath(sessionFilePath);
    if (isHandoffTranscriptPath(sessionFilePath)) {
      const session = await readHandoffSession(id);
      return asString(session?.id) || id || null;
    }
    return id || null;
  },

  async readNative(sessionFilePath) {
    const text = await readTextOrNull(sessionFilePath);
    if (text === null) return [];
    return transcriptToMessages(text).messages;
  },

  /**
   * Hand a transcript from another agent to agy. `dir` (squab's sessionRoot)
   * is ignored: the result is a handoff pseudo-session under
   * ${XIRP_ANTIGRAVITY_HOME || ~/.xirp-antigravity}/handoff/<sessionId>/, not
   * a fabricated entry in agy's own brain/. See writeHandoffSession.
   */
  async writeNative(messages, dir, cwd, sessionId) {
    return writeHandoffSession(messages, cwd, sessionId);
  },

  async writeNoticeSeed(dir, cwd, sessionId, text) {
    const timestamp = new Date().toISOString();
    return writeHandoffSession([{ type: "user_message", text, timestamp }], cwd, sessionId);
  },

  /**
   * Forking copies the source transcript into a fresh handoff pseudo-session.
   * A real agy conversation cannot be cloned on disk, so the fork resumes the
   * same way a handoff does: by reading the rendered transcript.
   */
  async forkNative(srcPath, newSessionId, cwd, destDir) {
    const messages = await this.readNative(srcPath);
    return writeHandoffSession(messages, cwd, newSessionId);
  },

  /**
   * A real conversation resumes by id. A handoff has no id agy knows about, so
   * it resumes as an initial prompt that points at the rendered transcript
   * (`-i` runs the prompt once and then stays interactive).
   */
  resumeArgs(sessionFilePath) {
    const id = conversationIdFromPath(sessionFilePath);
    if (isHandoffTranscriptPath(sessionFilePath)) {
      return ["-i", handoffPrompt(handoffMarkdownFile(id))];
    }
    return ["--conversation", id];
  },

  formatResumeCommand(sessionFilePath, binary) {
    const bin = binary || "agy";
    const id = conversationIdFromPath(sessionFilePath);
    if (isHandoffTranscriptPath(sessionFilePath)) {
      return `${bin} -i ${JSON.stringify(handoffPrompt(handoffMarkdownFile(id)))}`;
    }
    return `${bin} --conversation ${id}`;
  },

  /**
   * agy has no flag or environment variable that presets the conversation id
   * of a fresh launch (`--conversation` only *resumes* an existing one, and
   * ANTIGRAVITY_CONVERSATION_ID is not read on startup). squab therefore falls
   * back to recency discovery through locateLatest once the CLI has written
   * its cwd -> conversation mapping.
   */
  freshLaunchArgs() {
    return [];
  },

  terminateKeystrokes() {
    // Verified against agy 1.2.0 through a pty, from a rendered TUI: a single
    // Ctrl-C does not quit (it cancels the running turn, or arms the prompt
    // "press ctrl+c again to exit"); a second Ctrl-C within the arm window
    // does quit. "/exit", "/quit" and Ctrl-D Ctrl-D also quit, but they depend
    // on the composer being empty and on the slash-command menu's selection,
    // so the Ctrl-C path is the robust one. Sending one Ctrl-C first cancels
    // any running turn (and clears typed text), then the pair quits; when the
    // CLI is already idle the first Ctrl-C merely arms the exit and the pair's
    // first byte completes it, with the trailing byte landing on a dead pty.
    // Confirmed to quit both from an idle prompt and with text in the composer.
    return [{ bytes: "\x03" }, { bytes: "\x03\x03", afterMs: 150 }];
  },

  sanitize(messages) {
    return messages;
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
    const { messages } = transcriptToMessages(text, { baseTime: EPOCH_ZERO });
    const parsedMessages = toParsedMessages(messages);

    const sessionId = conversationIdFromPath(sessionFilePath);
    if (!sessionId) {
      throw new Error(
        `antigravityAdapter.parseSessionFile: ${sessionFilePath} has no extractable sessionId`,
      );
    }

    const isHandoff = isHandoffTranscriptPath(sessionFilePath);

    // agy records the active model in its global settings, not per session.
    const settings = await readJsonOrNull(settingsFile());
    const model = asString(settings?.model) || null;

    let summary = null;
    if (!isHandoff) {
      for (const entry of await readCliConversationSummaries()) {
        if (entry.id !== sessionId) continue;
        summary = asString(entry.summary.Title) || asString(entry.summary.Preview) || null;
        break;
      }
    }

    let lastUserMessage = null;
    for (const row of parsedMessages) {
      if (row.role === "user" && row.type === "message" && row.text) {
        lastUserMessage = { text: row.text, ts: row.ts };
      }
    }

    return {
      schema: PARSED_SCHEMA,
      sessionId,
      agent: AGENT,
      model,
      metadataWatchPaths: isHandoff
        ? [handoffSessionFile(sessionId)]
        : [lastConversationsFile(), metadataFile(), settingsFile()],
      summary,
      lastUserMessage,
      messageCount: parsedMessages.length,
      // agy's transcript steps carry no token accounting of any kind, and the
      // print-mode usage block is never written to the transcript, so squab
      // gets zeroes rather than a guess.
      totalUsage: emptyUsage(),
      latestUsage: null,
      contextWindowSize: null,
      messages: applyParseOpts(parsedMessages, options),
    };
  },

  settingsCatalog: {
    lastUpdated: "2026-09-13",
    list: () => settingsCatalogItems.map((item) => ({ ...item })),
  },

  hookCapabilities: antigravityHookCapabilities,
  hookScript: antigravityHookScript,
  hookInstallEntry: antigravityHookInstallEntry,
};

const antigravityHarnessDef = {
  flag: "--launch-antigravity",
  cmd: "launch-antigravity",
  agentName: AGENT,
  binary: "agy",
  installHint:
    "Install the Antigravity CLI: see https://antigravity.google (then run: agy install)",
  description: "Hand the terminal over to Google's `agy` CLI (Antigravity).",
  visibility: "public",
  lifecycle: {
    // agy ships as a standalone Go binary at ~/.local/bin/agy. Google
    // publishes no vendor install script URL (the binary references only
    // documentation pages and its own auto-update endpoint), so there is
    // nothing honest for squab to run on the user's behalf.
    install: { kind: "none" },
    update: { kind: "self-update", args: ["update"] },
    uninstall: { kind: "none" },
  },
};

/**
 * Entry point squab's patched bundle calls: registers the harness definition
 * first, then the session adapter.
 */
function registerAntigravity(registerAdapter, registerHarness) {
  registerHarness(antigravityHarnessDef);
  registerAdapter(antigravityAdapter);
}

export {
  AGENT,
  TRANSCRIPT_FILE,
  agyHome,
  handoffRoot,
  antigravityAdapter,
  antigravityHarnessDef,
  registerAntigravity,
  settingsCatalogItems,
};
