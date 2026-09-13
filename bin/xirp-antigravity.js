#!/usr/bin/env node
// CLI for xirp-antigravity: patches Spotify's Xirp.app to add Google's
// Antigravity CLI (agy) as a coding agent, and can re-apply that patch
// automatically after Xirp updates via a launchd watcher.
//
// Commands: status, apply [--if-needed] [--app <path>] [--force], remove,
// doctor, install-watcher, uninstall-watcher.
// Exit codes: 0 ok/no-op, 1 error, 2 unsupported Xirp version.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveAppPath,
  readAppVersion,
  resolveNodeRuntime,
  resolveCliPath,
  resolveChunksDir,
  findRegistryChunk,
  locate,
  LocateError,
} from "../src/patcher/locate.js";
import {
  apply,
  remove,
  isPatched,
  isGrokPatched,
  PatchError,
} from "../src/patcher/inject.js";
import { readState, stateFilePath } from "../src/patcher/state.js";

/**
 * Report a wrapper (agy-xirp) path: whether it exists, and whether it's
 * executable (mode & 0o111). Returns a one-line human string.
 */
function describeWrapper(wrapperPath) {
  if (!wrapperPath) return "not recorded";
  if (!existsSync(wrapperPath)) return `${wrapperPath} (missing)`;
  try {
    const executable = (statSync(wrapperPath).mode & 0o111) !== 0;
    return `${wrapperPath} (${executable ? "executable" : "not executable"})`;
  } catch (err) {
    return `${wrapperPath} (could not stat: ${err.message})`;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const WATCHER_LABEL = "com.alta-atc.xirp-antigravity";
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), "Library", "LaunchAgents");
const LAUNCH_AGENT_PATH = path.join(
  LAUNCH_AGENTS_DIR,
  `${WATCHER_LABEL}.plist`,
);
const LOG_PATH = path.join(os.homedir(), "Library", "Logs", "xirp-antigravity.log");

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--app") {
      opts.app = rest[++i];
    } else if (arg === "--if-needed") {
      opts.ifNeeded = true;
    } else if (arg === "--force") {
      opts.force = true;
    } else {
      opts._.push(arg);
    }
  }
  return { command, opts };
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function cmdStatus({ app }) {
  const appPath = resolveAppPath({ app });
  console.log(`App:      ${appPath}`);

  let version;
  try {
    version = readAppVersion(appPath);
    console.log(`Version:  ${version}`);
  } catch (err) {
    console.log(`Version:  unknown (${err.message})`);
  }

  let patched = false;
  let chunkPath = null;
  try {
    const loc = locate({ app });
    chunkPath = loc.chunk.path;
    patched = isPatched(loc.chunk.content);
    console.log(`Chunk:    ${chunkPath}`);
    console.log(`Patched:  ${patched ? "yes" : "no"}`);
    console.log(`Grok also patched: ${isGrokPatched(loc.chunk.content) ? "yes" : "no"}`);
  } catch (err) {
    console.log(`Chunk:    not found (${err.message})`);
  }

  const state = readState();
  if (state) {
    console.log(`State:    ${stateFilePath()} (applied ${state.appliedAt}, patchVersion ${state.patchVersion})`);
    console.log(`Wrapper:  ${describeWrapper(state.wrapperPath)}`);
  } else {
    console.log("State:    none");
  }

  if (patched && state) {
    console.log("Status:   OK — Antigravity harness is installed.");
  } else if (!patched) {
    console.log("Status:   not applied. Run `xirp-antigravity apply`.");
  } else {
    console.log("Status:   patched, but no local state marker found.");
  }
}

// macOS (13+) protects other apps' bundles in /Applications with the
// "App Management" privacy permission. Writes from a terminal that lacks it
// fail with EPERM even though the files are owned by the user.
const APP_MANAGEMENT_HINT =
  "macOS refused to modify Xirp.app (App Management protection). Either:\n" +
  "  - re-run with sudo:  sudo node " + fileURLToPath(import.meta.url) + " <command>\n" +
  "  - or grant your terminal app 'App Management' in System Settings >\n" +
  "    Privacy & Security > App Management, then reopen the terminal.";

