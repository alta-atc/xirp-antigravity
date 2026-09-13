import test from "node:test";
import assert from "node:assert/strict";

import {
  EPOCH_ZERO,
  MAX_TEXT_BYTES,
  extractUserRequest,
  toolNameFromStepType,
  synthesizeToolUseId,
  parseJsonl,
  inspectTranscript,
  transcriptToMessages,
  messagesToTranscript,
  messagesToMarkdown,
  toParsedMessages,
  applyParseOpts,
  truncateText,
  emptyUsage,
  addUsage,
} from "../src/harness/transcript.js";
import { PROBE_ID, RICH_ID, readFixtureTranscript } from "./fixtures/agy-home.js";

test("extractUserRequest keeps only the USER_REQUEST body", () => {
  const content =
    "<USER_REQUEST>\nreply with exactly the word OK\n</USER_REQUEST>\n" +
    "<ADDITIONAL_METADATA>\nThe current local time is: 2026-09-13T10:21:02-06:00.\n</ADDITIONAL_METADATA>\n" +
    "<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection`.\n</USER_SETTINGS_CHANGE>";
  assert.equal(extractUserRequest(content), "reply with exactly the word OK");

  // Without the wrapper, the system-authored blocks are still stripped.
  assert.equal(
    extractUserRequest("bare prompt\n<ADDITIONAL_METADATA>\nnoise\n</ADDITIONAL_METADATA>"),
    "bare prompt",
  );
  assert.equal(extractUserRequest(undefined), "");
});

test("toolNameFromStepType lowercases the step type and drops the CORTEX prefix", () => {
  assert.equal(toolNameFromStepType("VIEW_FILE"), "view_file");
  assert.equal(toolNameFromStepType("CORTEX_STEP_TYPE_RUN_COMMAND"), "run_command");
  assert.equal(toolNameFromStepType(""), "unknown");
});

test("synthesizeToolUseId is deterministic per step and call index", () => {
  assert.equal(synthesizeToolUseId(5, 1), "step-5-call-1");
  assert.notEqual(synthesizeToolUseId(5, 0), synthesizeToolUseId(5, 1));
});

test("parseJsonl reports invalid lines instead of throwing", () => {
  const { rows, warnings } = parseJsonl('{"a":1}\nnot json\n[1,2]\n\n{"b":2}\n');
  assert.deepEqual(
    rows.map((row) => row.value),
    [{ a: 1 }, { b: 2 }],
  );
  assert.deepEqual(warnings, [
    { line: 2, reason: "invalid-json" },
    { line: 3, reason: "not-an-object" },
  ]);
  assert.deepEqual(parseJsonl(""), { rows: [], warnings: [] });
});

test("inspectTranscript counts every step type it sees", async () => {
  const text = await readFixtureTranscript(PROBE_ID);
  const { counts, steps } = inspectTranscript(text);
  assert.equal(steps.length, 11);
  assert.deepEqual(counts, { USER_INPUT: 1, PLANNER_RESPONSE: 5, ERROR_MESSAGE: 5 });
});

test("the probe transcript maps to one user message and five error notes", async () => {
  const text = await readFixtureTranscript(PROBE_ID);
  const { messages, skipped } = transcriptToMessages(text);

  assert.equal(messages.length, 6);
  assert.deepEqual(messages[0], {
    type: "user_message",
    text: "reply with exactly the word OK",
    timestamp: "2026-09-13T16:21:02.000Z",
  });
  // The five PLANNER_RESPONSE steps carry neither text nor tool calls.
  assert.equal(skipped, 5);
  for (const message of messages.slice(1)) {
    assert.equal(message.type, "system_note");
    assert.match(message.text, /^Error: The stream was interrupted/);
  }
});

