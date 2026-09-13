/**
 * Pure translation between the Antigravity CLI's on-disk transcript format and
 * squab's canonical message array. No filesystem access lives in this module.
 *
 * agy writes one JSON object per line into
 * `brain/<id>/.system_generated/logs/transcript_full.jsonl`. Every line is a
 * "step":
 *
 *   {
 *     "step_index": 9,
 *     "source": "USER_EXPLICIT" | "MODEL" | "SYSTEM",
 *     "type": "USER_INPUT" | "PLANNER_RESPONSE" | "VIEW_FILE" | ...,
 *     "status": "DONE",
 *     "created_at": "2026-09-09T20:56:58Z",
 *     "content": "...",            // absent on some steps
 *     "thinking": "...",           // PLANNER_RESPONSE only, optional
 *     "error": "...",              // failed steps, optional
 *     "tool_calls": [{ "name": "view_file", "args": { ... } }]
 *   }
 *
 * The step stream is flat: a model turn is one PLANNER_RESPONSE carrying the
 * assistant text and its tool calls, and each tool's *result* arrives as its
 * own following step whose `type` names the tool (VIEW_FILE, RUN_COMMAND,
 * GREP_SEARCH, ...). The steps carry no ids linking a call to its result, so
 * this module synthesises ids and pairs them first-in-first-out.
 *
 * Transcript lines carry no token accounting of any kind, so squab's usage
 * fields stay zero -- see adapter.parseSessionFile.
 */

const EPOCH_ZERO = "1970-01-01T00:00:00.000Z";
const MAX_TEXT_BYTES = 256 * 1024;
const TRUNCATION_SUFFIX = "\n\n[truncated]";

/** Steps the user typed. */
const USER_STEP_TYPES = new Set(["USER_INPUT"]);
/** Steps that are a model turn (text + thinking + tool calls). */
const ASSISTANT_STEP_TYPES = new Set(["PLANNER_RESPONSE"]);
/**
 * SYSTEM steps worth surfacing to the reader. ERROR_MESSAGE reports a failed
 * turn; CHECKPOINT is the compaction summary agy resumes from; SYSTEM_MESSAGE
 * carries inter-agent messages.
 */
const SYSTEM_NOTE_STEP_TYPES = new Set(["ERROR_MESSAGE", "CHECKPOINT", "SYSTEM_MESSAGE"]);
/**
 * Steps deliberately dropped: CONVERSATION_HISTORY has no content at all, and
 * EPHEMERAL_MESSAGE is the CLI's own boilerplate reminder text, not
 * conversation.
 */
const IGNORED_STEP_TYPES = new Set(["CONVERSATION_HISTORY", "EPHEMERAL_MESSAGE"]);
/**
 * Step type used when re-encoding a tool result into agy's shape. It is a real
 * MODEL tool-result type agy itself emits, and the reader below maps any
 * unrecognised MODEL step to a tool result, so the round trip is stable.
 */
const GENERIC_STEP_TYPE = "GENERIC";

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** Byte-bounded truncation that never splits a surrogate pair. */
function truncateText(text, maxBytes = MAX_TEXT_BYTES) {
  if (typeof text !== "string") return "";
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const budget = maxBytes - Buffer.byteLength(TRUNCATION_SUFFIX);
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (Buffer.byteLength(text.slice(0, mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  if (low > 0) {
    const code = text.charCodeAt(low);
    if (code >= 0xdc00 && code <= 0xdfff) low -= 1;
  }
  return text.slice(0, low) + TRUNCATION_SUFFIX;
}

/**
 * squab's usage shape. agy's transcript reports no token counts, so every
 * field stays zero; the constructor is kept so the adapter's ParsedSession
 * matches what squab's other adapters return.
 */
function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
  };
}

function addUsage(acc, delta) {
  if (!delta) return acc;
  acc.inputTokens += asFiniteNumber(delta.inputTokens);
  acc.outputTokens += asFiniteNumber(delta.outputTokens);
  acc.cacheReadTokens += asFiniteNumber(delta.cacheReadTokens);
  acc.cacheWriteTokens += asFiniteNumber(delta.cacheWriteTokens);
  acc.cacheWrite5mTokens += asFiniteNumber(delta.cacheWrite5mTokens);
  acc.cacheWrite1hTokens += asFiniteNumber(delta.cacheWrite1hTokens);
  return acc;
}

/** Split JSONL text into parsed objects, reporting unparseable lines. */
function parseJsonl(text) {
  const rows = [];
  const warnings = [];
  if (typeof text !== "string" || text.length === 0) return { rows, warnings };
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      warnings.push({ line: i + 1, reason: "invalid-json" });
      continue;
    }
    if (!isPlainObject(value)) {
      warnings.push({ line: i + 1, reason: "not-an-object" });
      continue;
    }
    rows.push({ line: i + 1, value });
  }
  return { rows, warnings };
}