function failWithBundleHint(err, code) {
  const msg = /EPERM/.test(err.message) && /Xirp\.app/.test(err.message)
    ? `error: ${err.message}\n${APP_MANAGEMENT_HINT}`
    : `error: ${err.message}`;
  fail(msg, code);
}

function cmdApply({ app, ifNeeded, force }) {
  let result;
  try {
    result = apply({ app, force });
  } catch (err) {
    if (err instanceof LocateError) {
      fail(`error: ${err.message}`, err.code);
    }
    failWithBundleHint(err, err instanceof PatchError ? err.code : 1);
    return;
  }

  if (result.action === "noop") {
    console.log(
      `Already applied for Xirp ${result.version} (${result.chunkPath}). Nothing to do.`,
    );
    return;
  }

  console.log(
    `${result.action === "refreshed" ? "Refreshed" : "Applied"} Antigravity harness for Xirp ${result.version}.`,
  );
  console.log(`  Chunk:   ${result.chunkPath}`);
  console.log("Restart Xirp to pick up the Antigravity harness.");
}

function cmdRemove({ app }) {
  let result;
  try {
    result = remove({ app });
  } catch (err) {
    failWithBundleHint(err, err instanceof PatchError ? err.code : 1);
    return;
  }

  if (result.action === "noop") {
    console.log("Nothing to remove — Antigravity harness is not applied.");
    return;
  }
  console.log(`Removed Antigravity harness patch from ${result.chunkPath}.`);
}

function cmdDoctor({ app }) {
  const appPath = resolveAppPath({ app });
  console.log(`App path:        ${appPath}`);
  console.log(`App exists:      ${existsSync(appPath) ? "yes" : "no"}`);

  let version = null;
  try {
    version = readAppVersion(appPath);
  } catch (err) {
    console.log(`Version:         unknown (${err.message})`);
  }
  if (version) console.log(`Version:         ${version}`);

  let chunk = null;
  let cliPath = null;
  let nodePath = null;
  try {
    nodePath = resolveNodeRuntime(appPath);
    console.log(`Node runtime:    ${nodePath}`);
  } catch (err) {
    console.log(`Node runtime:    not found (${err.message})`);
  }
  try {
    cliPath = resolveCliPath(appPath);
    console.log(`Squab CLI:       ${cliPath}`);
  } catch (err) {
    console.log(`Squab CLI:       not found (${err.message})`);
  }
  if (cliPath) {
    try {
      const chunksDir = resolveChunksDir(cliPath);
      chunk = findRegistryChunk(chunksDir);
      console.log(`Registry chunk:  ${chunk.path}`);
      console.log(
        `Chunk patched:   ${isPatched(chunk.content) ? "yes" : "no"}`,
      );
      console.log(
        `Grok also patched: ${isGrokPatched(chunk.content) ? "yes" : "no"}`,
      );
    } catch (err) {
      console.log(`Registry chunk:  not found (${err.message})`);
    }
  }

  let agyOnPath = null;
  try {
    agyOnPath = execFileSync("which", ["agy"], { encoding: "utf8" }).trim();
  } catch {
    agyOnPath = null;
  }
  console.log(`agy on PATH:     ${agyOnPath || "not found"}`);

  const agyHome = path.join(os.homedir(), ".local", "bin", "agy");
  console.log(
    `~/.local/bin/agy: ${existsSync(agyHome) ? agyHome : "not found"}`,
  );

  let agyXirpOnPath = null;
  try {
    agyXirpOnPath = execFileSync("which", ["agy-xirp"], { encoding: "utf8" }).trim();
  } catch {
    agyXirpOnPath = null;
  }
  console.log(`agy-xirp on PATH: ${agyXirpOnPath || "not found"}`);

  const state = readState();
  console.log(`State marker:    ${state ? stateFilePath() : "none"}`);
  if (state) {
    console.log(`  xirpVersion:        ${state.xirpVersion}`);
    console.log(`  chunkPath:          ${state.chunkPath}`);
    console.log(`  chunkSha256Original: ${state.chunkSha256Original}`);
    console.log(`  chunkSha256Patched:  ${state.chunkSha256Patched}`);
    console.log(`  harnessSha256:       ${state.harnessSha256}`);
    console.log(`  wrapperPath:         ${describeWrapper(state.wrapperPath)}`);
    console.log(`  patchVersion:        ${state.patchVersion}`);
    console.log(`  appliedAt:           ${state.appliedAt}`);
    console.log(`  origOwnedByUs:       ${state.origOwnedByUs}`);
  }

  console.log(
    `Watcher installed: ${existsSync(LAUNCH_AGENT_PATH) ? LAUNCH_AGENT_PATH : "no"}`,
  );
}

