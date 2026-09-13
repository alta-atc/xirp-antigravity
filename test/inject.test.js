import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFakeApp, fakeHome, SIGNATURE, GROK_IMPORT_LINE } from "./helpers/fake-app.js";
import {
  apply,
  remove,
  isPatched,
  isGrokPatched,
  buildImportLine,
  detectRegistryIdentifiers,
  HARNESS_FILENAME,
  PatchError,
} from "../src/patcher/inject.js";
import { LocateError } from "../src/patcher/locate.js";
import { readState } from "../src/patcher/state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUB_HARNESS = path.join(__dirname, "fixtures", "antigravity-harness.stub.js");

test("apply appends the import line, backs up the chunk, copies the harness, and writes state", () => {
  const fake = createFakeApp();
  const home = fakeHome(fake.tmpDir);
  try {
    const result = apply({
      app: fake.appPath,
      env: {},
      home,
      harnessOverride: STUB_HARNESS,
    });

    assert.equal(result.action, "applied");

    const patchedContent = readFileSync(fake.chunkPath, "utf8");
    assert.ok(isPatched(patchedContent));
    assert.ok(patchedContent.endsWith(buildImportLine({ registerAdapter: "V", registerAgent: "z" })));

    const backupPath = `${fake.chunkPath}.orig`;
    assert.ok(existsSync(backupPath), ".orig backup should exist");
    assert.equal(readFileSync(backupPath, "utf8"), fake.chunkContent);

    const harnessPath = path.join(fake.chunksDir, HARNESS_FILENAME);
    assert.ok(existsSync(harnessPath), "harness module should be copied in");
    assert.equal(
      readFileSync(harnessPath, "utf8"),
      readFileSync(STUB_HARNESS, "utf8"),
    );

    const state = readState(home);
    assert.ok(state);
    assert.equal(state.xirpVersion, "0.32.0");
    assert.equal(state.chunkPath, fake.chunkPath);
    assert.equal(typeof state.chunkSha256Original, "string");
    assert.equal(typeof state.chunkSha256Patched, "string");
    assert.equal(typeof state.harnessSha256, "string");
    assert.equal(typeof state.patchVersion, "string");
    assert.ok(state.appliedAt);
    assert.equal(state.origOwnedByUs, true, "we created the backup, so we own it");
  } finally {
    rmSync(fake.tmpDir, { recursive: true, force: true });
  }
});

test("apply is idempotent: a second apply is a no-op and does not duplicate the import line", () => {
  const fake = createFakeApp();
  const home = fakeHome(fake.tmpDir);
  try {
    apply({ app: fake.appPath, env: {}, home, harnessOverride: STUB_HARNESS });
    const afterFirst = readFileSync(fake.chunkPath, "utf8");

    const second = apply({
      app: fake.appPath,
      env: {},
      home,
      harnessOverride: STUB_HARNESS,
    });
    assert.equal(second.action, "noop");

    const afterSecond = readFileSync(fake.chunkPath, "utf8");
    assert.equal(afterSecond, afterFirst);
    const occurrences = afterSecond.split('from "./antigravity-harness.js"').length - 1;
    assert.equal(occurrences, 1);
  } finally {
    rmSync(fake.tmpDir, { recursive: true, force: true });
  }
});

test("remove restores the chunk byte-for-byte and clears harness, backup, and state", () => {
  const fake = createFakeApp();
  const home = fakeHome(fake.tmpDir);
  try {
    apply({ app: fake.appPath, env: {}, home, harnessOverride: STUB_HARNESS });

    const result = remove({ app: fake.appPath, env: {}, home });
    assert.equal(result.action, "removed");

    const restored = readFileSync(fake.chunkPath, "utf8");
    assert.equal(restored, fake.chunkContent);

    assert.ok(!existsSync(`${fake.chunkPath}.orig`));
    assert.ok(!existsSync(path.join(fake.chunksDir, HARNESS_FILENAME)));
    assert.equal(readState(home), null);
  } finally {
    rmSync(fake.tmpDir, { recursive: true, force: true });
  }
});

test("remove is a no-op (not an error) when nothing has been applied", () => {
  const fake = createFakeApp();
  const home = fakeHome(fake.tmpDir);
  try {
    const result = remove({ app: fake.appPath, env: {}, home });
    assert.equal(result.action, "noop");
  } finally {
    rmSync(fake.tmpDir, { recursive: true, force: true });
  }
});

