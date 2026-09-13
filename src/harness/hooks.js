import path from "node:path";

import { grokHome } from "./paths.js";

/**
 * Native hook installation for xAI's Grok Build CLI.
 *
 * Grok's hook system is Claude-Code-compatible (see
 * ~/.grok/docs/user-guide/10-hooks.md): hook files are discovered from
 * `~/.grok/hooks/*.json` in the shape
 * `{"hooks":{"PreToolUse":[{"matcher":"","hooks":[{"type":"command","command":"...","timeout":30}]}], ...}}`,
 * and each hook process receives a JSON envelope on stdin with camelCase
 * keys (`hookEventName`, `sessionId`, `cwd`, `toolName`, `toolInput`,
 * `toolResult`, ...).
 *
 * squab's canonical hook protocol is an optional trio an adapter attaches
 * all-or-nothing:
 *   - hookCapabilities: { lastUpdated, supports: { <7 booleans> } }
 *   - hookScript(event, opts): the text of a standalone Node script that
 *     reads the hook envelope from stdin and POSTs a `squab.hook/v1`
 *     envelope to opts.daemonUrl (with an optional opts.authToken).
 *   - hookInstallEntry(event, scriptPath, opts): where/how to merge an
 *     entry that runs that script into the agent's own settings file.
 *
 * squab ships its own minified generators for this (`defineHookCapabilities`,
 * `buildCanonicalHookScript`, `buildCanonicalHookInstallEntry` in squab's
 * bundle), but the minified names are not stable across squab builds and
 * cannot be imported directly, so this module reimplements the minimal
 * equivalent, matching squab's own generator output field-for-field so the
 * installed hooks are exactly what squab expects to find.
 */

const HOOK_SCHEMA = "squab.hook/v1";
const AGENT_OR_EVENT_SLUG_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const SESSION_ID_FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TIMEOUT_S = 2147483;
const SLUG_PREVIEW_LEN = 64;

/** The canonical squab HookEvent enum every adapter's capabilities are keyed by. */
const HOOK_EVENTS = [
  "notification",
  "preToolUse",
  "postToolUse",
  "stop",
  "sessionStart",
  "permissionRequest",
  "statusLine",
];

function preview(value) {
  return value.length > SLUG_PREVIEW_LEN ? `${value.slice(0, SLUG_PREVIEW_LEN)}…` : value;
}

function isIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * squab's `defineHookCapabilities`: validates and freezes a capabilities
 * bundle. All seven HookEvent keys are required and must be booleans.
 */
function defineHookCapabilities(lastUpdated, supports) {
  if (!isIsoDate(lastUpdated)) {
    throw new Error(
      `defineHookCapabilities: lastUpdated ${JSON.stringify(preview(String(lastUpdated)))} is invalid; must be ISO-8601 UTC date (YYYY-MM-DD)`,
    );
  }
  if (typeof supports !== "object" || supports === null || Array.isArray(supports)) {
    throw new Error(
      `defineHookCapabilities: supports must be a plain object keyed by HookEvent; got ${typeof supports}`,
    );
  }
  for (const key of Object.keys(supports)) {
    if (!HOOK_EVENTS.includes(key)) {
      throw new Error(
        `defineHookCapabilities: unknown HookEvent ${JSON.stringify(preview(key))}; canonical enum is ${JSON.stringify(HOOK_EVENTS)}`,
      );
    }
  }
  for (const key of HOOK_EVENTS) {
    const value = supports[key];
    if (typeof value !== "boolean") {
      throw new Error(
        `defineHookCapabilities: supports.${key} must be a boolean; got ${typeof value} (${JSON.stringify(value)})`,
      );
    }
  }
  return {
    lastUpdated,
    supports: Object.freeze({
      notification: supports.notification,
      preToolUse: supports.preToolUse,
      postToolUse: supports.postToolUse,
      stop: supports.stop,
      sessionStart: supports.sessionStart,
      permissionRequest: supports.permissionRequest,
      statusLine: supports.statusLine,
    }),
  };
}

/** Escape a value for embedding inside a single-quoted JS string literal. */
function escapeForSingleQuotedLiteral(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\0", "\\0");
}

/**
 * squab's `buildCanonicalHookScript`: emits the text of a standalone Node
 * script that reads the hook envelope on stdin, wraps it in a
 * `squab.hook/v1` envelope, and POSTs it to the daemon. Fire-and-forget for
 * every event except `permissionRequest`, which waits for the daemon's
 * response and echoes it to stdout. Grok never reaches the permissionRequest
 * branch today since it is not in grok's supported set below, but the
 * generator stays general so it matches squab's own shape.
 */
