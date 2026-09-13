import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  AGENT,
  antigravityAdapter,
  antigravityHarnessDef,
  registerAntigravity,
  settingsCatalogItems,
} from "../src/harness/adapter.js";
import {
  handoffDir,
  handoffTranscriptFile,
  handoffMarkdownFile,
  handoffSessionFile,
  transcriptFileFor,
  conversationDir,
} from "../src/harness/paths.js";
import {
  PROBE_ID,
  RICH_ID,
  META_ONLY_ID,
  IDE_ID,
  PROBE_CWD,
  RICH_CWD,
  META_ONLY_CWD,
  useFixtureAgyHome,
  useEmptyAgyHome,
  useTempHandoffHome,
  fixtureTranscript,
} from "./fixtures/agy-home.js";

/** Both homes, which every adapter test needs to stay off the real machine. */
async function useHomes(t) {
  const home = await useFixtureAgyHome(t);
  const handoff = await useTempHandoffHome(t);
  return { home, handoff };
}

test("registerAntigravity registers the harness definition before the adapter", () => {
  const calls = [];
  registerAntigravity(
    (adapter) => calls.push(["adapter", adapter.agent]),
    (def) => calls.push(["harness", def.agentName]),
  );
  assert.deepEqual(calls, [
    ["harness", "antigravity"],
    ["adapter", "antigravity"],
  ]);
});

test("the harness definition describes the agy CLI", () => {
  assert.equal(AGENT, "antigravity");
  assert.equal(antigravityHarnessDef.flag, "--launch-antigravity");
  assert.equal(antigravityHarnessDef.cmd, "launch-antigravity");
  assert.equal(antigravityHarnessDef.agentName, "antigravity");
  assert.equal(antigravityHarnessDef.binary, "agy");
  assert.equal(antigravityHarnessDef.visibility, "public");
  assert.match(antigravityHarnessDef.installHint, /antigravity\.google/);
  assert.match(antigravityHarnessDef.description, /`agy`/);
  // Google publishes no install script, so there is nothing honest to run.
  assert.deepEqual(antigravityHarnessDef.lifecycle.install, { kind: "none" });
  assert.deepEqual(antigravityHarnessDef.lifecycle.update, {
    kind: "self-update",
    args: ["update"],
  });
  assert.deepEqual(antigravityHarnessDef.lifecycle.uninstall, { kind: "none" });
});

test("sessionRoot is the shared brain directory, since conversations are global", async (t) => {
  const { home } = await useHomes(t);
  assert.equal(antigravityAdapter.sessionRoot(PROBE_CWD), path.join(home, "brain"));
  assert.equal(
    antigravityAdapter.sessionRoot("/some/other/cwd"),
    antigravityAdapter.sessionRoot(PROBE_CWD),
  );
});

test("locateLatest resolves a cwd through cache/last_conversations.json", async (t) => {
  const { home } = await useHomes(t);
  assert.equal(await antigravityAdapter.locateLatest(PROBE_CWD), fixtureTranscript(home, PROBE_ID));
  assert.equal(await antigravityAdapter.locateLatest(RICH_CWD), fixtureTranscript(home, RICH_ID));
});

test("locateLatest ignores a mapped conversation whose transcript is missing", async (t) => {
  await useHomes(t);
  // /fixture/gone-repo maps to an id with no transcript on disk.
  assert.equal(await antigravityAdapter.locateLatest("/fixture/gone-repo"), null);
});

test("locateLatest falls back to the metadata cache and skips IDE conversations", async (t) => {
  const { home } = await useHomes(t);
  // /fixture/meta-only-repo is absent from last_conversations.json; two
  // conversations claim it, but the newer one is an IDE conversation
  // (AppDataDir "antigravity"), which the CLI adapter must not return.
  const ide = fixtureTranscript(home, IDE_ID);
  const now = new Date();
  await fsp.utimes(ide, now, now);
  const older = new Date(Date.now() - 60_000);
  await fsp.utimes(fixtureTranscript(home, META_ONLY_ID), older, older);

  assert.equal(
    await antigravityAdapter.locateLatest(META_ONLY_CWD),
    fixtureTranscript(home, META_ONLY_ID),
  );
});

