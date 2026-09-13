import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  HOOK_EVENTS,
  HOOK_NAMESPACE,
  GROUPED_NATIVE_EVENTS,
  CANONICAL_TO_NATIVE_EVENT_NAME,
  defineHookCapabilities,
  antigravityHookCapabilities,
  antigravityHooksSettingsFile,
  antigravityHookScript,
  antigravityHookInstallEntry,
  ANTIGRAVITY_UNSUPPORTED_HOOK_EVENTS,
} from "../src/harness/hooks.js";
import { useFixtureAgyHome } from "./fixtures/agy-home.js";

test("hookCapabilities declares all seven HookEvent keys as booleans, keyed by a valid lastUpdated date", () => {
  assert.equal(HOOK_EVENTS.length, 7);
  assert.match(antigravityHookCapabilities.lastUpdated, /^\d{4}-\d{2}-\d{2}$/);
  for (const event of HOOK_EVENTS) {
    assert.equal(typeof antigravityHookCapabilities.supports[event], "boolean", `supports.${event}`);
  }
  assert.deepEqual(Object.keys(antigravityHookCapabilities.supports).sort(), [...HOOK_EVENTS].sort());
  // agy's native lifecycle events are PreToolUse, PostToolUse, PreInvocation,
  // PostInvocation and Stop. It has no session-start, notification or
  // status-line event, and permission decisions are returned from PreToolUse
  // rather than from an event of their own.
  assert.deepEqual(antigravityHookCapabilities.supports, {
    notification: false,
    preToolUse: true,
    postToolUse: true,
    stop: true,
    sessionStart: false,
    permissionRequest: false,
    statusLine: false,
  });
});

test("every supported capability has a native event name, and no unsupported one does", () => {
  for (const event of HOOK_EVENTS) {
    const supported = antigravityHookCapabilities.supports[event];
    assert.equal(
      Object.hasOwn(CANONICAL_TO_NATIVE_EVENT_NAME, event),
      supported,
      `${event} mapping must match its capability`,
    );
    assert.equal(ANTIGRAVITY_UNSUPPORTED_HOOK_EVENTS.has(event), !supported, event);
  }
});

test("defineHookCapabilities rejects a missing key, a non-boolean, and a bad date", () => {
  assert.throws(() => defineHookCapabilities("2026-09-13", { preToolUse: true }), /must be a boolean/);
  assert.throws(
    () =>
      defineHookCapabilities("2026-09-13", {
        ...antigravityHookCapabilities.supports,
        stop: "yes",
      }),
    /must be a boolean/,
  );
  assert.throws(
    () => defineHookCapabilities("09/13/2026", antigravityHookCapabilities.supports),
    /invalid/,
  );
  assert.throws(
    () =>
      defineHookCapabilities("2026-09-13", {
        ...antigravityHookCapabilities.supports,
        bogus: true,
      }),
    /unknown HookEvent/,
  );
});

test("antigravityHookScript emits the daemon URL, auth token, agent and event, and reads conversationId", async (t) => {
  await useFixtureAgyHome(t);
  const script = antigravityHookScript("preToolUse", {
    daemonUrl: "http://127.0.0.1:4173/hook",
    authToken: "s3cr3t",
  });

  assert.match(script, /^#!\/usr\/bin\/env node/);
  assert.match(script, /hook-script antigravity preToolUse/);
  assert.match(script, /Schema: squab\.hook\/v1/);
  assert.match(script, /const DAEMON_URL = 'http:\/\/127\.0\.0\.1:4173\/hook';/);
  assert.match(script, /const AUTH_TOKEN = 's3cr3t';/);
  assert.match(script, /const AGENT = 'antigravity';/);
  assert.match(script, /kind: 'preToolUse'/);
  assert.match(
    script,
    /payload\.conversationId === 'string'\) \? payload\.conversationId : ''/,
    "agy's hook payloads are protojson, so the session id field is conversationId",
  );
});

