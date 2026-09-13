import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  HOOK_EVENTS,
  defineHookCapabilities,
  grokHookCapabilities,
  grokHookScript,
  grokHookInstallEntry,
  GROK_UNSUPPORTED_HOOK_EVENTS,
} from "../src/harness/hooks.js";
import { useTempGrokHome } from "./helpers.js";

test("hookCapabilities declares all seven HookEvent keys as booleans, keyed by a valid lastUpdated date", () => {
  assert.equal(HOOK_EVENTS.length, 7);
  assert.match(grokHookCapabilities.lastUpdated, /^\d{4}-\d{2}-\d{2}$/);
  for (const event of HOOK_EVENTS) {
    assert.equal(typeof grokHookCapabilities.supports[event], "boolean", `supports.${event}`);
  }
  assert.deepEqual(Object.keys(grokHookCapabilities.supports).sort(), [...HOOK_EVENTS].sort());
  assert.deepEqual(grokHookCapabilities.supports, {
    notification: false,
    preToolUse: true,
    postToolUse: true,
    stop: true,
    sessionStart: true,
    permissionRequest: false,
    statusLine: false,
  });
});

test("defineHookCapabilities rejects a missing key, a non-boolean, and a bad date", () => {
  assert.throws(() => defineHookCapabilities("2026-09-12", { preToolUse: true }), /must be a boolean/);
  assert.throws(
    () => defineHookCapabilities("2026-09-12", { ...grokHookCapabilities.supports, stop: "yes" }),
    /must be a boolean/,
  );
  assert.throws(() => defineHookCapabilities("09/12/2026", grokHookCapabilities.supports), /invalid/);
  assert.throws(
    () => defineHookCapabilities("2026-09-12", { ...grokHookCapabilities.supports, bogus: true }),
    /unknown HookEvent/,
  );
});

test("grokHookScript emits the daemon URL, auth token, agent, event name, and reads sessionId from stdin", async (t) => {
  await useTempGrokHome(t);
  const script = grokHookScript("preToolUse", {
    daemonUrl: "http://127.0.0.1:4173/hook",
    authToken: "s3cr3t",
  });

  assert.match(script, /^#!\/usr\/bin\/env node/);
  assert.match(script, /hook-script grok preToolUse/);
  assert.match(script, /Schema: squab\.hook\/v1/);
  assert.match(script, /const DAEMON_URL = 'http:\/\/127\.0\.0\.1:4173\/hook';/);
  assert.match(script, /const AUTH_TOKEN = 's3cr3t';/);
  assert.match(script, /const AGENT = 'grok';/);
  assert.match(script, /kind: 'preToolUse'/);
  assert.match(
    script,
    /payload\.sessionId === 'string'\) \? payload\.sessionId : ''/,
    "must read the camelCase sessionId field from grok's stdin envelope",
  );
});

test("grokHookScript escapes single quotes and backslashes in the daemon URL and auth token", async (t) => {
  await useTempGrokHome(t);
  const script = grokHookScript("stop", {
    daemonUrl: "http://127.0.0.1/hook?x='y'",
    authToken: "a'b\\c",
  });
  assert.match(script, /DAEMON_URL = 'http:\/\/127\.0\.0\.1\/hook\?x=\\'y\\''/);
  assert.match(script, /AUTH_TOKEN = 'a\\'b\\\\c'/);
});

test("grokHookScript honors a per-event timeout override", async (t) => {
  await useTempGrokHome(t);
  const script = grokHookScript("postToolUse", {
    daemonUrl: "http://127.0.0.1/hook",
    timeoutOverrides: { postToolUse: 42 },
  });
  assert.match(script, /setTimeout\(\(\) => process\.exit\(0\), 42000\)/);
});

test("grokHookScript throws for events grok does not expose natively", async (t) => {
  await useTempGrokHome(t);
  for (const event of GROK_UNSUPPORTED_HOOK_EVENTS) {
    assert.throws(
      () => grokHookScript(event, { daemonUrl: "http://127.0.0.1/hook" }),
      /is not exposed by Grok Build's native hook surface/,
    );
  }
});

test("grokHookInstallEntry returns the xirp.json merge instruction for each supported event", async (t) => {
  const home = await useTempGrokHome(t);
  const cases = [
    ["preToolUse", "PreToolUse"],
    ["postToolUse", "PostToolUse"],
    ["stop", "Stop"],
    ["sessionStart", "SessionStart"],
  ];
  for (const [event, native] of cases) {
    const entry = grokHookInstallEntry(event, "/opt/xirp/hooks/grok-hook.js");
    assert.equal(entry.settingsFile, path.join(home, "hooks", "xirp.json"));
    assert.deepEqual(entry.mergePath, ["hooks", native]);
    assert.equal(entry.fragment.hooks[0].command, "/opt/xirp/hooks/grok-hook.js");
    assert.equal(entry.fragment.hooks[0].type, "command");
    assert.equal(entry.mergeOp, "array-append");
  }
});

test("grokHookInstallEntry applies and validates a timeout override", async (t) => {
  await useTempGrokHome(t);
  const withTimeout = grokHookInstallEntry("stop", "/tmp/hook.js", { timeoutOverrides: { stop: 120 } });
  assert.equal(withTimeout.fragment.hooks[0].timeout, 120);

  assert.throws(
    () => grokHookInstallEntry("stop", "/tmp/hook.js", { timeoutOverrides: { stop: 0 } }),
    /must be an integer between 1 and/,
  );
  assert.throws(
    () => grokHookInstallEntry("stop", "/tmp/hook.js", { timeoutOverrides: { stop: 1.5 } }),
    /must be an integer between 1 and/,
  );
});

test("grokHookInstallEntry throws for events grok does not expose natively", async (t) => {
  await useTempGrokHome(t);
  for (const event of GROK_UNSUPPORTED_HOOK_EVENTS) {
    assert.throws(
      () => grokHookInstallEntry(event, "/tmp/hook.js"),
      /is not exposed by Grok Build's native hook surface/,
    );
  }
});
