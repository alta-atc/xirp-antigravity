import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTimeline,
  historyToMessages,
  inspectHistory,
  mapTurnUsage,
  messagesToHistory,
  toParsedMessages,
} from "../src/harness/transcript.js";
import { readFixture } from "./helpers.js";

const CREATED_AT = "2026-09-10T12:00:00.000Z";

async function basicMessages() {
  const history = await readFixture("session-basic", "chat_history.jsonl");
  const updates = await readFixture("session-basic", "updates.jsonl");
  return historyToMessages(history, { timeline: buildTimeline(updates), baseTime: CREATED_AT });
}

test("every chat_history line type maps to the right canonical message", async () => {
  const { messages } = await basicMessages();
  assert.deepEqual(messages, [
    {
      type: "user_message",
      text: "Explain the build script.",
      timestamp: "2026-09-10T12:00:00.000Z",
    },
    {
      type: "assistant_message",
      text: "Reading it now.",
      timestamp: "2026-09-10T12:00:01.000Z",
    },
    {
      type: "tool_use",
      id: "call-aaaa-1",
      tool: "read_file",
      input: { target_file: "scripts/build.js" },
      timestamp: "2026-09-10T12:00:01.000Z",
    },
    {
      type: "tool_result",
      toolUseId: "call-aaaa-1",
      output: "console.log('hi')",
      timestamp: "2026-09-10T12:00:01.000Z",
    },
    {
      type: "system_note",
      text: "Grok ran web_search: grok cli docs",
      timestamp: "2026-09-10T12:00:01.000Z",
    },
    {
      type: "assistant_message",
      text: "It logs a greeting.",
      timestamp: "2026-09-10T12:00:04.000Z",
    },
    { type: "user_message", text: "Thanks.", timestamp: "2026-09-10T12:00:10.000Z" },
    {
      type: "tool_use",
      id: "call-bbbb-1",
      tool: "list_dir",
      input: { path: "." },
      timestamp: "2026-09-10T12:00:11.000Z",
    },
    {
      type: "tool_result",
      toolUseId: "call-bbbb-1",
      output: "scripts/",
      timestamp: "2026-09-10T12:00:11.000Z",
    },
  ]);
});

test("system, reasoning and synthetic user lines are skipped", async () => {
  const { messages } = await basicMessages();
  assert.equal(
    messages.some((m) => m.text && m.text.includes("<system_note>")),
    false,
  );
  assert.equal(
    messages.some((m) => m.text && m.text.includes("Look at the file first.")),
    false,
  );
});

test("inspectHistory counts unknown line types as warnings", async () => {
  const history = await readFixture("session-basic", "chat_history.jsonl");
  const { entries, warnings, counts } = inspectHistory(history);
  assert.equal(entries.length, 11);
  assert.deepEqual(warnings, [{ line: 12, reason: "unknown-type", type: "future_line_type" }]);
  assert.equal(counts.assistant, 3);
  assert.equal(counts.user, 3);
  assert.equal(counts.backend_tool_call, 1);
  assert.equal(counts.future_line_type, 1);
});

test("malformed JSONL lines are reported, not thrown", () => {
  const text = '{"type":"user","content":[{"type":"text","text":"hi"}],"prompt_index":0}\nnot json\n42\n';
  const { entries, warnings } = inspectHistory(text);
  assert.equal(entries.length, 1);
  assert.deepEqual(warnings.map((w) => w.reason).sort(), ["invalid-json", "not-an-object"]);
});

test("tool_call arguments that are not JSON fall back to a raw wrapper", () => {
  const text = JSON.stringify({
    type: "assistant",
    content: "",
    tool_calls: [{ id: "call-x-1", name: "run", arguments: "{oops" }],
  });
  const { messages } = historyToMessages(text, { baseTime: CREATED_AT });
  assert.deepEqual(messages[0].input, { raw: "{oops" });
});

test("timestamps fall back to created_at plus index when updates are missing", async () => {
  const history = await readFixture("session-basic", "chat_history.jsonl");
  const { messages } = historyToMessages(history, { baseTime: CREATED_AT });
  const stamps = messages.map((m) => m.timestamp);
  assert.deepEqual(stamps, [...stamps].sort(), "timestamps are monotonic");
  assert.equal(stamps[0], "2026-09-10T12:00:00.001Z");
  assert.equal(stamps.at(-1), "2026-09-10T12:00:00.009Z");
});