function buildCanonicalHookScript(agent, event, opts, config) {
  if (!AGENT_OR_EVENT_SLUG_RE.test(agent)) {
    throw new Error(`buildCanonicalHookScript: agent "${preview(agent)}" is not a safe slug`);
  }
  if (!AGENT_OR_EVENT_SLUG_RE.test(event)) {
    throw new Error(`buildCanonicalHookScript: event "${preview(event)}" is not a safe slug`);
  }
  const permissionRequestTimeoutS = config?.overrideTimeoutS ?? config?.permissionRequestTimeoutS ?? 30;
  const fireAndForgetTimeoutS = config?.overrideTimeoutS ?? config?.fireAndForgetTimeoutS ?? 5;
  const sessionIdField = config?.sessionIdField ?? "session_id";
  if (!SESSION_ID_FIELD_RE.test(sessionIdField)) {
    throw new Error(
      `buildCanonicalHookScript: sessionIdField "${preview(sessionIdField)}" is not a safe identifier`,
    );
  }
  const daemonUrl = escapeForSingleQuotedLiteral(String(opts.daemonUrl));
  const authToken = opts.authToken !== undefined ? escapeForSingleQuotedLiteral(String(opts.authToken)) : "";
  const isPermissionRequest = event === "permissionRequest";
  const timeoutS = isPermissionRequest ? permissionRequestTimeoutS : fireAndForgetTimeoutS;
  if (!Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > MAX_TIMEOUT_S) {
    throw new Error(
      `buildCanonicalHookScript: timeoutS ${timeoutS} for event "${event}" must be an integer between 1 and ${MAX_TIMEOUT_S}`,
    );
  }
  const timeoutMs = timeoutS * 1000;
  const socketTimeoutMs = 1000;

  const dispatch = isPermissionRequest
    ? String.raw`  const req = mod.request(reqOpts, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      process.stdout.write(Buffer.concat(chunks).toString('utf8'));
      process.exit(0);
    });
  });
  req.on('socket', (socket) => {
    socket.setTimeout(${socketTimeoutMs});
    socket.on('timeout', () => socket.destroy());
    socket.on('connect', () => socket.setTimeout(${timeoutMs}));
  });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(body);`
    : String.raw`  const req = mod.request(reqOpts);
  req.on('error', () => {});
  req.end(body);
  req.on('socket', (s) => {
    s.setTimeout(${socketTimeoutMs});
    s.on('timeout', () => s.destroy());
    s.unref();
  });`;

  // Every line but the shebang is indented one space below. This is
  // functionally inert (Node ignores leading whitespace), but it keeps every
  // generated line off column zero so build-harness.js's naive same-file
  // declaration scanner never mistakes a line like ` const AGENT = '...'`
  // inside this *string* for a real top-level `const AGENT` in this module
  // (which would otherwise collide with adapter.js's own `AGENT` constant).
  return String.raw`#!/usr/bin/env node
 // Generated by squab hook-script ${agent} ${event}
 // DO NOT EDIT — regenerated on every chirp installHooks call.
 // Schema: ${HOOK_SCHEMA}
 const DAEMON_URL = '${daemonUrl}';
 const AUTH_TOKEN = '${authToken}';
 const AGENT = '${agent}';
 const chunks = [];
 const hookDeadline = setTimeout(() => process.exit(0), ${timeoutMs});
 hookDeadline.unref();
 const TRANSCRIPT_CHUNK_BYTES = 64 * 1024;
 const TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;
 const TRANSCRIPT_PROBE_TIMEOUT_MS = 500;
 const TRANSCRIPT_RETRY_DELAYS_MS = [0, 50, 100];
 const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
 function withTimeout(promise, timeoutMs) {
   return new Promise((resolve) => {
     const timer = setTimeout(() => resolve({ state: 'unknown' }), timeoutMs);
     timer.unref();
     promise.then(
       (value) => { clearTimeout(timer); resolve(value); },
       () => { clearTimeout(timer); resolve({ state: 'unknown' }); },
     );
   });
 }

 async function readTranscriptMetadata(transcriptPath) {
   let handle;
   try {
     const [{ open }, { constants }] = await Promise.all([import('fs/promises'), import('fs')]);
     const flags = constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0);
     handle = await open(transcriptPath, flags);
     const stat = await handle.stat();
     if (!stat.isFile()) return { state: 'unknown' };

     const buffers = [];
     let position = 0;
     while (position < TRANSCRIPT_MAX_BYTES) {
       const buffer = Buffer.alloc(Math.min(TRANSCRIPT_CHUNK_BYTES, TRANSCRIPT_MAX_BYTES - position));
       const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
       if (bytesRead === 0) break;
       const chunk = buffer.subarray(0, bytesRead);
       const newline = chunk.indexOf(10);
       buffers.push(newline >= 0 ? chunk.subarray(0, newline) : chunk);
       position += bytesRead;
       if (newline >= 0 || bytesRead < buffer.length) break;
     }
     if (buffers.length === 0) return { state: 'unknown' };
     const metadata = JSON.parse(Buffer.concat(buffers).toString('utf8').replace(/\r$/, ''));
     return { state: 'known', metadata };
   } catch (e) {
     return { state: 'unknown' };
   } finally {
     if (handle) await handle.close().catch(() => {});
   }
 }

 async function classifyBackgroundChild(payload) {
   if (process.env.SNIPE_BG_TASK_ID) return 'child';
   if (!payload || typeof payload !== 'object') return 'topLevel';

   for (const key of ['agent_id', 'parent_agent_id']) {
     if (typeof payload[key] === 'string' && payload[key].length > 0) return 'child';
   }
   if (payload.is_subagent === true || payload.is_background === true || payload.background === true) {
     return 'child';
   }

   const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
   if (!transcriptPath) return 'topLevel';
   // Match only known child transcript suffixes. Ancestor directories are
   // user-controlled and may legitimately be named "subagents" or "bg-*".
   if (/[\/]subagents[\/][^\/]+\.jsonl$/.test(transcriptPath)) return 'child';
   if (/[\/]chats[\/][^\/]+[\/][^\/]+\.jsonl$/.test(transcriptPath)) return 'child';

   // Claude and Snipe expose explicit markers above. Other/future adapters do
   // not have a known transcript metadata contract, so their ordinary paths
   // are conclusively top-level rather than guessed from file contents.
   if (AGENT !== 'codex' && AGENT !== 'gemini') return 'topLevel';

   // Codex stores main and child rollouts in the same date-sharded directory,
   // so the path alone cannot distinguish them. Its first session_meta line
   // records payload.source.subagent. Gemini likewise records kind=subagent
   // in its init line. Retry briefly because SessionStart can race transcript
   // creation. Unknown metadata suppresses lifecycle attribution rather than
   // failing open and assigning a possible child event to its parent.
   for (const retryDelay of TRANSCRIPT_RETRY_DELAYS_MS) {
     if (retryDelay) await delay(retryDelay);
     const result = await withTimeout(
       readTranscriptMetadata(transcriptPath),
       TRANSCRIPT_PROBE_TIMEOUT_MS,
     );
     if (result.state !== 'known') continue;
     const metadata = result.metadata;
     const source = metadata && metadata.payload && metadata.payload.source;
     return metadata?.kind === 'subagent' || !!(source && typeof source === 'object' && source.subagent)
       ? 'child'
       : 'topLevel';
   }
   return 'unknown';
 }
 process.stdin.on('data', (c) => chunks.push(c));
 process.stdin.on('end', async () => {
   const raw = Buffer.concat(chunks).toString('utf8');
   let payload;
   try { payload = JSON.parse(raw); } catch (e) { payload = {}; }
   const sessionId = (payload && typeof payload.${sessionIdField} === 'string') ? payload.${sessionIdField} : '';
   const inheritedChirpSessionId = (process.env.CHIRP_NOTIFICATION_ID || '').replace(/[\r\n]/g, '');
   const childClassification = await classifyBackgroundChild(payload);
   const ts = new Date().toISOString();
   const envelopeObject = {
     schema: '${HOOK_SCHEMA}',
     agent: '${agent}',
     kind: '${event}',
     ts: ts,
     sessionId: sessionId,
     payload: payload
   };
   if (childClassification === 'child') {
     envelopeObject.backgroundChild = true;
     if (inheritedChirpSessionId) envelopeObject.parentChirpSessionId = inheritedChirpSessionId;
   } else if (childClassification === 'unknown') {
     envelopeObject.lifecycleAttribution = 'unknown';
     if (inheritedChirpSessionId) envelopeObject.parentChirpSessionId = inheritedChirpSessionId;
   } else if (inheritedChirpSessionId) {
     envelopeObject.chirpSessionId = inheritedChirpSessionId;
   }
   const envelope = JSON.stringify(envelopeObject);
   const { URL: NodeURL } = await import('url');
   const url = new NodeURL(DAEMON_URL);
   const mod = await import(url.protocol === 'https:' ? 'https' : 'http');
   const body = Buffer.from(envelope, 'utf8');
   const headers = { 'Content-Type': 'application/json', 'Content-Length': body.length };
   if (AUTH_TOKEN) headers['Authorization'] = 'Bearer ' + AUTH_TOKEN;
   const reqOpts = {
     method: 'POST',
     hostname: url.hostname,
     port: url.port || (url.protocol === 'https:' ? 443 : 80),
     path: url.pathname + url.search,
     headers: headers,
     timeout: ${timeoutMs}
   };
 ${dispatch}
 });
`;
}