test("locateLatest returns null when nothing on disk matches", async (t) => {
  await useEmptyAgyHome(t);
  await useTempHandoffHome(t);
  assert.equal(await antigravityAdapter.locateLatest("/nowhere"), null);
});

test("locateLatest finds a seeded handoff when agy has no conversation yet", async (t) => {
  await useEmptyAgyHome(t);
  await useTempHandoffHome(t);
  const seeded = await antigravityAdapter.writeNoticeSeed(
    null,
    "/fixture/fresh-repo",
    "sess-seed",
    "pick up where we left off",
  );
  assert.equal(await antigravityAdapter.locateLatest("/fixture/fresh-repo"), seeded);
  assert.equal(await antigravityAdapter.locateLatest("/fixture/other-repo"), null);
});

test("findBySessionId looks conversations up globally, not per cwd", async (t) => {
  const { home } = await useHomes(t);
  assert.equal(
    await antigravityAdapter.findBySessionId("/any/cwd", RICH_ID),
    fixtureTranscript(home, RICH_ID),
  );
  assert.equal(await antigravityAdapter.findBySessionId(PROBE_CWD, "no-such-id"), null);
  assert.equal(await antigravityAdapter.findBySessionId(PROBE_CWD, ""), null);
});

test("findBySessionId also resolves a handoff pseudo-session", async (t) => {
  await useHomes(t);
  const seeded = await antigravityAdapter.writeNoticeSeed(null, RICH_CWD, "sess-handoff", "hello");
  assert.equal(await antigravityAdapter.findBySessionId(RICH_CWD, "sess-handoff"), seeded);
});

test("findImportTranscript with no id returns the latest conversation and its cwd", async (t) => {
  const { home } = await useHomes(t);
  const found = await antigravityAdapter.findImportTranscript(RICH_CWD, null);
  assert.deepEqual(found, {
    path: fixtureTranscript(home, RICH_ID),
    root: conversationDir(RICH_ID),
    nativeSessionId: RICH_ID,
    nativeCwd: RICH_CWD,
  });
  assert.equal(await antigravityAdapter.findImportTranscript("/nowhere", null), null);
});

test("findImportTranscript matches a unique id prefix and rejects an ambiguous one", async (t) => {
  const { home } = await useHomes(t);
  const found = await antigravityAdapter.findImportTranscript(PROBE_CWD, "668e81c1");
  assert.equal(found.path, fixtureTranscript(home, PROBE_ID));
  assert.equal(found.nativeSessionId, PROBE_ID);
  assert.equal(found.nativeCwd, PROBE_CWD);

  // A handoff sharing a prefix with a real conversation makes "1111" ambiguous.
  await antigravityAdapter.writeNoticeSeed(null, RICH_CWD, "11111111-alternate", "hi");
  await assert.rejects(
    () => antigravityAdapter.findImportTranscript(PROBE_CWD, "1111"),
    /Multiple antigravity conversations match/,
  );
  assert.equal(await antigravityAdapter.findImportTranscript(PROBE_CWD, "deadbeef"), null);

  // A prefix that only the handoff matches still resolves, rooted at its dir.
  const handoffMatch = await antigravityAdapter.findImportTranscript(PROBE_CWD, "11111111-a");
  assert.equal(handoffMatch.nativeSessionId, "11111111-alternate");
  assert.equal(handoffMatch.root, handoffDir("11111111-alternate"));
  assert.equal(handoffMatch.nativeCwd, RICH_CWD);
});

