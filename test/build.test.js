import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..");
const BUILD_SCRIPT = path.join(REPO_ROOT, "scripts", "build-harness.js");
const DIST = path.join(REPO_ROOT, "dist", "antigravity-harness.js");
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
  ]);
  assert.deepEqual(exportLines, ["export { registerAntigravity };"]);
  assert.equal(source.includes('from "./'), false, "no intra-bundle imports may survive");
  for (const line of importLines) {
    assert.match(line, /"node:(fs|fs\/promises|path|os|crypto)"/);
  }
});

test("the built harness carries no Grok references", async () => {
  await ensureBuilt();
  const source = await fsp.readFile(DIST, "utf-8");
  assert.equal(/grok/i.test(source), false, "the bundle must not mention grok");
});

test("node --check accepts the built harness", async () => {
  await ensureBuilt();
  await run(process.execPath, ["--check", DIST]);
});

test("the built harness registers the expected harness and adapter shapes", async () => {
  await ensureBuilt();
  const module = await import(`${pathToFileURL(DIST).href}?built=${Date.now()}`);
  assert.equal(typeof module.registerAntigravity, "function");

  let adapter = null;
  let def = null;
  const calls = [];
  module.registerAntigravity(
    (a) => {
      calls.push(["adapter", a.agent]);
      adapter = a;
    },
    (d) => {
      calls.push(["harness", d.agentName]);
      def = d;
    },
  );

  assert.deepEqual(calls, [
    ["harness", "antigravity"],
    ["adapter", "antigravity"],
  ]);
  assert.equal(def.flag, "--launch-antigravity");
  assert.equal(def.cmd, "launch-antigravity");
  assert.equal(def.binary, "agy");
  assert.equal(def.visibility, "public");
  assert.equal(def.lifecycle.install.kind, "none");
  assert.equal(def.lifecycle.update.kind, "self-update");
  assert.deepEqual(def.lifecycle.update.args, ["update"]);
  assert.equal(def.lifecycle.uninstall.kind, "none");

  assert.equal(adapter.agent, "antigravity");
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

  assert.match(adapter.hookCapabilities.lastUpdated, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(adapter.hookCapabilities.supports, {
    notification: false,
    preToolUse: true,
    postToolUse: true,
    stop: true,
    sessionStart: false,
    permissionRequest: false,
    statusLine: false,
  });
  assert.equal(typeof adapter.hookScript, "function");
  assert.equal(typeof adapter.hookInstallEntry, "function");

  const script = adapter.hookScript("preToolUse", {
    daemonUrl: "http://127.0.0.1:9999/hook",
    authToken: "tok",
  });
  assert.match(script, /hook-script antigravity preToolUse/);
  assert.match(script, /DAEMON_URL = 'http:\/\/127\.0\.0\.1:9999\/hook'/);
  assert.match(script, /AUTH_TOKEN = 'tok'/);
  assert.match(script, /payload\.conversationId/);

  const entry = adapter.hookInstallEntry("preToolUse", "/tmp/hook.js");
  assert.match(entry.settingsFile, /config[/\\]hooks\.json$/);
  assert.deepEqual(entry.mergePath, ["xirp", "PreToolUse"]);
  assert.equal(entry.fragment.matcher, "*");
  assert.equal(entry.fragment.hooks[0].command, "/tmp/hook.js");
  assert.equal(entry.mergeOp, "array-append");

  assert.throws(() => adapter.hookScript("sessionStart", { daemonUrl: "http://x" }));
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

  const snippet = `import(${JSON.stringify(DIST)}).then(m=>{const s=[];m.registerAntigravity(a=>s.push(["adapter",a.agent]),d=>s.push(["harness",d.agentName]));console.log(JSON.stringify(s))})`;
  const { stdout } = await run(XIRP_NODE, ["-e", snippet]);
  assert.equal(stdout.trim(), '[["harness","antigravity"],["adapter","antigravity"]]');
});