test("buildTimeline collapses streaming chunks and reads usage", async () => {
  const updates = await readFixture("session-basic", "updates.jsonl");
  const timeline = buildTimeline(updates);
  assert.equal(timeline.sessionId, "11111111-2222-4333-8444-555555555555");
  assert.deepEqual([...timeline.userTs.entries()], [
    [0, 1789041600000],
    [1, 1789041610000],
  ]);
  assert.deepEqual(timeline.agentTs, [
    1789041601000, 1789041602000, 1789041604000, 1789041611000,
  ]);
  assert.equal(timeline.usageTurns.length, 2);
});

test("buildTimeline falls back to the unix-seconds timestamp field", () => {
  const line = JSON.stringify({
    timestamp: 1789041600,
    method: "session/update",
    params: {
      sessionId: "s1",
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } },
      _meta: { eventId: "s1-1", promptIndex: 0 },
    },
  });
  assert.equal(buildTimeline(line).userTs.get(0), 1789041600000);
});

test("mapTurnUsage renames Grok's cache fields and drops empty turns", () => {
  assert.deepEqual(
    mapTurnUsage({ inputTokens: 10, outputTokens: 2, cachedReadTokens: 3, cacheCreationTokens: 4 }),
    {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    },
  );
  assert.equal(mapTurnUsage({ inputTokens: 0, outputTokens: 0 }), null);
  assert.equal(mapTurnUsage(null), null);
});

test("messagesToHistory merges an assistant message with its tool calls", () => {
  const lines = messagesToHistory([
    { type: "user_message", text: "go" },
    { type: "assistant_message", text: "working" },
    { type: "tool_use", id: "call-1", tool: "read_file", input: { p: "a" } },
    { type: "tool_result", toolUseId: "call-1", output: "ok" },
    { type: "system_note", text: "note" },
    { type: "handoff_marker" },
    { type: "image", mimeType: "image/png" },
    { type: "user_message", text: "next" },
  ]);
  assert.deepEqual(
    lines.map((l) => l.type),
    ["user", "assistant", "tool_result", "user", "user"],
  );
  assert.equal(lines[0].prompt_index, 0);
  assert.equal(lines[1].content, "working");
  assert.deepEqual(lines[1].tool_calls, [
    { id: "call-1", name: "read_file", arguments: '{"p":"a"}' },
  ]);
  assert.equal(lines[3].synthetic_reason, "xirp_handoff");
  assert.equal(lines[3].content[0].text, "<system_note>note</system_note>");
  assert.equal(lines[4].prompt_index, 1, "synthetic turns do not consume a prompt index");
});

test("toParsedMessages produces squab's flattened row shape", async () => {
  const { messages } = await basicMessages();
  const rows = toParsedMessages(messages);
  assert.equal(rows.length, messages.length);
  assert.deepEqual(rows[0], {
    id: null,
    ts: "2026-09-10T12:00:00.000Z",
    role: "user",
    type: "message",
    text: "Explain the build script.",
  });
  assert.deepEqual(rows[2], {
    id: "call-aaaa-1",
    ts: "2026-09-10T12:00:01.000Z",
    role: "assistant",
    type: "tool_use",
    text: 'read_file({"target_file":"scripts/build.js"})',
    toolName: "read_file",
    toolInput: { target_file: "scripts/build.js" },
  });
  assert.equal(rows[3].role, "tool");
  assert.equal(rows[3].toolError, false);
  assert.equal(rows[4].role, "system");
});

test("historyToMessages unwraps Grok's <user_query> wrapper around typed prompts", async () => {
  const { historyToMessages } = await import("../src/harness/transcript.js");
  const line = JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>\nfix the bug\n</user_query>" }], prompt_index: 0 });
  const { messages } = historyToMessages(line, { baseTime: "2026-01-01T00:00:00.000Z" });
  const user = messages.find((m) => m.type === "user_message");
  assert.equal(user.text, "fix the bug");
});