test("a rich transcript maps assistant text, tool calls, tool results and errors", async () => {
  const text = await readFixtureTranscript(RICH_ID);
  const { messages, skipped } = transcriptToMessages(text);

  assert.deepEqual(
    messages.map((message) => message.type),
    [
      "user_message",
      "assistant_message",
      "tool_use",
      "tool_result",
      "tool_use",
      "tool_use",
      "tool_result",
      "tool_result",
      "system_note",
      "assistant_message",
    ],
  );

  // CONVERSATION_HISTORY (no content) and EPHEMERAL_MESSAGE (CLI boilerplate).
  assert.equal(skipped, 2);

  assert.equal(messages[0].text, "summarise what parser.js does");
  assert.equal(messages[1].text, "I will read parser.js first.");

  const viewCall = messages[2];
  assert.equal(viewCall.tool, "view_file");
  assert.equal(viewCall.id, "step-2-call-0");
  assert.equal(viewCall.input.AbsolutePath, "/fixture/rich-repo/parser.js");

  // VIEW_FILE's derived tool name matches the pending view_file call.
  assert.equal(messages[3].toolUseId, "step-2-call-0");
  assert.match(messages[3].output, /Total Lines: 3/);

  // The second PLANNER_RESPONSE has empty content, so it yields no assistant
  // message -- only its two tool calls.
  assert.equal(messages[4].tool, "run_command");
  assert.equal(messages[4].id, "step-5-call-0");
  assert.equal(messages[5].tool, "list_dir");
  assert.equal(messages[5].id, "step-5-call-1");

  // RUN_COMMAND matches run_command by name; LIST_DIRECTORY does not match
  // "list_dir", so it falls back to the oldest unmatched call.
  assert.equal(messages[6].toolUseId, "step-5-call-0");
  assert.equal(messages[7].toolUseId, "step-5-call-1");

  // ERROR_MESSAGE prefers the structured `error` field over `content`.
  assert.equal(messages[8].type, "system_note");
  assert.equal(messages[8].text, "There was a problem parsing the tool call.");

  assert.equal(messages[9].text, "`parser.js` exports a single `parse` function that wraps `JSON.parse`.");

  // `thinking` is the model's private reasoning and is never surfaced.
  assert.equal(
    messages.some((message) => String(message.text ?? "").includes("Planning the read")),
    false,
  );
});

test("timestamps come from created_at and never move backwards", () => {
  const text = [
    '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","created_at":"2026-01-02T03:04:05Z","content":"<USER_REQUEST>\\nhi\\n</USER_REQUEST>"}',
    '{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","created_at":"2020-01-01T00:00:00Z","content":"out of order"}',
    '{"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","content":"no created_at"}',
  ].join("\n");
  const { messages } = transcriptToMessages(text, { baseTime: "2026-01-02T03:04:05Z" });
  assert.equal(messages[0].timestamp, "2026-01-02T03:04:05.000Z");
  assert.equal(messages[1].timestamp, "2026-01-02T03:04:05.000Z", "clamped forward");
  // No created_at at all: baseTime offset by the step's position in the file.
  assert.equal(messages[2].timestamp, "2026-01-02T03:04:05.002Z");
});

test("transcriptToMessages tolerates empty and unparseable input", () => {
  assert.deepEqual(transcriptToMessages("").messages, []);
  const { messages, warnings } = transcriptToMessages("not json\n");
  assert.deepEqual(messages, []);
  assert.deepEqual(warnings, [{ line: 1, reason: "invalid-json" }]);
});

test("messagesToTranscript round-trips canonical messages through agy's step shape", async () => {
  const original = transcriptToMessages(await readFixtureTranscript(RICH_ID)).messages;
  const steps = messagesToTranscript(original);
  const jsonl = steps.map((step) => JSON.stringify(step)).join("\n");
  const roundTripped = transcriptToMessages(jsonl).messages;

  assert.deepEqual(
    roundTripped.map((message) => message.type),
    original.map((message) => message.type),
  );
  assert.equal(roundTripped[0].text, original[0].text);
  assert.equal(roundTripped[1].text, original[1].text);
  assert.equal(roundTripped[2].tool, "view_file");
  assert.deepEqual(roundTripped[2].input, original[2].input);
  assert.equal(roundTripped[3].output, original[3].output);
  assert.equal(roundTripped[8].text, original[8].text);
  for (let i = 0; i < original.length; i++) {
    assert.equal(roundTripped[i].timestamp, original[i].timestamp, `timestamp ${i}`);
  }
});

test("messagesToTranscript writes step_index, status and agy's own source/type names", () => {
  const steps = messagesToTranscript([
    { type: "user_message", text: "hello", timestamp: "2026-02-01T00:00:00.000Z" },
    { type: "assistant_message", text: "hi", timestamp: "2026-02-01T00:00:01.000Z" },
    { type: "tool_use", id: "x", tool: "view_file", input: { p: 1 }, timestamp: "2026-02-01T00:00:01.000Z" },
    { type: "tool_result", toolUseId: "x", output: "done", timestamp: "2026-02-01T00:00:02.000Z" },
    { type: "system_note", text: "note", timestamp: "2026-02-01T00:00:03.000Z" },
    { type: "handoff_marker", timestamp: "2026-02-01T00:00:04.000Z" },
  ]);

  assert.deepEqual(
    steps.map((step) => [step.step_index, step.source, step.type]),
    [
      [0, "USER_EXPLICIT", "USER_INPUT"],
      [1, "MODEL", "PLANNER_RESPONSE"],
      [2, "MODEL", "GENERIC"],
      [3, "SYSTEM", "SYSTEM_MESSAGE"],
    ],
  );
  assert.ok(steps.every((step) => step.status === "DONE"));
  assert.equal(steps[0].content, "<USER_REQUEST>\nhello\n</USER_REQUEST>");
  // The assistant message and the tool call collapse into one PLANNER_RESPONSE.
  assert.equal(steps[1].content, "hi");
  assert.deepEqual(steps[1].tool_calls, [{ name: "view_file", args: { p: 1 } }]);
});

