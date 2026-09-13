import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  TRANSCRIPT_FILE,
  agyHome,
  brainDir,
  cacheDir,
  conversationDir,
  transcriptFileIn,
  transcriptFileFor,
  conversationIdFromPath,
  lastConversationsFile,
  metadataFile,
  settingsFile,
  handoffHome,
  handoffRoot,
  handoffDir,
  handoffTranscriptFile,
  handoffMarkdownFile,
  isHandoffTranscriptPath,
  listConversationIds,
  listConversationDirs,
  listHandoffIds,
  newestTranscript,
  pathFromFileUri,
} from "../src/harness/paths.js";
import {
  PROBE_ID,
  RICH_ID,
  useFixtureAgyHome,
  useTempHandoffHome,
  fixtureTranscript,
} from "./fixtures/agy-home.js";

test("agyHome honours ANTIGRAVITY_CLI_HOME and every path hangs off it", async (t) => {
  const home = await useFixtureAgyHome(t);
  assert.equal(agyHome(), home);
  assert.equal(brainDir(), path.join(home, "brain"));
  assert.equal(cacheDir(), path.join(home, "cache"));
  assert.equal(conversationDir("abc"), path.join(home, "brain", "abc"));
  assert.equal(lastConversationsFile(), path.join(home, "cache", "last_conversations.json"));
  assert.equal(metadataFile(), path.join(home, "cache", "conversation_metadata.json"));
  assert.equal(settingsFile(), path.join(home, "settings.json"));
});

test("ANTIGRAVITY_HOME is accepted as an alias when ANTIGRAVITY_CLI_HOME is unset", async (t) => {
  const previousPrimary = process.env.ANTIGRAVITY_CLI_HOME;
  const previousAlias = process.env.ANTIGRAVITY_HOME;
  t.after(() => {
    if (previousPrimary === undefined) delete process.env.ANTIGRAVITY_CLI_HOME;
    else process.env.ANTIGRAVITY_CLI_HOME = previousPrimary;
    if (previousAlias === undefined) delete process.env.ANTIGRAVITY_HOME;
    else process.env.ANTIGRAVITY_HOME = previousAlias;
  });

  delete process.env.ANTIGRAVITY_CLI_HOME;
  process.env.ANTIGRAVITY_HOME = "/tmp/alias-home";
  assert.equal(agyHome(), "/tmp/alias-home");

  // The primary variable wins when both are set.
  process.env.ANTIGRAVITY_CLI_HOME = "/tmp/primary-home";
  assert.equal(agyHome(), "/tmp/primary-home");

  // With neither set, the default is ~/.gemini/antigravity-cli.
  delete process.env.ANTIGRAVITY_CLI_HOME;
  delete process.env.ANTIGRAVITY_HOME;
  assert.equal(agyHome(), path.join(os.homedir(), ".gemini", "antigravity-cli"));
});

test("the transcript lives under .system_generated/logs/transcript_full.jsonl", async (t) => {
  const home = await useFixtureAgyHome(t);
  assert.equal(TRANSCRIPT_FILE, "transcript_full.jsonl");
  assert.equal(
    transcriptFileFor(RICH_ID),
    path.join(home, "brain", RICH_ID, ".system_generated", "logs", "transcript_full.jsonl"),
  );
  assert.equal(transcriptFileIn(conversationDir(RICH_ID)), transcriptFileFor(RICH_ID));
});

test("conversationIdFromPath reads the id out of both real and handoff transcript paths", async (t) => {
  const home = await useFixtureAgyHome(t);
  await useTempHandoffHome(t);

  assert.equal(conversationIdFromPath(transcriptFileFor(RICH_ID)), RICH_ID);
  assert.equal(conversationIdFromPath(fixtureTranscript(home, PROBE_ID)), PROBE_ID);
  assert.equal(conversationIdFromPath(handoffTranscriptFile("sess-1")), "sess-1");
  assert.equal(conversationIdFromPath(""), "");
});