test("antigravityHookScript escapes single quotes and backslashes in the daemon URL and auth token", async (t) => {
  await useFixtureAgyHome(t);
  const script = antigravityHookScript("stop", {
    daemonUrl: "http://127.0.0.1/hook?x='y'",
    authToken: "a'b\\c",
  });
  assert.match(script, /DAEMON_URL = 'http:\/\/127\.0\.0\.1\/hook\?x=\\'y\\''/);
  assert.match(script, /AUTH_TOKEN = 'a\\'b\\\\c'/);
});

test("antigravityHookScript honors a per-event timeout override", async (t) => {
  await useFixtureAgyHome(t);
  const script = antigravityHookScript("postToolUse", {
    daemonUrl: "http://127.0.0.1/hook",
    timeoutOverrides: { postToolUse: 42 },
  });
  assert.match(script, /setTimeout\(\(\) => process\.exit\(0\), 42000\)/);
});

test("antigravityHookScript throws for events agy does not expose natively", async (t) => {
  await useFixtureAgyHome(t);
  for (const event of ANTIGRAVITY_UNSUPPORTED_HOOK_EVENTS) {
    assert.throws(
      () => antigravityHookScript(event, { daemonUrl: "http://127.0.0.1/hook" }),
      /is not exposed by the Antigravity CLI's native hook surface/,
    );
  }
});

test("the hooks file is the shared ~/.gemini/config/hooks.json beside the CLI home", async (t) => {
  const home = await useFixtureAgyHome(t);
  assert.equal(antigravityHooksSettingsFile(), path.join(path.dirname(home), "config", "hooks.json"));
});

test("hookInstallEntry merges under xirp's own namespace, never at the file root", async (t) => {
  const home = await useFixtureAgyHome(t);
  assert.equal(HOOK_NAMESPACE, "xirp");

  for (const [event, native] of Object.entries(CANONICAL_TO_NATIVE_EVENT_NAME)) {
    const entry = antigravityHookInstallEntry(event, "/opt/xirp/hooks/antigravity-hook.js");
    assert.equal(
      entry.settingsFile,
      path.join(path.dirname(home), "config", "hooks.json"),
      event,
    );
    // Namespaced: other tools' namespaces in the same file are untouched.
    assert.deepEqual(entry.mergePath, ["xirp", native], event);
    assert.equal(entry.mergeOp, "array-append", event);
  }
});

test("tool events get a grouped matcher fragment and Stop gets a flat handler", async (t) => {
  await useFixtureAgyHome(t);

  for (const event of ["preToolUse", "postToolUse"]) {
    const entry = antigravityHookInstallEntry(event, "/tmp/hook.js");
    assert.ok(GROUPED_NATIVE_EVENTS.has(CANONICAL_TO_NATIVE_EVENT_NAME[event]));
    // Grouped shape: { matcher, hooks: [handler] }, matcher "*" = every tool.
    assert.equal(entry.fragment.matcher, "*");
    assert.deepEqual(entry.fragment.hooks, [{ type: "command", command: "/tmp/hook.js" }]);
  }

  // Flat shape: the handler object itself, with no matcher.
  const stop = antigravityHookInstallEntry("stop", "/tmp/hook.js");
  assert.deepEqual(stop.fragment, { type: "command", command: "/tmp/hook.js" });
  assert.equal(stop.fragment.matcher, undefined);
  assert.equal(stop.fragment.hooks, undefined);
});

test("hookInstallEntry applies and validates a timeout override for both fragment shapes", async (t) => {
  await useFixtureAgyHome(t);

  const grouped = antigravityHookInstallEntry("postToolUse", "/tmp/hook.js", {
    timeoutOverrides: { postToolUse: 120 },
  });
  assert.equal(grouped.fragment.hooks[0].timeout, 120);

  const flat = antigravityHookInstallEntry("stop", "/tmp/hook.js", {
    timeoutOverrides: { stop: 120 },
  });
  assert.equal(flat.fragment.timeout, 120);

  assert.throws(
    () => antigravityHookInstallEntry("stop", "/tmp/hook.js", { timeoutOverrides: { stop: 0 } }),
    /must be an integer between 1 and/,
  );
  assert.throws(
    () => antigravityHookInstallEntry("stop", "/tmp/hook.js", { timeoutOverrides: { stop: 1.5 } }),
    /must be an integer between 1 and/,
  );
});

test("hookInstallEntry throws for events agy does not expose natively", async (t) => {
  await useFixtureAgyHome(t);
  for (const event of ANTIGRAVITY_UNSUPPORTED_HOOK_EVENTS) {
    assert.throws(
      () => antigravityHookInstallEntry(event, "/tmp/hook.js"),
      /is not exposed by the Antigravity CLI's native hook surface/,
    );
  }
});