test("messagesToMarkdown renders a transcript an agent can read", async () => {
  const messages = transcriptToMessages(await readFixtureTranscript(RICH_ID)).messages;
  const markdown = messagesToMarkdown(messages, { cwd: "/fixture/rich-repo" });

  assert.match(markdown, /^# Handed-off conversation/);
  assert.match(markdown, /Working directory: `\/fixture\/rich-repo`/);
  assert.match(markdown, /## User — 2026-09-12T10:00:00\.000Z/);
  assert.match(markdown, /summarise what parser\.js does/);
  assert.match(markdown, /### Tool call: `view_file`/);
  assert.match(markdown, /> \*\*System:\*\* There was a problem parsing the tool call\./);
  assert.equal(markdown.endsWith("\n"), true);
});

test("toParsedMessages flattens canonical messages into squab's row shape", () => {
  const rows = toParsedMessages([
    { type: "user_message", text: "hi", timestamp: "2026-02-01T00:00:00.000Z" },
    { type: "assistant_message", text: "yo", timestamp: "2026-02-01T00:00:01.000Z" },
    { type: "tool_use", id: "t1", tool: "view_file", input: { a: 1 }, timestamp: "2026-02-01T00:00:02.000Z" },
    { type: "tool_result", toolUseId: "t1", output: "ok", timestamp: "2026-02-01T00:00:03.000Z" },
    { type: "tool_result", toolUseId: "t2", output: "bad", error: "boom", timestamp: "2026-02-01T00:00:04.000Z" },
    { type: "system_note", text: "note", timestamp: "2026-02-01T00:00:05.000Z" },
    { type: "unknown_kind", timestamp: "2026-02-01T00:00:06.000Z" },
  ]);

  assert.deepEqual(
    rows.map((row) => [row.role, row.type]),
    [
      ["user", "message"],
      ["assistant", "message"],
      ["assistant", "tool_use"],
      ["tool", "tool_result"],
      ["tool", "tool_result"],
      ["system", "message"],
    ],
  );
  assert.equal(rows[2].toolName, "view_file");
  assert.deepEqual(rows[2].toolInput, { a: 1 });
  assert.equal(rows[2].text, 'view_file({"a":1})');
  assert.equal(rows[3].toolError, false);
  assert.equal(rows[4].toolError, true);
  assert.equal(rows[0].id, null);
});

test("applyParseOpts honours since, limit and summaryOnly", () => {
  const rows = [
    { ts: "2026-01-01T00:00:00.000Z" },
    { ts: "2026-01-02T00:00:00.000Z" },
    { ts: "2026-01-03T00:00:00.000Z" },
  ];
  assert.equal(applyParseOpts(rows, undefined), rows);
  assert.deepEqual(applyParseOpts(rows, { summaryOnly: true }), []);
  assert.equal(applyParseOpts(rows, { since: "2026-01-01T12:00:00.000Z" }).length, 2);
  assert.equal(applyParseOpts(rows, { limit: 1 }).length, 1);
  assert.equal(applyParseOpts(rows, { limit: 0 }).length, 0);
});

test("truncateText is byte-bounded and never splits a surrogate pair", () => {
  assert.equal(truncateText("short"), "short");
  assert.equal(truncateText(undefined), "");

  const long = "a".repeat(MAX_TEXT_BYTES + 100);
  const cut = truncateText(long);
  assert.ok(Buffer.byteLength(cut) <= MAX_TEXT_BYTES);
  assert.match(cut, /\[truncated\]$/);

  // "😀" is a surrogate pair; slicing at an odd boundary must not split it.
  const emoji = "😀".repeat(20);
  const tight = truncateText(emoji, 30);
  assert.ok(Buffer.byteLength(tight) <= 30);
  assert.equal(tight.includes("�"), false);
  assert.equal(JSON.parse(JSON.stringify(tight)), tight);
});

test("usage is all zeroes, because agy's transcript carries no token counts", () => {
  const usage = emptyUsage();
  assert.deepEqual(usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
  });
  addUsage(usage, { inputTokens: 3, outputTokens: 4 });
  assert.equal(usage.inputTokens, 3);
  assert.equal(usage.outputTokens, 4);
  assert.equal(addUsage(usage, null), usage);
});

test("EPOCH_ZERO is the fallback clock", () => {
  assert.equal(EPOCH_ZERO, "1970-01-01T00:00:00.000Z");
});
