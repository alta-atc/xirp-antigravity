import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";

import { grokAdapter, grokHarnessDef, registerGrok } from "../src/harness/adapter.js";
import { useTempGrokHome, tempDir, installFixture } from "./helpers.js";

const BASIC_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "99999999-8888-4777-8666-555555555555";

function stripTimestamps(messages) {
  return messages.map(({ timestamp, ...rest }) => rest);
}

test("sessionRoot / locateLatest / findBySessionId address the right files", async (t) => {
  const home = await useTempGrokHome(t);
  const installed = await installFixture(home, "session-basic");

  assert.equal(grokAdapter.sessionRoot(installed.cwd), installed.bucketDir);
  assert.equal(await grokAdapter.locateLatest(installed.cwd), installed.sessionFile);
  assert.equal(
    await grokAdapter.findBySessionId(installed.cwd, BASIC_ID),
    installed.sessionFile,
  );
  assert.equal(await grokAdapter.findBySessionId(installed.cwd, "nope"), null);
  assert.equal(await grokAdapter.locateLatest("/Users/example/empty"), null);
});

test("readEmbeddedSessionId reads summary.json, falling back to the directory name", async (t) => {
  const home = await useTempGrokHome(t);
  const installed = await installFixture(home, "session-basic");
  assert.equal(await grokAdapter.readEmbeddedSessionId(installed.sessionFile), BASIC_ID);

  await fsp.rm(path.join(installed.sessionDir, "summary.json"));
  assert.equal(await grokAdapter.readEmbeddedSessionId(installed.sessionFile), BASIC_ID);
});

test("readNative returns the canonical message array for the fixture", async (t) => {
  const home = await useTempGrokHome(t);
  const installed = await installFixture(home, "session-basic");
  const messages = await grokAdapter.readNative(installed.sessionFile);
  assert.equal(messages.length, 9);
  assert.deepEqual(
    messages.map((m) => m.type),
    [
      "user_message",
      "assistant_message",
      "tool_use",
      "tool_result",
      "system_note",
      "assistant_message",
      "user_message",
      "tool_use",
      "tool_result",
    ],
  );
  assert.equal(await grokAdapter.readNative(path.join(home, "missing.jsonl")).then((m) => m.length), 0);
});

test("writeNative round-trips through readNative", async (t) => {
  const home = await useTempGrokHome(t);
  const cwd = "/Users/example/roundtrip";
  const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const now = "2026-09-12T08:00:00.000Z";
  const input = [
    { type: "user_message", text: "Add a test.", timestamp: now },
    { type: "assistant_message", text: "On it.", timestamp: now },
    {
      type: "tool_use",
      id: "call-write-1",
      tool: "write_file",
      input: { target_file: "t.js", contents: "ok" },
      timestamp: now,
    },
    { type: "tool_result", toolUseId: "call-write-1", output: "wrote 2 bytes", timestamp: now },
    { type: "user_message", text: "Thanks!", timestamp: now },
  ];

  const dir = grokAdapter.sessionRoot(cwd);
  const written = await grokAdapter.writeNative(input, dir, cwd, sessionId);
  assert.equal(written, path.join(dir, sessionId, "chat_history.jsonl"));

  const readBack = await grokAdapter.readNative(written);
  assert.deepEqual(stripTimestamps(readBack), stripTimestamps(input));

  const summary = JSON.parse(await fsp.readFile(path.join(dir, sessionId, "summary.json"), "utf-8"));
  assert.deepEqual(summary.info, { id: sessionId, cwd });
  assert.equal(summary.chat_format_version, 1);
  assert.equal(summary.num_messages, 0);
  assert.equal(summary.num_chat_messages, 4);
  assert.equal(summary.grok_home, home);

  const dirMode = (await fsp.stat(path.join(dir, sessionId))).mode & 0o777;
  const fileMode = (await fsp.stat(written)).mode & 0o777;
  assert.equal(dirMode, 0o700);
  assert.equal(fileMode, 0o600);
});

