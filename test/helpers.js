import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const FIXTURES = path.join(here, "fixtures");
const REPO_ROOT = path.resolve(here, "..");

/**
 * Point ANTIGRAVITY_HOME at a fresh temp dir for the duration of one test and
 * restore it afterwards. Never touches the developer's real ~/.gemini.
 */
async function useTempAntigravityHome(t) {
  const previous = process.env.ANTIGRAVITY_HOME;
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "xirp-antigravity-test-"));
  process.env.ANTIGRAVITY_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.ANTIGRAVITY_HOME;
    else process.env.ANTIGRAVITY_HOME = previous;
    await fsp.rm(home, { recursive: true, force: true });
  });
  return home;
}

async function tempDir(t, prefix = "xirp-antigravity-tmp-") {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Copy a hand-authored fixture session into an ANTIGRAVITY_HOME bucket.
 * bucketDirName defaults to encodeURIComponent(cwd); pass an explicit name to
 * exercise the ".cwd" marker lookup.
 */
async function installFixture(home, fixtureName, { cwd, bucketDirName, cwdMarker } = {}) {
  const source = path.join(FIXTURES, fixtureName);
  const summary = JSON.parse(await fsp.readFile(path.join(source, "summary.json"), "utf-8"));
  const sessionId = summary.info.id;
  const effectiveCwd = cwd ?? summary.info.cwd;
  const bucket = path.join(home, "sessions", bucketDirName ?? encodeURIComponent(effectiveCwd));
  const sessionDir = path.join(bucket, sessionId);
  await fsp.mkdir(sessionDir, { recursive: true });
  for (const file of await fsp.readdir(source)) {
    await fsp.copyFile(path.join(source, file), path.join(sessionDir, file));
  }
  if (cwd && cwd !== summary.info.cwd) {
    summary.info.cwd = cwd;
    await fsp.writeFile(
      path.join(sessionDir, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  }
  if (cwdMarker) await fsp.writeFile(path.join(bucket, ".cwd"), `${effectiveCwd}\n`);
  return {
    sessionId,
    cwd: effectiveCwd,
    bucketDir: bucket,
    sessionDir,
    sessionFile: path.join(sessionDir, "chat_history.jsonl"),
  };
}

function readFixture(fixtureName, file) {
  return fsp.readFile(path.join(FIXTURES, fixtureName, file), "utf-8");
}

export { FIXTURES, REPO_ROOT, useTempAntigravityHome, tempDir, installFixture, readFixture };