/**
 * Native hook event names each canonical HookEvent maps to. These are
 * Claude's own PascalCase names, which grok's hook file format also uses
 * since it is explicitly Claude-Code compatible (PreToolUse, PostToolUse,
 * Stop, SessionStart, ...).
 */
const CANONICAL_TO_NATIVE_EVENT_NAME = Object.freeze({
  notification: "Notification",
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  stop: "Stop",
  sessionStart: "SessionStart",
  permissionRequest: "PermissionRequest",
});

/**
 * squab's `buildCanonicalHookInstallEntry`: describes where/how chirp should
 * merge one hook handler into an agent's own settings file. squab owns
 * create-if-missing and the actual merge; this only returns the merge
 * instruction. The fragment shape (`{matcher, hooks:[{type,command,timeout?}]}`)
 * matches grok's `~/.grok/hooks/*.json` format (Claude-Code compatible),
 * unlike e.g. Cursor's flatter `{command, timeout?}` fragment for
 * `~/.cursor/hooks.json`.
 */
function buildCanonicalHookInstallEntry(settingsFile, event, scriptPath, mapping, opts) {
  const eventMapping = mapping ?? CANONICAL_TO_NATIVE_EVENT_NAME;
  const nativeEventName = eventMapping[event];
  if (nativeEventName === undefined) {
    throw new Error(
      `buildCanonicalHookInstallEntry: unmapped HookEvent "${event}" in the provided key mapping`,
    );
  }
  const handler = { type: "command", command: scriptPath };
  const override = opts?.timeoutOverrides?.[event];
  if (override !== undefined) {
    if (!Number.isInteger(override) || override < 1 || override > MAX_TIMEOUT_S) {
      throw new Error(
        `buildCanonicalHookInstallEntry: timeout for "${event}" must be an integer between 1 and ${MAX_TIMEOUT_S}, got ${override}`,
      );
    }
    handler.timeout = override;
  }
  return {
    settingsFile,
    mergePath: ["hooks", nativeEventName],
    fragment: { matcher: ".*", hooks: [handler] },
    mergeOp: "array-append",
  };
}