/**
 * Debug helper: what a transcript_full.jsonl contains, counted by step type.
 * Deliberately not part of ParsedSession.
 */
function inspectTranscript(text) {
  const { rows, warnings } = parseJsonl(text);
  const counts = {};
  const steps = [];
  for (const row of rows) {
    const type = asString(row.value.type) || "<missing>";
    counts[type] = (counts[type] ?? 0) + 1;
    steps.push(row.value);
  }
  return { steps, warnings, counts };
}

function toIso(ms) {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? EPOCH_ZERO : date.toISOString();
}

function parseIsoMs(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * agy stores the typed prompt inside a `<USER_REQUEST>` block, followed by
 * `<ADDITIONAL_METADATA>` and sometimes `<USER_SETTINGS_CHANGE>` blocks the
 * user never wrote. Keep only the request body.
 */
const USER_REQUEST_PATTERN = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;
function extractUserRequest(content) {
  if (typeof content !== "string") return "";
  const match = content.match(USER_REQUEST_PATTERN);
  if (match) return match[1];
  // No wrapper: strip the trailing system-authored blocks and keep the rest.
  return content.replace(/<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/\1>/g, "").trim();
}

/**
 * Tool name implied by a tool-result step type. agy derives tool names by
 * lowercasing the step type and dropping the CORTEX_STEP_TYPE_ prefix (this is
 * the same rule its hook `matcher` documentation states).
 */
function toolNameFromStepType(type) {
  return asString(type).replace(/^CORTEX_STEP_TYPE_/, "").toLowerCase() || "unknown";
}

/** Deterministic id for the nth tool call of a step. */
function synthesizeToolUseId(stepIndex, callIndex) {
  return `step-${stepIndex}-call-${callIndex}`;
}

/**
 * transcript_full.jsonl -> squab's canonical message array.
 *
 * Produces the same message shapes squab's other adapters emit:
 *   { type: "user_message",      text, timestamp }
 *   { type: "assistant_message", text, timestamp }
 *   { type: "tool_use",          id, tool, input, timestamp }
 *   { type: "tool_result",       toolUseId, output, timestamp, error? }
 *   { type: "system_note",       text, timestamp }
 *
 * opts.baseTime  ISO fallback clock for steps with no parseable created_at
 */
function transcriptToMessages(transcriptText, opts = {}) {
  const { steps, warnings } = inspectTranscript(transcriptText);
  const baseMs = parseIsoMs(opts.baseTime) ?? 0;
  const messages = [];
  /** Tool calls emitted but not yet matched to a result step, oldest first. */
  const pendingToolCalls = [];
  let previousMs = null;
  let skipped = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const type = asString(step.type);
    const source = asString(step.source);
    const stepIndex = typeof step.step_index === "number" ? Math.trunc(step.step_index) : i;
    const content = asString(step.content);
    const produced = [];

    if (IGNORED_STEP_TYPES.has(type)) {
      skipped++;
      continue;
    }

    if (USER_STEP_TYPES.has(type)) {
      produced.push({ type: "user_message", text: extractUserRequest(content) });
    } else if (ASSISTANT_STEP_TYPES.has(type)) {
      // `thinking` is the model's private reasoning. squab's canonical message
      // set has no reasoning role, so it is dropped rather than shown as text.
      if (content) produced.push({ type: "assistant_message", text: content });
      const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      for (let c = 0; c < toolCalls.length; c++) {
        const call = toolCalls[c];
        if (!isPlainObject(call)) continue;
        const id = synthesizeToolUseId(stepIndex, c);
        const tool = asString(call.name, "unknown");
        const input = isPlainObject(call.args) ? call.args : {};
        pendingToolCalls.push({ id, tool });
        produced.push({ type: "tool_use", id, tool, input });
      }
      if (produced.length === 0) {
        // A PLANNER_RESPONSE with neither text nor tool calls (agy writes one
        // for every interrupted turn) carries nothing to show.
        skipped++;
        continue;
      }
    } else if (SYSTEM_NOTE_STEP_TYPES.has(type)) {
      const text = asString(step.error) || content;
      if (!text) {
        skipped++;
        continue;
      }
      produced.push({ type: "system_note", text });
    } else if (source === "MODEL") {
      // Every other MODEL step is a tool result: VIEW_FILE, RUN_COMMAND,
      // GREP_SEARCH, LIST_DIRECTORY, SEARCH_WEB, CODE_ACTION, GENERIC, ...
      const toolName = toolNameFromStepType(type);
      const matchIndex = pendingToolCalls.findIndex((call) => call.tool === toolName);
      const matched =
        matchIndex >= 0 ? pendingToolCalls.splice(matchIndex, 1)[0] : pendingToolCalls.shift();
      const result = {
        type: "tool_result",
        toolUseId: matched ? matched.id : null,
        output: asString(step.error) || content,
      };
      if (step.error !== undefined) result.error = asString(step.error);
      produced.push(result);
    } else {
      skipped++;
      continue;
    }

    let ms = parseIsoMs(step.created_at) ?? baseMs + i;
    if (previousMs !== null && ms < previousMs) ms = previousMs;
    previousMs = ms;
    const timestamp = toIso(ms);
    for (const message of produced) messages.push({ ...message, timestamp });
  }

  return { messages, warnings, skipped };
}