test("apply throws a code-2 error when the registry signature is missing (unsupported Xirp version)", () => {
  const fake = createFakeApp({ withSignature: false });
  const home = fakeHome(fake.tmpDir);
  try {
    assert.throws(
      () => apply({ app: fake.appPath, env: {}, home, harnessOverride: STUB_HARNESS }),
      (err) => {
        assert.ok(err instanceof LocateError);
        assert.equal(err.code, 2);
        assert.match(err.message, new RegExp(fake.chunksDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      },
    );
  } finally {
    rmSync(fake.tmpDir, { recursive: true, force: true });
  }
});

test("apply throws a code-2 error when the chunk has the signature but not rt()/ot() calls", () => {
  const fake = createFakeApp({ withRtOt: false });
  const home = fakeHome(fake.tmpDir);
  try {
    assert.throws(
      () => apply({ app: fake.appPath, env: {}, home, harnessOverride: STUB_HARNESS }),
      (err) => {
        assert.ok(err instanceof LocateError);
        assert.equal(err.code, 2);
        assert.match(err.message, /rt\(|ot\(|unsupported/i);
        return true;
      },
    );
  } finally {
    rmSync(fake.tmpDir, { recursive: true, force: true });
  }
});

test("apply re-applies after Xirp updates (chunk replaced with a new, unpatched one)", () => {
  const fake = createFakeApp({ chunkName: "index-abc.js" });
  const home = fakeHome(fake.tmpDir);
  try {
    const first = apply({
      app: fake.appPath,
      env: {},
      home,
      harnessOverride: STUB_HARNESS,
    });
    assert.equal(first.action, "applied");

    // Simulate a Xirp update: the old chunk file is replaced by a new one
    // (new content hash => new filename) that doesn't have the import yet.
    unlinkSync(fake.chunkPath);
    const newChunkPath = path.join(fake.chunksDir, "index-def.js");
    const newChunkContent = `// updated squab chunk\nconst kc={${SIGNATURE},agentName:"cursor"};function Gi(){rt(x),ot(kc)}\n`;
    writeFileSync(newChunkPath, newChunkContent, "utf8");

    const second = apply({
      app: fake.appPath,
      env: {},
      home,
      harnessOverride: STUB_HARNESS,
    });
    assert.equal(second.action, "applied");
    assert.equal(second.chunkPath, newChunkPath);

    const patched = readFileSync(newChunkPath, "utf8");
    assert.ok(isPatched(patched));
    assert.ok(existsSync(`${newChunkPath}.orig`));
    assert.equal(readFileSync(`${newChunkPath}.orig`, "utf8"), newChunkContent);

    const state = readState(home);
    assert.equal(state.chunkPath, newChunkPath);
  } finally {
    rmSync(fake.tmpDir, { recursive: true, force: true });
  }
});

test("apply rolls back on a failed verification, leaving the chunk untouched", () => {
  const fake = createFakeApp({ includeAntigravity: false });
  const home = fakeHome(fake.tmpDir);
  try {
    assert.throws(
      () => apply({ app: fake.appPath, env: {}, home, harnessOverride: STUB_HARNESS }),
      (err) => {
        assert.ok(err instanceof PatchError);
        assert.match(err.message, /^Rolled back: /);
        assert.match(err.message, /antigravity/);
        return true;
      },
    );

    assert.equal(readFileSync(fake.chunkPath, "utf8"), fake.chunkContent);
    assert.ok(!existsSync(`${fake.chunkPath}.orig`));
    assert.ok(!existsSync(path.join(fake.chunksDir, HARNESS_FILENAME)));
    assert.equal(readState(home), null);
  } finally {
    rmSync(fake.tmpDir, { recursive: true, force: true });
  }
});

test("resolveHarnessSource fails clearly when neither dist nor src harness exists", async () => {
  const { resolveHarnessSource } = await import("../src/patcher/inject.js");
  assert.throws(
    () => resolveHarnessSource({ repoRoot: "/nonexistent-repo-root-xyz" }),
    (err) => {
      assert.ok(err instanceof PatchError);
      assert.match(err.message, /No harness module found/);
      return true;
    },
  );
});

test("detectRegistryIdentifiers derives names from the real minified shape", () => {
  const chunk = 'x={flag:"--launch-pi"},vc={flag:"--launch-cursor",agentName:"cursor"};function _c(){V(Qe),V(Zn),V($o),V(pa),V(So),z(yc),z(wc),z(Sc),z(bc),z(vc)}';
  assert.deepEqual(detectRegistryIdentifiers(chunk), { registerAdapter: "V", registerAgent: "z", cursorVar: "vc" });
  assert.equal(detectRegistryIdentifiers('vc={flag:"--launch-cursor"};function f(){a(vc),b(x),c(y)}'), null);
  assert.equal(detectRegistryIdentifiers('nothing here'), null);
});

// --- Coexistence with xirp-grok ---------------------------------------
//
// Both tools patch the same registry chunk by appending one import line
// each. Whichever tool applies first creates the `.orig` backup and "owns"
// it; the other must never overwrite or delete that backup, and must never
// restore the whole chunk from it (that would also undo the first tool's
// patch).

test("apply on a chunk already patched by xirp-grok appends after its line, without touching grok's backup", () => {
  const fake = createFakeApp({ withForeignGrokPatch: true });
  const home = fakeHome(fake.tmpDir);
  const backupPath = `${fake.chunkPath}.orig`;
  try {
    const result = apply({
      app: fake.appPath,
      env: {},
      home,
      harnessOverride: STUB_HARNESS,
    });
    assert.equal(result.action, "applied");

    const patchedContent = readFileSync(fake.chunkPath, "utf8");
    assert.ok(isGrokPatched(patchedContent), "grok's line must survive");
    assert.ok(isPatched(patchedContent), "our line must be appended");
    // Our line comes after grok's.
    assert.ok(
      patchedContent.indexOf(GROK_IMPORT_LINE.trim()) <
        patchedContent.indexOf('from "./antigravity-harness.js"'),
    );

    // Grok's pristine backup must be untouched byte-for-byte.
    assert.equal(readFileSync(backupPath, "utf8"), fake.pristineContent);

    const state = readState(home);
    assert.equal(state.origOwnedByUs, false, "grok created the backup, not us");
  } finally {
    rmSync(fake.tmpDir, { recursive: true, force: true });
  }
});

test("remove with a grok line present strips only our line, leaving grok's line and its backup intact", () => {
  const fake = createFakeApp({ withForeignGrokPatch: true });
  const home = fakeHome(fake.tmpDir);
  const backupPath = `${fake.chunkPath}.orig`;
  try {
    apply({ app: fake.appPath, env: {}, home, harnessOverride: STUB_HARNESS });

    const result = remove({ app: fake.appPath, env: {}, home });
    assert.equal(result.action, "removed");

    const afterRemove = readFileSync(fake.chunkPath, "utf8");
    assert.ok(isGrokPatched(afterRemove), "grok's line must still be present");
    assert.ok(!isPatched(afterRemove), "our line must be gone");
    assert.equal(afterRemove, fake.chunkContent, "chunk returns to grok-only state");

    assert.ok(existsSync(backupPath), "grok's backup must not be deleted");
    assert.equal(readFileSync(backupPath, "utf8"), fake.pristineContent);

    assert.ok(!existsSync(path.join(fake.chunksDir, HARNESS_FILENAME)));
    assert.equal(readState(home), null);
  } finally {
    rmSync(fake.tmpDir, { recursive: true, force: true });
  }
});

test("remove when we own the backup and nothing else is patched deletes the backup", () => {
  const fake = createFakeApp();
  const home = fakeHome(fake.tmpDir);
  const backupPath = `${fake.chunkPath}.orig`;
  try {
    apply({ app: fake.appPath, env: {}, home, harnessOverride: STUB_HARNESS });
    assert.equal(readState(home).origOwnedByUs, true);

    const result = remove({ app: fake.appPath, env: {}, home });
    assert.equal(result.action, "removed");

    assert.equal(readFileSync(fake.chunkPath, "utf8"), fake.chunkContent);
    assert.ok(!existsSync(backupPath), "we own the backup and nothing else is patched, so it's deleted");
    assert.equal(readState(home), null);
  } finally {
    rmSync(fake.tmpDir, { recursive: true, force: true });
  }
});
