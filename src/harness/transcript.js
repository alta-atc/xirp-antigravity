/**
 * Pure translation between Grok Build's on-disk transcript format and squab's
 * canonical message array. No filesystem access lives in this module.
 *
 * Grok writes three files per session:
 *   chat_history.jsonl  the conversation (no timestamps on any line)
 *   summary.json        session metadata (created_at, model, cwd, ...)
 *   updates.jsonl       the ACP event stream, which is where timestamps and
 *                       token usage actually live
 */

const EPOCH_ZERO = "1970-01-01T00:00:00.000Z";
const MAX_TEXT_BYTES = 256 * 1024;
const TRUNCATION_SUFFIX = "\n\n[truncated]";
const HANDOFF_SYNTHETIC_REASON = "xirp_handoff";
const KNOWN_HISTORY_TYPES = new Set([
  "system",
  "user",
  "reasoning",
  "assistant",
  "tool_result",
  "backend_tool_call",
]);

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
  acc.inputTokens += delta.inputTokens;
  acc.outputTokens += delta.outputTokens;
  acc.cacheReadTokens += delta.cacheReadTokens;
  acc.cacheWriteTokens += delta.cacheWriteTokens;
  acc.cacheWrite5mTokens += delta.cacheWrite5mTokens;
  acc.cacheWrite1hTokens += delta.cacheWrite1hTokens;
  return acc;
}

/**
 * Map a Grok turn_completed usage block onto squab's usage shape.
 * Grok reports no cache-TTL split, so the 5m/1h buckets stay at zero.
 */
function mapTurnUsage(raw) {
  if (!isPlainObject(raw)) return null;
  const usage = emptyUsage();
  usage.inputTokens = asFiniteNumber(raw.inputTokens);
  usage.outputTokens = asFiniteNumber(raw.outputTokens);
  usage.cacheReadTokens = asFiniteNumber(raw.cachedReadTokens);
  usage.cacheWriteTokens = asFiniteNumber(raw.cacheCreationTokens);
  const total =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return total === 0 ? null : usage;
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
 * Debug helper: what a chat_history.jsonl contains, including every line type
 * this adapter does not understand. Deliberately not part of ParsedSession.
 */
function inspectHistory(text) {
  const { rows, warnings } = parseJsonl(text);
  const counts = {};
  const entries = [];
  for (const row of rows) {
    const type = asString(row.value.type);
    counts[type || "<missing>"] = (counts[type || "<missing>"] ?? 0) + 1;
    if (!KNOWN_HISTORY_TYPES.has(type)) {
      warnings.push({ line: row.line, reason: "unknown-type", type });
      continue;
    }
    entries.push(row.value);
  }
  return { entries, warnings, counts };
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

/** Epoch-ms timestamp of one updates.jsonl line. */
function updateLineMs(record) {
  const meta = isPlainObject(record.params) ? record.params._meta : null;
  if (isPlainObject(meta) && typeof meta.agentTimestampMs === "number") {
    return Math.trunc(meta.agentTimestampMs);
  }
  if (typeof record.timestamp === "number" && Number.isFinite(record.timestamp)) {
    return Math.trunc(record.timestamp * 1000);
  }
  return null;
}

/**
 * Reduce updates.jsonl to what the transcript needs: per-prompt user
 * timestamps, an ordered queue of agent-unit timestamps (one per assistant
 * message and one per tool call), and the turn_completed usage blocks.
 */
function buildTimeline(updatesText) {
  const userTs = new Map();
  const agentTs = [];
  const usageTurns = [];
  let sessionId = null;
  let lastAgentWasMessageChunk = false;
  const seenToolCalls = new Set();

  const { rows } = parseJsonl(updatesText);
  for (const { value } of rows) {
    const params = isPlainObject(value.params) ? value.params : null;
    if (!params) continue;
    if (!sessionId && typeof params.sessionId === "string") sessionId = params.sessionId;
    const update = isPlainObject(params.update) ? params.update : null;
    if (!update) continue;
    const kind = asString(update.sessionUpdate);
    const ms = updateLineMs(value);

    if (kind === "user_message_chunk") {
      lastAgentWasMessageChunk = false;
      const meta = isPlainObject(params._meta) ? params._meta : {};
      const promptIndex =
        typeof meta.promptIndex === "number" ? Math.trunc(meta.promptIndex) : null;
      if (promptIndex !== null && ms !== null && !userTs.has(promptIndex)) {
        userTs.set(promptIndex, ms);
      }
      continue;
    }
    if (kind === "agent_message_chunk") {
      // Streaming emits many chunks per assistant message; keep the first.
      if (!lastAgentWasMessageChunk && ms !== null) agentTs.push(ms);
      lastAgentWasMessageChunk = true;
      continue;
    }
    if (kind === "tool_call") {
      lastAgentWasMessageChunk = false;
      const id = asString(update.toolCallId) || asString(update.id);
      if (id && seenToolCalls.has(id)) continue;
      if (id) seenToolCalls.add(id);
      if (ms !== null) agentTs.push(ms);
      continue;
    }
    if (kind === "turn_completed") {
      lastAgentWasMessageChunk = false;
      const usage = mapTurnUsage(update.usage);
      if (usage) usageTurns.push(usage);
      continue;
    }
  }
  return { userTs, agentTs, usageTurns, sessionId };
}

function emptyTimeline() {
  return { userTs: new Map(), agentTs: [], usageTurns: [], sessionId: null };
}

// Grok wraps the typed prompt as "<user_query>\n...\n</user_query>" before
// storing it; strip that so Xirp shows what the user actually typed.
const USER_QUERY_RE = /^\s*<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/;
function unwrapUserQuery(text) {
  const m = typeof text === "string" ? text.match(USER_QUERY_RE) : null;
  return m ? m[1] : text;
}

function joinTextBlocks(content, separator) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!isPlainObject(block)) continue;
    if (asString(block.type) !== "text") continue;
    const text = asString(block.text);
    if (text) parts.push(text);
  }
  return parts.join(separator);
}

