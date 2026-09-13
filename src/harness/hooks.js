import path from "node:path";

import { agyHome } from "./paths.js";

/**
 * Native hook installation for Google's Antigravity CLI (`agy`).
 *
 * agy's hook system resembles Claude Code's but differs in two ways that
 * matter here, both taken from the CLI's own bundled "Lifecycle Hooks
 * (hooks.json)" reference (embedded in the `agy` binary; see also
 * https://antigravity.google/docs/hooks):
 *
 *  1. The file is keyed by *hook namespace*, not by event. The shared global
 *     file `~/.gemini/config/hooks.json` looks like
 *
 *       {
 *         "<namespace>": {
 *           "enabled": true,
 *           "PostToolUse": [
 *             { "matcher": "*", "hooks": [{ "type": "command", "command": "...", "timeout": 30 }] }
 *           ],
 *           "Stop": [ { "type": "command", "command": "..." } ]
 *         }
 *       }
 *
 *     Other namespaces belong to other tools, so xirp merges strictly under
 *     its own `xirp` key and never touches theirs.
 *
 *  2. The per-event value shape is not uniform. `PreToolUse` and `PostToolUse`
 *     are *grouped*: a list of `{matcher, hooks:[handler]}` objects, where the
 *     matcher is a regex over the tool name ("*" or "" means every tool).
 *     `PreInvocation`, `PostInvocation` and `Stop` are *flat*: a list of
 *     handler objects directly, with no matcher.
 *
 * The stdin envelope is protojson, so its keys are camelCase. Every payload
 * carries `conversationId`, `workspacePaths`, `transcriptPath`,
 * `artifactDirectoryPath` and `modelName`; `PreToolUse` adds `toolCall`
 * ({name, args}) and `stepIdx`, `PostToolUse` adds `stepIdx` and an optional
 * `error`. `conversationId` is therefore the session-id field squab's hook
 * script must read.
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
 *
 * One part of squab's generator is deliberately left out: the background-child
 * classification that inspects `agent_id`, `is_subagent` and `transcript_path`
 * to decide whether a hook fired inside a subagent. Those are snake_case
 * Claude/Codex field names; agy's protojson envelope emits none of them, so
 * the classifier would return "topLevel" for every agy payload it ever sees.
 * Emitting the same envelope without the dead branch keeps the output
 * identical and the script readable.
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
 * response and echoes it to stdout. antigravity never reaches the
 * permissionRequest branch today since it is not in its supported set below,
 * but the generator stays general so it matches squab's own shape.
 */