test("writeNative drops images and handoff markers and keeps notes synthetic", async (t) => {
  const home = await useTempGrokHome(t);
  const cwd = "/Users/example/drops";
  const sessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const written = await grokAdapter.writeNative(
    [
      { type: "handoff_marker", timestamp: "2026-09-12T08:00:00.000Z" },
      { type: "system_note", text: "carried over from xirp", timestamp: "2026-09-12T08:00:00.000Z" },
      {
        type: "image",
        mimeType: "image/png",
        data: { kind: "base64", bytes: "AAAA" },
        timestamp: "2026-09-12T08:00:00.000Z",
      },
      { type: "user_message", text: "continue", timestamp: "2026-09-12T08:00:00.000Z" },
    ],
    grokAdapter.sessionRoot(cwd),
    cwd,
    sessionId,
  );

  const lines = (await fsp.readFile(written, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.type), ["system", "user", "user"]);
  assert.equal(lines[1].synthetic_reason, "xirp_handoff");
  assert.equal(lines[1].content[0].text, "<system_note>carried over from xirp</system_note>");
  assert.equal(lines[2].content[0].text, "continue");

  const readBack = await grokAdapter.readNative(written);
  assert.deepEqual(stripTimestamps(readBack), [{ type: "user_message", text: "continue" }]);
  assert.ok(home);
});

test("writeNative reuses the system prompt of the newest existing session", async (t) => {
  const home = await useTempGrokHome(t);
  await installFixture(home, "session-basic");
  const cwd = "/Users/example/seeded";
  const written = await grokAdapter.writeNative(
    [{ type: "user_message", text: "hi", timestamp: "2026-09-12T08:00:00.000Z" }],
    grokAdapter.sessionRoot(cwd),
    cwd,
    "cccccccc-dddd-4eee-8fff-000000000000",
  );
  const first = JSON.parse((await fsp.readFile(written, "utf-8")).split("\n")[0]);
  assert.equal(first.type, "system");
  assert.equal(first.content, "You are Grok Build, a synthetic fixture system prompt.");
});

test("writeNoticeSeed creates a fresh session holding one user message", async (t) => {
  const home = await useTempGrokHome(t);
  const cwd = "/Users/example/notice";
  const sessionId = "dddddddd-eeee-4fff-8000-111111111111";
  const written = await grokAdapter.writeNoticeSeed(
    grokAdapter.sessionRoot(cwd),
    cwd,
    sessionId,
    "Session was handed over by xirp.",
  );
  const messages = await grokAdapter.readNative(written);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "user_message");
  assert.equal(messages[0].text, "Session was handed over by xirp.");
  assert.ok(home);
});

test("parseSessionFile totals match the hand-computed fixture numbers", async (t) => {
  const home = await useTempGrokHome(t);
  const installed = await installFixture(home, "session-basic");
  const parsed = await grokAdapter.parseSessionFile(installed.sessionFile, {});

  assert.equal(parsed.schema, "squab.session-parsed/v1");
  assert.equal(parsed.agent, "grok");
  assert.equal(parsed.sessionId, BASIC_ID);
  assert.equal(parsed.model, "grok-4.6-build");
  assert.equal(parsed.summary, "Walked through the build script.");
  assert.equal(parsed.contextWindowSize, null);
  assert.equal(parsed.messageCount, 9);
  assert.equal(parsed.messages.length, 9);
  assert.deepEqual(parsed.lastUserMessage, { text: "Thanks.", ts: "2026-09-10T12:00:10.000Z" });
  assert.deepEqual(parsed.metadataWatchPaths, [
    path.join(installed.sessionDir, "summary.json"),
    path.join(installed.sessionDir, "updates.jsonl"),
  ]);
  // 1200 + 2100 in, 340 + 55 out, 800 + 1500 cached reads, 100 + 0 cache writes.
  assert.deepEqual(parsed.totalUsage, {
    inputTokens: 3300,
    outputTokens: 395,
    cacheReadTokens: 2300,
    cacheWriteTokens: 100,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
  });
  assert.deepEqual(parsed.latestUsage, {
    inputTokens: 2100,
    outputTokens: 55,
    cacheReadTokens: 1500,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
  });
});

test("parseSessionFile zeroes usage when updates.jsonl is absent", async (t) => {
  const home = await useTempGrokHome(t);
  const installed = await installFixture(home, "session-basic");
  await fsp.rm(path.join(installed.sessionDir, "updates.jsonl"));
  const parsed = await grokAdapter.parseSessionFile(installed.sessionFile, {});
  assert.equal(parsed.latestUsage, null);
  assert.equal(parsed.totalUsage.inputTokens, 0);
  assert.equal(parsed.messageCount, 9);
});