test("handoff paths hang off XIRP_ANTIGRAVITY_HOME and are recognised as handoffs", async (t) => {
  const handoff = await useTempHandoffHome(t);
  assert.equal(handoffHome(), handoff);
  assert.equal(handoffRoot(), path.join(handoff, "handoff"));
  assert.equal(handoffDir("sess-1"), path.join(handoff, "handoff", "sess-1"));
  assert.equal(
    handoffTranscriptFile("sess-1"),
    path.join(handoff, "handoff", "sess-1", "transcript_full.jsonl"),
  );
  assert.equal(
    handoffMarkdownFile("sess-1"),
    path.join(handoff, "handoff", "sess-1", "transcript.md"),
  );

  assert.equal(isHandoffTranscriptPath(handoffTranscriptFile("sess-1")), true);
  assert.equal(isHandoffTranscriptPath("/somewhere/else/transcript_full.jsonl"), false);
  assert.equal(isHandoffTranscriptPath(""), false);
  // A directory that merely starts with the same characters is not inside it.
  assert.equal(isHandoffTranscriptPath(`${path.join(handoff, "handoff")}-other/x.jsonl`), false);
});

test("listConversationIds and listConversationDirs enumerate brain/", async (t) => {
  const home = await useFixtureAgyHome(t);
  const ids = (await listConversationIds()).sort();
  assert.ok(ids.includes(PROBE_ID));
  assert.ok(ids.includes(RICH_ID));
  const dirs = await listConversationDirs();
  assert.equal(dirs.length, ids.length);
  assert.ok(dirs.every((dir) => dir.startsWith(path.join(home, "brain"))));
});

test("listConversationIds and listHandoffIds return [] when the directories are absent", async (t) => {
  const previousHome = process.env.ANTIGRAVITY_CLI_HOME;
  const previousHandoff = process.env.XIRP_ANTIGRAVITY_HOME;
  const empty = await fsp.mkdtemp(path.join(os.tmpdir(), "xirp-agy-nothing-"));
  process.env.ANTIGRAVITY_CLI_HOME = empty;
  process.env.XIRP_ANTIGRAVITY_HOME = empty;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.ANTIGRAVITY_CLI_HOME;
    else process.env.ANTIGRAVITY_CLI_HOME = previousHome;
    if (previousHandoff === undefined) delete process.env.XIRP_ANTIGRAVITY_HOME;
    else process.env.XIRP_ANTIGRAVITY_HOME = previousHandoff;
    await fsp.rm(empty, { recursive: true, force: true });
  });

  assert.deepEqual(await listConversationIds(), []);
  assert.deepEqual(await listHandoffIds(), []);
});

test("newestTranscript picks the most recently modified transcript and skips missing ones", async (t) => {
  const home = await useFixtureAgyHome(t);
  const probe = fixtureTranscript(home, PROBE_ID);
  const rich = fixtureTranscript(home, RICH_ID);
  const missing = fixtureTranscript(home, "not-a-conversation");

  const old = new Date(Date.now() - 60_000);
  await fsp.utimes(probe, old, old);
  assert.equal(await newestTranscript([probe, rich, missing]), rich);

  const older = new Date(Date.now() - 120_000);
  await fsp.utimes(rich, older, older);
  assert.equal(await newestTranscript([probe, rich, missing]), probe);

  assert.equal(await newestTranscript([missing]), null);
  assert.equal(await newestTranscript([]), null);
});

test("pathFromFileUri decodes agy's host-less workspace URIs", () => {
  assert.equal(pathFromFileUri("file:///Users/example/proj"), "/Users/example/proj");
  assert.equal(pathFromFileUri("file:///Users/example/a%20b"), "/Users/example/a b");
  assert.equal(pathFromFileUri("/Users/example/proj"), null);
  assert.equal(pathFromFileUri(undefined), null);
});