function buildCanonicalHookScript(agent, event, opts, config) {
  if (!AGENT_OR_EVENT_SLUG_RE.test(agent)) {
    throw new Error(`buildCanonicalHookScript: agent "${preview(agent)}" is not a safe slug`);
  }
  if (!AGENT_OR_EVENT_SLUG_RE.test(event)) {
    throw new Error(`buildCanonicalHookScript: event "${preview(event)}" is not a safe slug`);
  }
  const permissionRequestTimeoutS =
    config?.overrideTimeoutS ?? config?.permissionRequestTimeoutS ?? 30;
  const fireAndForgetTimeoutS = config?.overrideTimeoutS ?? config?.fireAndForgetTimeoutS ?? 5;
  const sessionIdField = config?.sessionIdField ?? "session_id";
  if (!SESSION_ID_FIELD_RE.test(sessionIdField)) {
    throw new Error(
      `buildCanonicalHookScript: sessionIdField "${preview(sessionIdField)}" is not a safe identifier`,
    );
  }
  const daemonUrl = escapeForSingleQuotedLiteral(String(opts.daemonUrl));
  const authToken =
    opts.authToken !== undefined ? escapeForSingleQuotedLiteral(String(opts.authToken)) : "";
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
 process.stdin.on('data', (c) => chunks.push(c));
 process.stdin.on('end', async () => {
   const raw = Buffer.concat(chunks).toString('utf8');
   let payload;
   try { payload = JSON.parse(raw); } catch (e) { payload = {}; }
   const sessionId = (payload && typeof payload.${sessionIdField} === 'string') ? payload.${sessionIdField} : '';
   const inheritedChirpSessionId = (process.env.CHIRP_NOTIFICATION_ID || '').replace(/[\r\n]/g, '');
   const ts = new Date().toISOString();
   const envelopeObject = {
     schema: '${HOOK_SCHEMA}',
     agent: '${agent}',
     kind: '${event}',
     ts: ts,
     sessionId: sessionId,
     payload: payload
   };
   if (inheritedChirpSessionId) envelopeObject.chirpSessionId = inheritedChirpSessionId;
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
 * Native hook event names each canonical HookEvent maps to. agy exposes five
 * lifecycle events -- PreToolUse, PostToolUse, PreInvocation, PostInvocation
 * and Stop -- of which three line up with a canonical squab event. There is no
 * native session-start, notification, status-line or standalone permission
 * event: permission decisions are returned from PreToolUse itself, which is
 * already claimed by `preToolUse`, so `permissionRequest` stays unsupported
 * rather than double-installing on the same native event.
 */
const CANONICAL_TO_NATIVE_EVENT_NAME = Object.freeze({
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  stop: "Stop",
});

/** Native events whose value is a list of `{matcher, hooks:[...]}` groups. */
const GROUPED_NATIVE_EVENTS = new Set(["PreToolUse", "PostToolUse"]);

/** The hook namespace xirp owns inside the shared hooks.json. */
const HOOK_NAMESPACE = "xirp";

/** Matcher that selects every tool, per agy's hook reference. */
const MATCH_ALL_TOOLS = "*";

/**
 * squab's `buildCanonicalHookInstallEntry`, adapted to agy's namespaced file:
 * describes where/how chirp should merge one hook handler. squab owns
 * create-if-missing and the actual merge; this only returns the merge
 * instruction. The mergePath is rooted at xirp's own namespace so sibling
 * namespaces written by other tools survive untouched, and the fragment is
 * grouped or flat according to the event.
 */
function buildCanonicalHookInstallEntry(settingsFilePath, event, scriptPath, mapping, opts) {
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
  const fragment = GROUPED_NATIVE_EVENTS.has(nativeEventName)
    ? { matcher: MATCH_ALL_TOOLS, hooks: [handler] }
    : handler;
  return {
    settingsFile: settingsFilePath,
    mergePath: [HOOK_NAMESPACE, nativeEventName],
    fragment,
    mergeOp: "array-append",
  };
}

const ANTIGRAVITY_HOOK_CAPABILITIES_LAST_UPDATED = "2026-09-13";

/** Events agy's native hook surface does not expose to squab today. */
const ANTIGRAVITY_UNSUPPORTED_HOOK_EVENTS = new Set([
  "notification",
  "sessionStart",
  "permissionRequest",
  "statusLine",
]);

const antigravityHookCapabilities = defineHookCapabilities(
  ANTIGRAVITY_HOOK_CAPABILITIES_LAST_UPDATED,
  {
    notification: false,
    preToolUse: true,
    postToolUse: true,
    stop: true,
    sessionStart: false,
    permissionRequest: false,
    statusLine: false,
  },
);

/**
 * The shared hooks file both the TUI and the backend read:
 * `~/.gemini/config/hooks.json`. It is a sibling of the CLI's own state
 * directory, so it is derived from agyHome()'s parent -- which keeps a
 * relocated home (tests, sandboxes) self-consistent.
 */
function antigravityHooksSettingsFile() {
  return path.join(path.dirname(agyHome()), "config", "hooks.json");
}

function antigravityHookScript(event, opts) {
  if (ANTIGRAVITY_UNSUPPORTED_HOOK_EVENTS.has(event)) {
    throw new Error(
      `antigravity hookScript: ${event} is not exposed by the Antigravity CLI's native hook surface`,
    );
  }
  return buildCanonicalHookScript("antigravity", event, opts, {
    // protojson envelope: every hook payload carries `conversationId`.
    sessionIdField: "conversationId",
    overrideTimeoutS: opts?.timeoutOverrides?.[event],
  });
}

function antigravityHookInstallEntry(event, scriptPath, opts) {
  if (ANTIGRAVITY_UNSUPPORTED_HOOK_EVENTS.has(event)) {
    throw new Error(
      `antigravity hookInstallEntry: ${event} is not exposed by the Antigravity CLI's native hook surface`,
    );
  }
  return buildCanonicalHookInstallEntry(
    antigravityHooksSettingsFile(),
    event,
    scriptPath,
    CANONICAL_TO_NATIVE_EVENT_NAME,
    opts,
  );
}

export {
  HOOK_SCHEMA,
  HOOK_EVENTS,
  HOOK_NAMESPACE,
  MATCH_ALL_TOOLS,
  GROUPED_NATIVE_EVENTS,
  defineHookCapabilities,
  buildCanonicalHookScript,
  buildCanonicalHookInstallEntry,
  CANONICAL_TO_NATIVE_EVENT_NAME,
  ANTIGRAVITY_UNSUPPORTED_HOOK_EVENTS,
  antigravityHookCapabilities,
  antigravityHooksSettingsFile,
  antigravityHookScript,
  antigravityHookInstallEntry,
};