test("nativeCwd reads the live cwd map, then the metadata cache", async (t) => {
  const { home } = await useHomes(t);
  assert.equal(await antigravityAdapter.nativeCwd(fixtureTranscript(home, PROBE_ID)), PROBE_CWD);
  // META_ONLY_ID is absent from last_conversations.json.
  assert.equal(
    await antigravityAdapter.nativeCwd(fixtureTranscript(home, META_ONLY_ID)),
    META_ONLY_CWD,
  );
  assert.equal(await antigravityAdapter.nativeCwd(transcriptFileFor("unknown-id")), null);
});

test("readEmbeddedSessionId takes the conversation id from the path", async (t) => {
  const { home } = await useHomes(t);
  assert.equal(await antigravityAdapter.readEmbeddedSessionId(fixtureTranscript(home, RICH_ID)), RICH_ID);
});

test("readNative parses a real transcript into canonical messages", async (t) => {
  const { home } = await useHomes(t);
  const messages = await antigravityAdapter.readNative(fixtureTranscript(home, RICH_ID));
  assert.equal(messages.length, 10);
  assert.equal(messages[0].type, "user_message");
  assert.equal(messages[0].text, "summarise what parser.js does");

  // A path that does not exist yields no messages rather than throwing.
  assert.deepEqual(await antigravityAdapter.readNative("/no/such/transcript.jsonl"), []);
});

test("writeNative creates a handoff pseudo-session, not an entry in brain/", async (t) => {
  const { home } = await useHomes(t);
  const messages = await antigravityAdapter.readNative(fixtureTranscript(home, RICH_ID));

  const written = await antigravityAdapter.writeNative(
    messages,
    antigravityAdapter.sessionRoot(RICH_CWD),
    RICH_CWD,
    "sess-42",
  );

  assert.equal(written, handoffTranscriptFile("sess-42"));
  // squab's sessionRoot argument is deliberately ignored.
  assert.equal(written.startsWith(path.join(home, "brain")), false);

  const session = JSON.parse(await fsp.readFile(handoffSessionFile("sess-42"), "utf-8"));
  assert.equal(session.id, "sess-42");
  assert.equal(session.cwd, RICH_CWD);
  assert.equal(session.source, "xirp-handoff");
  assert.match(session.createdAt, /^\d{4}-\d{2}-\d{2}T/);

  const markdown = await fsp.readFile(handoffMarkdownFile("sess-42"), "utf-8");
  assert.match(markdown, /summarise what parser\.js does/);
  assert.match(markdown, /Working directory: `\/fixture\/rich-repo`/);

  // The pseudo-session reads back exactly like a real one.
  assert.equal(await antigravityAdapter.readEmbeddedSessionId(written), "sess-42");
  const reread = await antigravityAdapter.readNative(written);
  assert.deepEqual(
    reread.map((message) => message.type),
    messages.map((message) => message.type),
  );
});

test("writeNoticeSeed writes a single-user-message handoff", async (t) => {
  await useHomes(t);
  const written = await antigravityAdapter.writeNoticeSeed(null, PROBE_CWD, "sess-seed", "resume this");
  const messages = await antigravityAdapter.readNative(written);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "user_message");
  assert.equal(messages[0].text, "resume this");
  assert.match(await fsp.readFile(handoffMarkdownFile("sess-seed"), "utf-8"), /resume this/);
});

test("forkNative copies a real conversation into a fresh handoff", async (t) => {
  const { home } = await useHomes(t);
  const source = fixtureTranscript(home, RICH_ID);
  const forked = await antigravityAdapter.forkNative(source, "sess-fork", RICH_CWD, null);

  assert.equal(forked, handoffTranscriptFile("sess-fork"));
  assert.notEqual(forked, source);
  const original = await antigravityAdapter.readNative(source);
  const copy = await antigravityAdapter.readNative(forked);
  assert.deepEqual(
    copy.map((message) => message.type),
    original.map((message) => message.type),
  );
  const session = JSON.parse(await fsp.readFile(handoffSessionFile("sess-fork"), "utf-8"));
  assert.equal(session.id, "sess-fork");
});

