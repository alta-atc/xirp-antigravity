import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { REPO_ROOT } from "./helpers.js";

const run = promisify(execFile);
const BUILD_SCRIPT = path.join(REPO_ROOT, "scripts", "build-harness.js");
const DIST = path.join(REPO_ROOT, "dist", "grok-harness.js");
const XIRP_NODE = "/Applications/Xirp.app/Contents/Resources/node-runtime/node";

let built = false;
async function ensureBuilt() {
  if (built) return;
  await run(process.execPath, [BUILD_SCRIPT], { cwd: REPO_ROOT });
  built = true;
}

test("the build produces one import block, one export, and no relative imports", async () => {
  await ensureBuilt();
  const source = await fsp.readFile(DIST, "utf-8");
  const importLines = source.split("\n").filter((line) => line.startsWith("import "));
  const exportLines = source.split("\n").filter((line) => line.startsWith("export "));

  assert.deepEqual(importLines, [
    'import fsp from "node:fs/promises";',
    'import path from "node:path";',
    'import os from "node:os";',
    'import crypto from "node:crypto";',
  ]);
  assert.deepEqual(exportLines, ["export { registerGrok };"]);
  assert.equal(source.includes('from "./'), false, "no intra-bundle imports may survive");
  for (const line of importLines) {
    assert.match(line, /"node:(fs|fs\/promises|path|os|crypto)"/);
  }
});

test("node --check accepts the built harness", async () => {
  await ensureBuilt();
  await run(process.execPath, ["--check", DIST]);
});

test("the built harness registers the expected harness and adapter shapes", async () => {
  await ensureBuilt();
  const module = await import(`${pathToFileURL(DIST).href}?built=${Date.now()}`);
  assert.equal(typeof module.registerGrok, "function");

  let adapter = null;
  let def = null;
  const order = [];
  module.registerGrok(
    (a) => {
      order.push("rt");
      adapter = a;
    },
    (d) => {
      order.push("ot");
      def = d;
    },
  );

  assert.deepEqual(order, ["ot", "rt"]);
  assert.equal(def.agentName, "grok");
  assert.equal(def.flag, "--launch-grok");
  assert.equal(def.cmd, "launch-grok");
  assert.equal(def.binary, "grok");
  assert.equal(def.visibility, "public");
  assert.equal(def.lifecycle.install.kind, "vendor-script");
  assert.equal(def.lifecycle.update.kind, "self-update");
  assert.equal(def.lifecycle.uninstall.kind, "none");

  assert.equal(adapter.agent, "grok");
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
  ]) {
    assert.equal(typeof adapter[required], "function", `missing required ${required}`);
  }
  for (const optional of [
    "freshLaunchArgs",
    "formatResumeCommand",
    "terminateKeystrokes",
    "sanitize",
    "forkNative",
  ]) {
    assert.equal(typeof adapter[optional], "function", `missing optional ${optional}`);
  }
  assert.equal(typeof adapter.settingsCatalog.list, "function");

  assert.equal(adapter.hookCapabilities.lastUpdated, "2026-09-12");
  assert.deepEqual(adapter.hookCapabilities.supports, {
    notification: false,
    preToolUse: true,
    postToolUse: true,
    stop: true,
    sessionStart: true,
    permissionRequest: false,
    statusLine: false,
  });
  assert.equal(typeof adapter.hookScript, "function");
  assert.equal(typeof adapter.hookInstallEntry, "function");

  const script = adapter.hookScript("preToolUse", {
    daemonUrl: "http://127.0.0.1:9999/hook",
    authToken: "tok",
  });
  assert.match(script, /hook-script grok preToolUse/);
  assert.match(script, /DAEMON_URL = 'http:\/\/127\.0\.0\.1:9999\/hook'/);
  assert.match(script, /AUTH_TOKEN = 'tok'/);
  assert.match(script, /payload\.sessionId/);

  const entry = adapter.hookInstallEntry("preToolUse", "/tmp/hook.js");
  assert.match(entry.settingsFile, /\.grok[/\\]hooks[/\\]xirp\.json$/);
  assert.deepEqual(entry.mergePath, ["hooks", "PreToolUse"]);
  assert.equal(entry.fragment.hooks[0].command, "/tmp/hook.js");
  assert.equal(entry.mergeOp, "array-append");

  assert.throws(() => adapter.hookScript("notification", { daemonUrl: "http://x" }));
  assert.throws(() => adapter.hookInstallEntry("notification", "/tmp/hook.js"));
});

test("the built harness loads under Xirp's bundled node runtime", async (t) => {
  await ensureBuilt();
  let usable = false;
  try {
    await fsp.access(XIRP_NODE);
    usable = true;
  } catch {
    usable = false;
  }
  if (!usable) {
    t.skip(`${XIRP_NODE} is not installed on this machine`);
    return;
  }

  const snippet = `import(${JSON.stringify(DIST)}).then(m=>{const s=[];m.registerGrok(a=>s.push(["rt",a.agent]),d=>s.push(["ot",d.agentName]));console.log(JSON.stringify(s))})`;
  const { stdout } = await run(XIRP_NODE, ["-e", snippet]);
  assert.equal(stdout.trim(), '[["ot","grok"],["rt","grok"]]');
});
