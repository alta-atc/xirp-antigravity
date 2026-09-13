// Exercises src/wrapper/agy-xirp directly: it rewrites Xirp's trailing
// positional "goal" argument into agy's `-i` flag, then execs the real agy.
// `AGY_XIRP_REAL` points the wrapper at a tiny fake `agy` (pure bash, no
// external interpreter) that just prints its received argv as a single JSON
// line, so these tests only assert on argv rewriting -- they never touch a
// real `agy` install.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.join(__dirname, "..", "src", "wrapper", "agy-xirp");

let fakeAgyDir;
let fakeAgyPath;

test.before(() => {
  fakeAgyDir = mkdtempSync(path.join(os.tmpdir(), "agy-xirp-fake-agy-"));
  fakeAgyPath = path.join(fakeAgyDir, "agy");
  // Emit argv as a JSON array using only bash + od/printf-free primitives so
  // this doesn't depend on python3 being installed.
  const script = `#!/bin/bash
out="["
first=1
for a in "$@"; do
  esc=\${a//\\\\/\\\\\\\\}
  esc=\${esc//\\"/\\\\\\"}
  esc=\${esc//$'\\n'/\\\\n}
  if [ "$first" -eq 1 ]; then first=0; else out="$out,"; fi
  out="$out\\"$esc\\""
done
out="$out]"
printf '%s\\n' "$out"
`;
  writeFileSync(fakeAgyPath, script, "utf8");
  chmodSync(fakeAgyPath, 0o755);
});

test.after(() => {
  if (fakeAgyDir) rmSync(fakeAgyDir, { recursive: true, force: true });
});

async function runWrapper(args, envOverrides = {}) {
  const { stdout } = await run("bash", [WRAPPER, ...args], {
    env: { ...process.env, AGY_XIRP_REAL: fakeAgyPath, ...envOverrides },
  });
  return JSON.parse(stdout.trim());
}

test("no args: passes straight through", async () => {
  assert.deepEqual(await runWrapper([]), []);
});

test("--version: passes straight through", async () => {
  assert.deepEqual(await runWrapper(["--version"]), ["--version"]);
});

test("a subcommand takes arbitrary trailing args untouched", async () => {
  assert.deepEqual(await runWrapper(["mcp", "list", "foo"]), ["mcp", "list", "foo"]);
});

test("--conversation <id> with no positional is left untouched", async () => {
  assert.deepEqual(await runWrapper(["--conversation", "abc"]), ["--conversation", "abc"]);
});

test("a bare positional goal becomes -i <goal>", async () => {
  assert.deepEqual(await runWrapper(["test"]), ["-i", "test"]);
});

test("an inline-value flag plus a multi-word positional becomes -i \"<goal>\"", async () => {
  assert.deepEqual(
    await runWrapper(["--model=foo", "test", "goal"]),
    ["--model=foo", "-i", "test goal"],
  );
});

test("a separate-value flag is preserved ahead of the rewritten -i", async () => {
  assert.deepEqual(
    await runWrapper(["--add-dir", "/x", "test"]),
    ["--add-dir", "/x", "-i", "test"],
  );
});

test("an already-present -i absorbs a trailing positional, joined by two newlines", async () => {
  assert.deepEqual(
    await runWrapper(["-i", "hello", "extra"]),
    ["-i", "hello\n\nextra"],
  );
});

test("a positional prefixed with a single space (daemon's escape for a leading dash) is kept verbatim, minus that space", async () => {
  assert.deepEqual(await runWrapper([" -weird"]), ["-i", "-weird"]);
});

test("agy-xirp: agy not found on PATH exits 127 when nothing resolves", async () => {
  // Keep /usr/bin:/bin on PATH (dirname/basename/pwd/readlink live there and
  // the script needs them), just with no `agy` anywhere on it or at the
  // ~/.local/bin fallback, and no AGY_XIRP_REAL override.
  await assert.rejects(
    () =>
      run("bash", [WRAPPER, "test"], {
        env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent-empty-home-xyz" },
      }),
    (err) => {
      assert.equal(err.code, 127);
      assert.match(err.stderr, /agy not found on PATH/);
      return true;
    },
  );
});

test("AGY_XIRP_DEBUG=1 prints the final argv to stderr before exec", async () => {
  const { stderr, stdout } = await run("bash", [WRAPPER, "test"], {
    env: { ...process.env, AGY_XIRP_REAL: fakeAgyPath, AGY_XIRP_DEBUG: "1" },
  });
  assert.match(stderr, /agy-xirp: exec/);
  assert.match(stderr, /-i/);
  assert.deepEqual(JSON.parse(stdout.trim()), ["-i", "test"]);
});
