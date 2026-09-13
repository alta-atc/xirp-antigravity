import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  MAX_BUCKET_BYTES,
  bucketName,
  bucketDirFor,
  grokHome,
  sessionsRoot,
  resolveBucketDir,
  sessionIdFromPath,
  newestSessionFile,
  listSessionDirs,
} from "../src/harness/paths.js";
import { useTempGrokHome, installFixture } from "./helpers.js";

test("grokHome honours GROK_HOME and sessionsRoot hangs off it", async (t) => {
  const home = await useTempGrokHome(t);
  assert.equal(grokHome(), home);
  assert.equal(sessionsRoot(), path.join(home, "sessions"));
});

test("short cwds encode straight to a percent-encoded bucket name", () => {
  assert.equal(bucketName("/Users/example/proj"), "%2FUsers%2Fexample%2Fproj");
  assert.equal(bucketName("/Users/example/a b"), "%2FUsers%2Fexample%2Fa%20b");
});

test("over-long cwds fall back to a slug-hash bucket name", () => {
  const cwd = `/Users/example/${"a".repeat(400)}`;
  const name = bucketName(cwd);
  assert.ok(Buffer.byteLength(name) <= MAX_BUCKET_BYTES);
  assert.match(name, /-[0-9a-f]{16}$/);
  assert.equal(name, bucketName(cwd), "bucket names are deterministic");
  assert.notEqual(name, bucketName(`${cwd}b`), "different cwds get different buckets");
});

test("slug truncation never splits a percent escape", () => {
  // Every n here encodes past MAX_BUCKET_BYTES, so the name is always hashed;
  // sweeping n walks the truncation boundary through the "%2F" escapes.
  for (let n = 51; n < 140; n++) {
    const cwd = `/${"ab/".repeat(n)}`;
    const name = bucketName(cwd);
    assert.match(name, /-[0-9a-f]{16}$/, `expected a hashed name at n=${n}`);
    const slug = name.slice(0, -17);
    assert.doesNotThrow(() => decodeURIComponent(slug), `split escape at n=${n}`);
    assert.ok(!slug.endsWith("%"), `dangling percent at n=${n}`);
  }
});

test("resolveBucketDir finds the directly-encoded bucket", async (t) => {
  const home = await useTempGrokHome(t);
  const installed = await installFixture(home, "session-basic");
  assert.equal(await resolveBucketDir(installed.cwd), installed.bucketDir);
  assert.equal(bucketDirFor(installed.cwd), installed.bucketDir);
});

test("resolveBucketDir falls back to scanning for a matching .cwd file", async (t) => {
  const home = await useTempGrokHome(t);
  const longCwd = `/Users/example/${"deep-".repeat(60)}proj`;
  const installed = await installFixture(home, "session-basic", {
    cwd: longCwd,
    bucketDirName: "grok-picked-this-name-abcdef0123456789",
    cwdMarker: true,
  });

  assert.notEqual(bucketDirFor(longCwd), installed.bucketDir);
  assert.equal(await resolveBucketDir(longCwd), installed.bucketDir);
  assert.equal(await resolveBucketDir("/Users/example/not-a-session"), null);
});

test("newestSessionFile picks the most recently modified session", async (t) => {
  const home = await useTempGrokHome(t);
  const first = await installFixture(home, "session-basic");
  const second = await installFixture(home, "session-other", { cwd: first.cwd });

  const fsp = await import("node:fs/promises");
  const old = new Date(Date.now() - 60_000);
  await fsp.utimes(first.sessionFile, old, old);

  const dirs = await listSessionDirs(first.bucketDir);
  assert.equal(dirs.length, 2);
  const newest = await newestSessionFile(dirs);
  assert.equal(newest, second.sessionFile);
  assert.equal(sessionIdFromPath(newest), second.sessionId);
});