test("resumeArgs resumes a real conversation by id", async (t) => {
  const { home } = await useHomes(t);
  const transcript = fixtureTranscript(home, RICH_ID);
  assert.deepEqual(antigravityAdapter.resumeArgs(transcript), ["--conversation", RICH_ID]);
  assert.equal(
    antigravityAdapter.formatResumeCommand(transcript, "agy"),
    `agy --conversation ${RICH_ID}`,
  );
  assert.equal(
    antigravityAdapter.formatResumeCommand(transcript, null),
    `agy --conversation ${RICH_ID}`,
  );
});

test("resumeArgs seeds a launch for a handoff, since agy cannot resume a fabricated id", async (t) => {
  await useHomes(t);
  const written = await antigravityAdapter.writeNoticeSeed(null, PROBE_CWD, "sess-9", "carry on");
  const markdown = handoffMarkdownFile("sess-9");

  const args = antigravityAdapter.resumeArgs(written);
  assert.equal(args.length, 2);
  assert.equal(args[0], "-i");
  assert.equal(
    args[1],
    `Continue the conversation whose transcript is in ${markdown}. Read it first, then carry on from where it left off.`,
  );
  assert.equal(args.includes("--conversation"), false);

  const command = antigravityAdapter.formatResumeCommand(written, "agy");
  assert.match(command, /^agy -i "/);
  assert.ok(command.includes(markdown));
});

test("freshLaunchArgs is empty: agy cannot be told which conversation id to create", () => {
  assert.deepEqual(antigravityAdapter.freshLaunchArgs("any-id", ["--mode", "plan"]), []);
  assert.deepEqual(antigravityAdapter.freshLaunchArgs(), []);
});

test("terminateKeystrokes sends a cancelling Ctrl-C, then the double Ctrl-C that quits", () => {
  assert.deepEqual(antigravityAdapter.terminateKeystrokes(), [
    { bytes: "\x03" },
    { bytes: "\x03\x03", afterMs: 150 },
  ]);
});

test("sanitize passes messages through untouched", () => {
  const messages = [{ type: "user_message", text: "hi", timestamp: "2026-01-01T00:00:00.000Z" }];
  assert.equal(antigravityAdapter.sanitize(messages), messages);
});

test("parseSessionFile returns squab's ParsedSession for a real conversation", async (t) => {
  const { home } = await useHomes(t);
  const parsed = await antigravityAdapter.parseSessionFile(fixtureTranscript(home, RICH_ID));

  assert.equal(parsed.schema, "squab.session-parsed/v1");
  assert.equal(parsed.sessionId, RICH_ID);
  assert.equal(parsed.agent, "antigravity");
  // The model comes from the global settings.json, not from the transcript.
  assert.equal(parsed.model, "Gemini 3.5 Flash (High)");
  assert.equal(parsed.summary, "Summarise the parser");
  assert.equal(parsed.messageCount, 10);
  assert.deepEqual(parsed.lastUserMessage, {
    text: "summarise what parser.js does",
    ts: "2026-09-12T10:00:00.000Z",
  });
  // agy's transcript carries no token accounting at all.
  assert.deepEqual(parsed.totalUsage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
  });
  assert.equal(parsed.latestUsage, null);
  assert.equal(parsed.contextWindowSize, null);
  assert.deepEqual(parsed.metadataWatchPaths, [
    path.join(home, "cache", "last_conversations.json"),
    path.join(home, "cache", "conversation_metadata.json"),
    path.join(home, "settings.json"),
  ]);
  assert.equal(parsed.messages.length, 10);
});

test("parseSessionFile handles a handoff pseudo-session", async (t) => {
  await useHomes(t);
  const written = await antigravityAdapter.writeNoticeSeed(null, PROBE_CWD, "sess-p", "hello there");
  const parsed = await antigravityAdapter.parseSessionFile(written);

  assert.equal(parsed.sessionId, "sess-p");
  assert.equal(parsed.summary, null, "a handoff has no agy-side summary");
  assert.deepEqual(parsed.metadataWatchPaths, [handoffSessionFile("sess-p")]);
  assert.equal(parsed.messageCount, 1);
  assert.equal(parsed.lastUserMessage.text, "hello there");
});

