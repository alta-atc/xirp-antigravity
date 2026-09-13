import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { createFakeApp } from "./helpers/fake-app.js";
import { locate, findRegistryChunk, LocateError } from "../src/patcher/locate.js";

test("locate finds the app, version, node, cli and registry chunk by signature", () => {
  const fake = createFakeApp({ version: "0.32.0" });
  try {
    const loc = locate({ app: fake.appPath, env: {} });
    assert.equal(loc.version, "0.32.0");
    assert.equal(loc.nodePath, fake.nodePath);
    assert.equal(loc.cliPath, fake.cliPath);
    assert.equal(loc.chunksDir, fake.chunksDir);
    assert.equal(loc.chunk.path, fake.chunkPath);
    assert.match(loc.chunk.content, /--launch-cursor/);
  } finally {
    rmSync(fake.tmpDir, { recursive: true, force: true });
  }
});

test("locate still finds the chunk when a foreign (xirp-grok) import line is already appended", () => {
  const fake = createFakeApp({ withForeignGrokPatch: true });
  try {
    const loc = locate({ app: fake.appPath, env: {} });
    assert.equal(loc.chunk.path, fake.chunkPath);
    assert.match(loc.chunk.content, /--launch-cursor/);
    assert.match(loc.chunk.content, /from "\.\/grok-harness\.js"/);
  } finally {
    rmSync(fake.tmpDir, { recursive: true, force: true });
  }
});

test("findRegistryChunk throws a code-2 LocateError when no chunk has the signature", () => {
  const fake = createFakeApp({ withSignature: false });
  try {
    assert.throws(
      () => findRegistryChunk(fake.chunksDir),
      (err) => {
        assert.ok(err instanceof LocateError);
        assert.equal(err.code, 2);
        assert.match(err.message, /unsupported/i);
        return true;
      },
    );
  } finally {
    rmSync(fake.tmpDir, { recursive: true, force: true });
  }
});

test("resolveAppPath prefers explicit app, then XIRP_APP env, then the default", async () => {
  const { resolveAppPath, DEFAULT_APP_PATH } = await import("../src/patcher/locate.js");
  assert.equal(resolveAppPath({ app: "/explicit", env: {} }), "/explicit");
  assert.equal(
    resolveAppPath({ env: { XIRP_APP: "/from-env" } }),
    "/from-env",
  );
  assert.equal(resolveAppPath({ env: {} }), DEFAULT_APP_PATH);
});

test("findRegistryChunk matches both minified and prettified signature forms", async () => {
  const { REGISTRY_SIGNATURE } = await import("../src/patcher/locate.js");
  assert.ok(REGISTRY_SIGNATURE.test('flag:"--launch-cursor"'));
  assert.ok(REGISTRY_SIGNATURE.test('flag: "--launch-cursor"'));
  assert.ok(!REGISTRY_SIGNATURE.test('flag:"--launch-claude"'));
});