function describeBackendToolCall(entry) {
  const kind = isPlainObject(entry.kind) ? entry.kind : {};
  const toolType = asString(kind.tool_type) || "tool";
  const action = isPlainObject(kind.action) ? kind.action : {};
  const query = asString(action.query);
  return query ? `Grok ran ${toolType}: ${query}` : `Grok ran ${toolType}`;
}

/**
 * How many agent-unit timestamps an assistant history line consumes: one for
 * the assistant message itself (when it has text) plus one per tool call.
 */
function agentUnitsFor(entry) {
  const toolCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls.length : 0;
  return (asString(entry.content) ? 1 : 0) + toolCalls;
}

/**
 * chat_history.jsonl -> squab's canonical message array.
 *
 * opts.timeline  result of buildTimeline(updates.jsonl), optional
 * opts.baseTime  ISO string used as the fallback clock (summary.created_at)
 */
function historyToMessages(historyText, opts = {}) {
  const { entries, warnings } = inspectHistory(historyText);
  const timeline = opts.timeline ?? emptyTimeline();
  const baseMs = parseIsoMs(opts.baseTime) ?? 0;
  const messages = [];
  let agentIndex = 0;
  let previousMs = null;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const type = asString(entry.type);
    if (type === "system" || type === "reasoning") continue;

    let candidateMs = null;
    const produced = [];

    if (type === "user") {
      if (entry.synthetic_reason !== undefined) continue;
      const text = unwrapUserQuery(joinTextBlocks(entry.content, "\n"));
      if (typeof entry.prompt_index === "number") {
        const fromTimeline = timeline.userTs.get(Math.trunc(entry.prompt_index));
        if (fromTimeline !== undefined) candidateMs = fromTimeline;
      }
      produced.push({ type: "user_message", text });
    } else if (type === "assistant") {
      const units = agentUnitsFor(entry);
      if (agentIndex < timeline.agentTs.length) candidateMs = timeline.agentTs[agentIndex];
      agentIndex += units;
      const content = asString(entry.content);
      if (content) produced.push({ type: "assistant_message", text: content });
      const toolCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
      for (const call of toolCalls) {
        if (!isPlainObject(call)) continue;
        const rawArgs = call.arguments;
        let input;
        if (isPlainObject(rawArgs)) {
          input = rawArgs;
        } else {
          try {
            const parsed = JSON.parse(asString(rawArgs, "null"));
            input = isPlainObject(parsed) ? parsed : { raw: asString(rawArgs) };
          } catch {
            input = { raw: asString(rawArgs) };
          }
        }
        produced.push({
          type: "tool_use",
          id: asString(call.id),
          tool: asString(call.name, "unknown"),
          input,
        });
      }
    } else if (type === "tool_result") {
      produced.push({
        type: "tool_result",
        toolUseId: asString(entry.tool_call_id),
        output: typeof entry.content === "string" ? entry.content : joinTextBlocks(entry.content, "\n"),
      });
    } else if (type === "backend_tool_call") {
      produced.push({ type: "system_note", text: describeBackendToolCall(entry) });
    }

    if (produced.length === 0) continue;
    let ms = candidateMs ?? baseMs + i;
    if (previousMs !== null && ms < previousMs) ms = previousMs;
    previousMs = ms;
    const timestamp = toIso(ms);
    for (const message of produced) messages.push({ ...message, timestamp });
  }

  return { messages, warnings };
}

