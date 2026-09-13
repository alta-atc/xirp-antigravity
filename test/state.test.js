import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readState, writeState, clearState, stateFilePath } from "../src/patcher/state.js";

test("state round-trips through write/read/clear", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "xirp-antigravity-state-test-"));
  try {
    assert.equal(readState(home), null);

    const state = {
      xirpVersion: "0.32.0",
      chunkPath: "/fake/chunk.js",
      chunkSha256Original: "a".repeat(64),
      chunkSha256Patched: "b".repeat(64),
      harnessSha256: "c".repeat(64),
      patchVersion: "0.1.0",
      appliedAt: new Date().toISOString(),
      origOwnedByUs: true,
    };
    writeState(state, home);
    assert.deepEqual(readState(home), state);
    assert.ok(stateFilePath(home).endsWith(path.join(".xirp-antigravity", "state.json")));

    clearState(home);
    assert.equal(readState(home), null);
    // Clearing again should be a no-op, not throw.
    clearState(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