const GROK_HOOKS_SETTINGS_FILENAME = "xirp.json";
const GROK_HOOK_CAPABILITIES_LAST_UPDATED = "2026-09-12";

/** Events grok's native hook surface does not expose to squab today. */
const GROK_UNSUPPORTED_HOOK_EVENTS = new Set(["notification", "permissionRequest", "statusLine"]);

const grokHookCapabilities = defineHookCapabilities(GROK_HOOK_CAPABILITIES_LAST_UPDATED, {
  notification: false,
  preToolUse: true,
  postToolUse: true,
  stop: true,
  sessionStart: true,
  permissionRequest: false,
  statusLine: false,
});

/** ~/.grok/hooks/xirp.json, honoring $GROK_HOME like the rest of grok's state. */
function grokHooksSettingsFile() {
  return path.join(grokHome(), "hooks", GROK_HOOKS_SETTINGS_FILENAME);
}

function grokHookScript(event, opts) {
  if (GROK_UNSUPPORTED_HOOK_EVENTS.has(event)) {
    throw new Error(`grok hookScript: ${event} is not exposed by Grok Build's native hook surface`);
  }
  return buildCanonicalHookScript("grok", event, opts, {
    sessionIdField: "sessionId",
    overrideTimeoutS: opts?.timeoutOverrides?.[event],
  });
}

function grokHookInstallEntry(event, scriptPath, opts) {
  if (GROK_UNSUPPORTED_HOOK_EVENTS.has(event)) {
    throw new Error(`grok hookInstallEntry: ${event} is not exposed by Grok Build's native hook surface`);
  }
  return buildCanonicalHookInstallEntry(
    grokHooksSettingsFile(),
    event,
    scriptPath,
    CANONICAL_TO_NATIVE_EVENT_NAME,
    opts,
  );
}

export {
  HOOK_SCHEMA,
  HOOK_EVENTS,
  defineHookCapabilities,
  buildCanonicalHookScript,
  buildCanonicalHookInstallEntry,
  CANONICAL_TO_NATIVE_EVENT_NAME,
  GROK_UNSUPPORTED_HOOK_EVENTS,
  grokHookCapabilities,
  grokHooksSettingsFile,
  grokHookScript,
  grokHookInstallEntry,
};