/**
 * Canonical message array -> agy transcript step objects.
 *
 * Used only for handoff pseudo-sessions: xirp renders a transcript that came
 * from some other agent into agy's own step shape so that readNative,
 * readEmbeddedSessionId and parseSessionFile work on it unchanged. This is a
 * faithful inverse of transcriptToMessages for every canonical message type.
 */
function messagesToTranscript(messages) {
  const steps = [];
  const list = Array.isArray(messages) ? messages : [];
  let i = 0;

  const push = (step, timestamp) => {
    steps.push({
      step_index: steps.length,
      status: "DONE",
      created_at: asString(timestamp, EPOCH_ZERO),
      ...step,
    });
  };

  while (i < list.length) {
    const message = list[i];
    const type = message?.type;
    const timestamp = asString(message?.timestamp, EPOCH_ZERO);

    if (type === "user_message") {
      push(
        {
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          content: `<USER_REQUEST>\n${asString(message.text)}\n</USER_REQUEST>`,
        },
        timestamp,
      );
      i++;
      continue;
    }
    if (type === "system_note") {
      push({ source: "SYSTEM", type: "SYSTEM_MESSAGE", content: asString(message.text) }, timestamp);
      i++;
      continue;
    }
    if (type === "tool_result") {
      const step = {
        source: "MODEL",
        type: GENERIC_STEP_TYPE,
        content: asString(message.output),
      };
      if (message.error !== undefined) step.error = asString(message.error);
      push(step, timestamp);
      i++;
      continue;
    }
    if (type === "assistant_message" || type === "tool_use") {
      // Collapse a run of assistant text and tool calls into one
      // PLANNER_RESPONSE, which is how agy itself records a model turn.
      const texts = [];
      const toolCalls = [];
      const runStart = i;
      while (i < list.length && (list[i].type === "assistant_message" || list[i].type === "tool_use")) {
        const current = list[i];
        if (current.type === "assistant_message") {
          const text = asString(current.text);
          if (text) texts.push(text);
        } else {
          toolCalls.push({
            name: asString(current.tool, "unknown"),
            args: isPlainObject(current.input) ? current.input : {},
          });
        }
        i++;
      }
      const step = { source: "MODEL", type: "PLANNER_RESPONSE", content: texts.join("\n\n") };
      if (toolCalls.length > 0) step.tool_calls = toolCalls;
      push(step, asString(list[runStart]?.timestamp, EPOCH_ZERO));
      continue;
    }
    // handoff_marker, image and anything else squab may add: nothing agy can
    // represent, so it is dropped rather than mis-encoded.
    i++;
  }
  return steps;
}