test("parseSessionFile applies squab's parse options", async (t) => {
  const { home } = await useHomes(t);
  const transcript = fixtureTranscript(home, RICH_ID);

  const limited = await antigravityAdapter.parseSessionFile(transcript, { limit: 3 });
  assert.equal(limited.messages.length, 3);
  assert.equal(limited.messageCount, 10, "messageCount counts the whole file");

  const summaryOnly = await antigravityAdapter.parseSessionFile(transcript, { summaryOnly: true });
  assert.deepEqual(summaryOnly.messages, []);

  const since = await antigravityAdapter.parseSessionFile(transcript, {
    since: "2026-09-12T10:00:04.000Z",
  });
  assert.ok(since.messages.length > 0);
  assert.ok(since.messages.every((row) => row.ts > "2026-09-12T10:00:04.000Z"));
});

test("parseSessionFile raises named errors for a missing or oversized file", async (t) => {
  const { home } = await useHomes(t);
  await assert.rejects(
    () => antigravityAdapter.parseSessionFile(path.join(home, "brain", "nope", "x.jsonl")),
    (error) => error.name === "SessionFileMissingError",
  );
  await assert.rejects(
    () => antigravityAdapter.parseSessionFile(fixtureTranscript(home, RICH_ID), { maxBytes: 10 }),
    (error) => error.name === "ParseFileTooLargeError",
  );
});

test("settingsCatalog lists only surfaces the CLI's own documentation substantiates", () => {
  const listed = antigravityAdapter.settingsCatalog.list();
  assert.match(antigravityAdapter.settingsCatalog.lastUpdated, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(
    listed.map((item) => item.path),
    [
      "~/.gemini/antigravity-cli/settings.json",
      "~/.gemini/config/hooks.json",
      "~/.gemini/config/mcp_config.json",
      "~/.gemini/config/skills",
      "<cwd>/AGENTS.md",
      "<cwd>/.agents/hooks.json",
    ],
  );
  for (const item of listed) {
    assert.ok(["global", "project"].includes(item.scope), item.path);
    assert.ok(typeof item.label === "string" && item.label.length > 0);
    assert.ok(typeof item.description === "string" && item.description.length > 0);
  }
  // list() hands out copies, so a caller cannot mutate the catalog.
  listed[0].path = "mutated";
  assert.equal(antigravityAdapter.settingsCatalog.list()[0].path, settingsCatalogItems[0].path);
});

test("the adapter exposes the full method surface squab expects", () => {
  for (const required of [
    "sessionRoot",
    "locateLatest",
    "findBySessionId",
    "findImportTranscript",
    "readEmbeddedSessionId",
    "readNative",
    "writeNative",
    "writeNoticeSeed",
    "resumeArgs",
    "formatResumeCommand",
    "freshLaunchArgs",
    "terminateKeystrokes",
    "sanitize",
    "forkNative",
    "parseSessionFile",
    "hookScript",
    "hookInstallEntry",
  ]) {
    assert.equal(typeof antigravityAdapter[required], "function", `missing ${required}`);
  }
  assert.equal(typeof antigravityAdapter.settingsCatalog.list, "function");
  assert.equal(typeof antigravityAdapter.hookCapabilities, "object");
});

test("no handoff artefacts leak into agy's own brain directory", async (t) => {
  const { home } = await useHomes(t);
  const before = (await fsp.readdir(path.join(home, "brain"))).sort();
  await antigravityAdapter.writeNative([], antigravityAdapter.sessionRoot(RICH_CWD), RICH_CWD, "sess-x");
  await antigravityAdapter.forkNative(fixtureTranscript(home, RICH_ID), "sess-y", RICH_CWD, null);
  const after = (await fsp.readdir(path.join(home, "brain"))).sort();
  assert.deepEqual(after, before);
  assert.ok(handoffDir("sess-x").length > 0);
});