test("parseSessionFile refuses files above maxBytes", async (t) => {
  const home = await useTempGrokHome(t);
  const installed = await installFixture(home, "session-basic");
  await assert.rejects(
    () => grokAdapter.parseSessionFile(installed.sessionFile, { maxBytes: 10 }),
    (error) => {
      assert.ok(error.message.startsWith("session file too large"), error.message);
      assert.equal(error.name, "ParseFileTooLargeError");
      return true;
    },
  );
});

test("parseSessionFile honours since and limit options", async (t) => {
  const home = await useTempGrokHome(t);
  const installed = await installFixture(home, "session-basic");
  const limited = await grokAdapter.parseSessionFile(installed.sessionFile, { limit: 2 });
  assert.equal(limited.messages.length, 2);
  assert.equal(limited.messageCount, 9, "messageCount is the unfiltered total");

  const since = await grokAdapter.parseSessionFile(installed.sessionFile, {
    since: "2026-09-10T12:00:04.000Z",
  });
  assert.deepEqual(since.messages.map((m) => m.text), ["Thanks.", 'list_dir({"path":"."})', "scripts/"]);
});

test("findImportTranscript searches every bucket for a session id prefix", async (t) => {
  const home = await useTempGrokHome(t);
  const basic = await installFixture(home, "session-basic");
  await installFixture(home, "session-other");

  const found = await grokAdapter.findImportTranscript(basic.cwd, "99999999");
  assert.equal(found.nativeSessionId, OTHER_ID);
  assert.equal(found.nativeCwd, "/Users/example/other-proj");
  assert.equal(path.basename(found.path), "chat_history.jsonl");

  assert.equal(await grokAdapter.findImportTranscript(basic.cwd, "deadbeef"), null);
});

test("findImportTranscript without an id returns the newest session in the bucket", async (t) => {
  const home = await useTempGrokHome(t);
  const basic = await installFixture(home, "session-basic");
  const found = await grokAdapter.findImportTranscript(basic.cwd, null);
  assert.equal(found.nativeSessionId, BASIC_ID);
  assert.equal(found.nativeCwd, "/Users/example/proj");
  assert.equal(found.path, basic.sessionFile);
});

test("findImportTranscript rejects an ambiguous session id prefix", async (t) => {
  const home = await useTempGrokHome(t);
  await installFixture(home, "session-basic");
  await installFixture(home, "session-basic", { cwd: "/Users/example/second-checkout" });
  await assert.rejects(
    () => grokAdapter.findImportTranscript("/Users/example/proj", "1111"),
    /Multiple grok sessions match "1111"; use a longer session ID/,
  );
});