/** Canonical messages -> a Markdown rendering an agent can read and resume from. */
function messagesToMarkdown(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const lines = [];
  const title = asString(opts.title, "Handed-off conversation");
  lines.push(`# ${title}`, "");
  if (opts.cwd) lines.push(`Working directory: \`${opts.cwd}\``, "");
  lines.push(
    "This transcript was handed to the Antigravity CLI by xirp. It is a record of a",
    "conversation that happened elsewhere; read it, then continue the work.",
    "",
    "---",
    "",
  );

  for (const message of list) {
    const timestamp = asString(message?.timestamp, EPOCH_ZERO);
    switch (message?.type) {
      case "user_message":
        lines.push(`## User — ${timestamp}`, "", asString(message.text), "");
        break;
      case "assistant_message":
        lines.push(`## Assistant — ${timestamp}`, "", asString(message.text), "");
        break;
      case "tool_use":
        lines.push(
          `### Tool call: \`${asString(message.tool, "unknown")}\``,
          "",
          "```json",
          JSON.stringify(message.input ?? {}, null, 2),
          "```",
          "",
        );
        break;
      case "tool_result":
        lines.push(
          "### Tool result",
          "",
          "```",
          truncateText(asString(message.output), 8 * 1024),
          "```",
          "",
        );
        break;
      case "system_note":
        lines.push(`> **System:** ${asString(message.text)}`, "");
        break;
      default:
        break;
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

/**
 * Canonical messages -> the flattened message rows squab's ParsedSession
 * carries (id / ts / role / type / text, as produced by the built-in adapters).
 */
function toParsedMessages(messages) {
  const parsed = [];
  for (const message of messages) {
    const ts = asString(message.timestamp, EPOCH_ZERO);
    switch (message.type) {
      case "user_message":
        parsed.push({
          id: null,
          ts,
          role: "user",
          type: "message",
          text: truncateText(message.text),
        });
        break;
      case "assistant_message":
        parsed.push({
          id: null,
          ts,
          role: "assistant",
          type: "message",
          text: truncateText(message.text),
        });
        break;
      case "tool_use": {
        const tool = asString(message.tool, "unknown");
        parsed.push({
          id: asString(message.id) || null,
          ts,
          role: "assistant",
          type: "tool_use",
          text: truncateText(`${tool}(${JSON.stringify(message.input ?? {})})`),
          toolName: tool,
          toolInput: message.input ?? {},
        });
        break;
      }
      case "tool_result":
        parsed.push({
          id: asString(message.toolUseId) || null,
          ts,
          role: "tool",
          type: "tool_result",
          text: truncateText(message.output),
          toolError: message.error !== undefined,
        });
        break;
      case "system_note":
        parsed.push({
          id: null,
          ts,
          role: "system",
          type: "message",
          text: truncateText(message.text),
        });
        break;
      default:
        break;
    }
  }
  return parsed;
}

/** Apply squab's parse options (since / limit / summaryOnly) to parsed rows. */
function applyParseOpts(rows, opts) {
  if (!opts) return rows;
  if (opts.summaryOnly) return [];
  let out = rows;
  if (opts.since) out = out.filter((row) => row.ts > opts.since);
  if (typeof opts.limit === "number" && opts.limit >= 0 && out.length > opts.limit) {
    out = out.slice(0, opts.limit);
  }
  return out;
}

export {
  EPOCH_ZERO,
  MAX_TEXT_BYTES,
  USER_STEP_TYPES,
  ASSISTANT_STEP_TYPES,
  SYSTEM_NOTE_STEP_TYPES,
  IGNORED_STEP_TYPES,
  GENERIC_STEP_TYPE,
  isPlainObject,
  asString,
  asFiniteNumber,
  truncateText,
  emptyUsage,
  addUsage,
  parseJsonl,
  inspectTranscript,
  toIso,
  parseIsoMs,
  extractUserRequest,
  toolNameFromStepType,
  synthesizeToolUseId,
  transcriptToMessages,
  messagesToTranscript,
  messagesToMarkdown,
  toParsedMessages,
  applyParseOpts,
};