function cmdInstallWatcher({ app }) {
  const appPath = resolveAppPath({ app });
  const watchPath = path.join(appPath, "Contents", "Info.plist");

  const templatePath = path.join(
    REPO_ROOT,
    "launchd",
    `${WATCHER_LABEL}.plist`,
  );
  if (!existsSync(templatePath)) {
    fail(`error: plist template not found at ${templatePath}`);
  }
  const template = readFileSync(templatePath, "utf8");
  const binPath = path.join(REPO_ROOT, "bin", "xirp-antigravity.js");

  const plist = template
    .split("{{LABEL}}")
    .join(WATCHER_LABEL)
    .split("{{NODE_PATH}}")
    .join(process.execPath)
    .split("{{BIN_PATH}}")
    .join(binPath)
    .split("{{WATCH_PATH}}")
    .join(watchPath)
    .split("{{LOG_PATH}}")
    .join(LOG_PATH)
    .split("{{ERR_LOG_PATH}}")
    .join(LOG_PATH);

  mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  writeFileSync(LAUNCH_AGENT_PATH, plist, "utf8");

  try {
    execFileSync("launchctl", [
      "bootstrap",
      `gui/${process.getuid()}`,
      LAUNCH_AGENT_PATH,
    ]);
  } catch (err) {
    fail(
      `error: wrote ${LAUNCH_AGENT_PATH} but \`launchctl bootstrap\` failed: ${err.message}`,
    );
  }

  console.log(`Installed watcher at ${LAUNCH_AGENT_PATH}.`);
  console.log(`Watching: ${watchPath}`);
  console.log(`Logs:     ${LOG_PATH}`);
}

function cmdUninstallWatcher() {
  if (existsSync(LAUNCH_AGENT_PATH)) {
    try {
      execFileSync("launchctl", [
        "bootout",
        `gui/${process.getuid()}`,
        LAUNCH_AGENT_PATH,
      ]);
    } catch (err) {
      console.error(
        `warning: \`launchctl bootout\` failed (may not be loaded): ${err.message}`,
      );
    }
    unlinkSync(LAUNCH_AGENT_PATH);
    console.log(`Removed watcher ${LAUNCH_AGENT_PATH}.`);
  } else {
    console.log("Watcher is not installed.");
  }
}

function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));

  switch (command) {
    case "status":
      return cmdStatus(opts);
    case "apply":
      return cmdApply(opts);
    case "remove":
      return cmdRemove(opts);
    case "doctor":
      return cmdDoctor(opts);
    case "install-watcher":
      return cmdInstallWatcher(opts);
    case "uninstall-watcher":
      return cmdUninstallWatcher(opts);
    default:
      console.error(
        "Usage: xirp-antigravity <status|apply|remove|doctor|install-watcher|uninstall-watcher> [--app <path>] [--if-needed] [--force]",
      );
      process.exit(command ? 1 : 0);
  }
}

main();