test("forkNative copies the session dir and rewrites its identifiers", async (t) => {
  const home = await useTempGrokHome(t);
  const installed = await installFixture(home, "session-basic");
  const destCwd = "/Users/example/fork-target";
  const destDir = grokAdapter.sessionRoot(destCwd);
  const newId = "f0f0f0f0-1111-4222-8333-444444444444";

  const forked = await grokAdapter.forkNative(installed.sessionFile, newId, destCwd, destDir);
  assert.equal(forked, path.join(destDir, newId, "chat_history.jsonl"));

  const summary = JSON.parse(
    await fsp.readFile(path.join(destDir, newId, "summary.json"), "utf-8"),
  );
  assert.equal(summary.info.id, newId);
  assert.equal(summary.info.cwd, destCwd);
  assert.equal(summary.session_summary, "Walked through the build script.");

  const updates = (await fsp.readFile(path.join(destDir, newId, "updates.jsonl"), "utf-8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(updates.length, 10);
  for (const record of updates) {
    assert.equal(record.params.sessionId, newId);
    assert.match(record.params._meta.eventId, new RegExp(`^${newId}-\\d+$`));
  }
  assert.equal(updates[0].params._meta.eventId, `${newId}-1`);
  assert.equal(updates.at(-1).params._meta.eventId, `${newId}-10`);

  // The conversation itself is copied verbatim.
  assert.deepEqual(
    await grokAdapter.readNative(forked),
    await grokAdapter.readNative(installed.sessionFile),
  );
});

test("resumeArgs and formatResumeCommand use --resume with the session id", async (t) => {
  const dir = await tempDir(t);
  const sessionFile = path.join(dir, BASIC_ID, "chat_history.jsonl");
  assert.deepEqual(grokAdapter.resumeArgs(sessionFile), ["--resume", BASIC_ID]);
  assert.equal(grokAdapter.formatResumeCommand(sessionFile, "grok"), `grok --resume ${BASIC_ID}`);
  assert.equal(grokAdapter.formatResumeCommand(sessionFile), `grok --resume ${BASIC_ID}`);
});

test("freshLaunchArgs pins a session id unless the user already chose one", () => {
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  assert.deepEqual(grokAdapter.freshLaunchArgs(id, []), ["--session-id", id]);
  assert.deepEqual(grokAdapter.freshLaunchArgs(id, ["--model", "grok-4.6"]), [
    "--session-id",
    id,
  ]);
  for (const conflicting of [
    ["--session-id", "x"],
    ["--session-id=x"],
    ["-s", "x"],
    ["--resume"],
    ["--resume=x"],
    ["-r"],
    ["-c"],
    ["--continue"],
    ["--fork-session"],
  ]) {
    assert.deepEqual(
      grokAdapter.freshLaunchArgs(id, conflicting),
      [],
      `expected no args for ${conflicting.join(" ")}`,
    );
  }
});

test("sanitize is the identity", () => {
  const messages = [{ type: "user_message", text: "x", timestamp: "2026-09-12T00:00:00.000Z" }];
  assert.equal(grokAdapter.sanitize(messages), messages);
});

test("settingsCatalog lists unique (scope, id) pairs", () => {
  assert.equal(grokAdapter.settingsCatalog.lastUpdated, "2026-09-12");
  const items = grokAdapter.settingsCatalog.list();
  const keys = items.map((item) => `${item.scope}:${item.id}`);
  assert.equal(new Set(keys).size, keys.length, "(scope, id) pairs must be unique");
  assert.deepEqual(
    items.map((item) => item.path),
    [
      "~/.grok/config.toml",
      "<cwd>/.grok/config.toml",
      "<cwd>/AGENTS.md",
      "~/.grok/hooks/xirp.json",
      "<cwd>/.mcp.json",
    ],
  );
  for (const item of items) {
    assert.ok(["global", "project"].includes(item.scope));
    assert.ok(["toml", "markdown", "json"].includes(item.format));
    assert.ok(item.label && item.description);
  }
});

test("registerGrok registers the harness first, then the adapter", () => {
  const calls = [];
  registerGrok(
    (adapter) => calls.push({ kind: "adapter", value: adapter }),
    (def) => calls.push({ kind: "harness", value: def }),
  );
  assert.deepEqual(calls.map((c) => c.kind), ["harness", "adapter"]);
  assert.equal(calls[0].value, grokHarnessDef);
  assert.equal(calls[1].value, grokAdapter);
});

test("the harness definition matches squab's expected shape", () => {
  assert.deepEqual(grokHarnessDef, {
    flag: "--launch-grok",
    cmd: "launch-grok",
    agentName: "grok",
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
  });
});

test("the adapter exposes every required member and the hook trio", () => {
  for (const required of [
    "sessionRoot",
    "locateLatest",
    "findBySessionId",
    "findImportTranscript",
    "readEmbeddedSessionId",
    "readNative",
    "writeNative",
    "resumeArgs",
    "writeNoticeSeed",
    "parseSessionFile",
    "freshLaunchArgs",
    "formatResumeCommand",
    "terminateKeystrokes",
    "sanitize",
    "forkNative",
  ]) {
    assert.equal(typeof grokAdapter[required], "function", `missing ${required}`);
  }
  assert.equal(grokAdapter.agent, "grok");
  assert.equal(typeof grokAdapter.settingsCatalog.list, "function");
  assert.ok(grokAdapter.hookCapabilities, "hookCapabilities must be implemented");
  assert.equal(typeof grokAdapter.hookScript, "function");
  assert.equal(typeof grokAdapter.hookInstallEntry, "function");
});

test("freshLaunchArgs falls back to recency discovery for non-UUID ids", () => {
  assert.deepEqual(grokAdapter.freshLaunchArgs("not-a-uuid", []), []);
});

test("terminateKeystrokes cancels the turn then sends /exit", () => {
  const keys = grokAdapter.terminateKeystrokes();
  assert.equal(keys[0].bytes, "\x03");
  assert.equal(keys[1].bytes, "/exit\r");
});