/**
 * Canonical message array -> chat_history.jsonl line objects (the leading
 * "system" line is supplied by the caller). Consecutive assistant_message and
 * tool_use messages collapse into a single assistant line, matching Grok.
 */
function messagesToHistory(messages, opts = {}) {
  const modelId = opts.modelId ?? "grok-4.6";
  const reasoningEffort = opts.reasoningEffort ?? "high";
  const lines = [];
  let promptIndex = 0;
  let i = 0;

  while (i < messages.length) {
    const message = messages[i];
    const type = message?.type;

    if (type === "handoff_marker" || type === "image") {
      i++;
      continue;
    }
    if (type === "user_message") {
      lines.push({
        type: "user",
        content: [{ type: "text", text: asString(message.text) }],
        prompt_index: promptIndex,
      });
      promptIndex++;
      i++;
      continue;
    }
    if (type === "system_note") {
      // Synthetic user turns carry the current prompt_index without consuming
      // it; readNative skips them, so the index never has to line up.
      lines.push({
        type: "user",
        content: [
          { type: "text", text: `<system_note>${asString(message.text)}</system_note>` },
        ],
        prompt_index: promptIndex,
        synthetic_reason: HANDOFF_SYNTHETIC_REASON,
      });
      i++;
      continue;
    }
    if (type === "tool_result") {
      lines.push({
        type: "tool_result",
        tool_call_id: asString(message.toolUseId),
        content: asString(message.output),
      });
      i++;
      continue;
    }
    if (type === "assistant_message" || type === "tool_use") {
      const texts = [];
      const toolCalls = [];
      while (
        i < messages.length &&
        (messages[i].type === "assistant_message" || messages[i].type === "tool_use")
      ) {
        const current = messages[i];
        if (current.type === "assistant_message") {
          const text = asString(current.text);
          if (text) texts.push(text);
        } else {
          toolCalls.push({
            id: asString(current.id),
            name: asString(current.tool, "unknown"),
            arguments: JSON.stringify(current.input ?? {}),
          });
        }
        i++;
      }
      const line = {
        type: "assistant",
        content: texts.join("\n\n"),
        model_id: modelId,
        reasoning_effort: reasoningEffort,
      };
      if (toolCalls.length > 0) line.tool_calls = toolCalls;
      lines.push(line);
      continue;
    }
    i++;
  }
  return lines;
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
        parsed.push({ id: null, ts, role: "user", type: "message", text: truncateText(message.text) });
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
  HANDOFF_SYNTHETIC_REASON,
  KNOWN_HISTORY_TYPES,
  isPlainObject,
  asString,
  asFiniteNumber,
  truncateText,
  emptyUsage,
  addUsage,
  mapTurnUsage,
  parseJsonl,
  inspectHistory,
  toIso,
  parseIsoMs,
  buildTimeline,
  emptyTimeline,
  joinTextBlocks,
  historyToMessages,
  messagesToHistory,
  toParsedMessages,
  applyParseOpts,
};
