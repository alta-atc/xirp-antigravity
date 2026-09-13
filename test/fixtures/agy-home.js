import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The fixture tree that mirrors a real ~/.gemini/antigravity-cli. */
const AGY_HOME_FIXTURE = path.join(here, "agy-home");

/** Conversation ids present in the fixture home. */
const PROBE_ID = "668e81c1-3b9e-4916-a3c1-03a2a9b2a6aa";
const RICH_ID = "11111111-2222-3333-4444-555555555555";
const META_ONLY_ID = "22222222-2222-3333-4444-555555555555";
const IDE_ID = "33333333-2222-3333-4444-555555555555";
const MISSING_TRANSCRIPT_ID = "99999999-2222-3333-4444-555555555555";

const PROBE_CWD = "/fixture/probe-repo";
const RICH_CWD = "/fixture/rich-repo";
const META_ONLY_CWD = "/fixture/meta-only-repo";

/**
 * Copy the fixture home into a fresh temp dir and point ANTIGRAVITY_CLI_HOME at
 * it for the duration of one test. Never touches the developer's real
 * ~/.gemini.
 */
async function useFixtureAgyHome(t) {
  const previous = process.env.ANTIGRAVITY_CLI_HOME;
  const previousAlias = process.env.ANTIGRAVITY_HOME;
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "xirp-agy-home-"));
  await fsp.cp(AGY_HOME_FIXTURE, home, { recursive: true });
  process.env.ANTIGRAVITY_CLI_HOME = home;
  // The alias must not shadow the primary variable inside these tests.
  delete process.env.ANTIGRAVITY_HOME;
  t.after(async () => {
    if (previous === undefined) delete process.env.ANTIGRAVITY_CLI_HOME;
    else process.env.ANTIGRAVITY_CLI_HOME = previous;
    if (previousAlias === undefined) delete process.env.ANTIGRAVITY_HOME;
    else process.env.ANTIGRAVITY_HOME = previousAlias;
    await fsp.rm(home, { recursive: true, force: true });
  });
  return home;
}

/** An empty ANTIGRAVITY_CLI_HOME, for the "nothing on disk" cases. */
async function useEmptyAgyHome(t) {
  const previous = process.env.ANTIGRAVITY_CLI_HOME;
  const previousAlias = process.env.ANTIGRAVITY_HOME;
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "xirp-agy-empty-"));
  process.env.ANTIGRAVITY_CLI_HOME = home;
  delete process.env.ANTIGRAVITY_HOME;
  t.after(async () => {
    if (previous === undefined) delete process.env.ANTIGRAVITY_CLI_HOME;
    else process.env.ANTIGRAVITY_CLI_HOME = previous;
    if (previousAlias === undefined) delete process.env.ANTIGRAVITY_HOME;
    else process.env.ANTIGRAVITY_HOME = previousAlias;
    await fsp.rm(home, { recursive: true, force: true });
  });
  return home;
}

/** Point XIRP_ANTIGRAVITY_HOME at a fresh temp dir for one test. */
async function useTempHandoffHome(t) {
  const previous = process.env.XIRP_ANTIGRAVITY_HOME;
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "xirp-agy-handoff-"));
  process.env.XIRP_ANTIGRAVITY_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.XIRP_ANTIGRAVITY_HOME;
    else process.env.XIRP_ANTIGRAVITY_HOME = previous;
    await fsp.rm(home, { recursive: true, force: true });
  });
  return home;
}

/** Absolute transcript path of a fixture conversation inside a temp home. */
function fixtureTranscript(home, conversationId) {
  return path.join(home, "brain", conversationId, ".system_generated", "logs", "transcript_full.jsonl");
}

/** Read one fixture transcript straight from the repo (no temp home needed). */
function readFixtureTranscript(conversationId) {
  return fsp.readFile(
    path.join(AGY_HOME_FIXTURE, "brain", conversationId, ".system_generated", "logs", "transcript_full.jsonl"),
    "utf-8",
  );
}

export {
  AGY_HOME_FIXTURE,
  PROBE_ID,
  RICH_ID,
  META_ONLY_ID,
  IDE_ID,
  MISSING_TRANSCRIPT_ID,
  PROBE_CWD,
  RICH_CWD,
  META_ONLY_CWD,
  useFixtureAgyHome,
  useEmptyAgyHome,
  useTempHandoffHome,
  fixtureTranscript,
  readFixtureTranscript,
};
