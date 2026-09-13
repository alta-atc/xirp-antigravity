// Applies (and reverses) the Antigravity harness patch to an installed Xirp.app.
//
// apply():   back up the registry chunk (once, and only if no `.orig` already
//            exists — xirp-grok may have gotten there first), append an
//            import that wires registerAntigravity(rt, ot) into it, drop the
//            built harness module next to it, then verify the squab CLI
//            still loads and reports an "antigravity" harness.
// remove():  strip only *our* import line from the registry chunk (never a
//            full restore-from-backup, which would also rip out a coexisting
//            xirp-grok patch), delete only our harness module, and drop the
//            `.orig` backup only if we created it and nothing else is
//            patching the chunk any more.
//
// Both are idempotent: calling apply() twice, or remove() with nothing
// applied, is a safe no-op with a clear message rather than an error.
//
// Coexistence with xirp-grok: both tools patch the very same squab registry
// chunk by appending one import line each. Whichever tool runs `apply` first
// creates the `.orig` backup (the pristine, unpatched chunk) and "owns" it;
// the second tool must never overwrite that backup and must never restore
// the whole chunk from it, since that would silently undo the first tool's
// patch too. `origOwnedByUs` in state.json records which case happened here.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  unlinkSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { locate, LocateError } from "./locate.js";
import { readState, writeState, clearState, chownToSudoUser } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Marker that identifies our injected line regardless of which local
// identifiers the registry functions happen to have in a given Xirp build.
export const IMPORT_MARKER = 'from "./antigravity-harness.js"';
const IMPORT_LINE_RE = /\nimport \{ registerAntigravity \} from "\.\/antigravity-harness\.js"; registerAntigravity\([A-Za-z_$][\w$]*, [A-Za-z_$][\w$]*\);\n/g;

// Marker for xirp-grok's own injected line, so we can detect (for `doctor`/
// `status`, and for deciding whether it's still safe to drop `.orig`) that a
// second tool has also patched this chunk. We never write this line
// ourselves and never strip it.
export const GROK_IMPORT_MARKER = 'from "./grok-harness.js"';

export function isPatched(content) {
  return content.includes(IMPORT_MARKER);
}

export function isGrokPatched(content) {
  return content.includes(GROK_IMPORT_MARKER);
}

export function buildImportLine({ registerAdapter, registerAgent }) {
  return `\nimport { registerAntigravity } from "./antigravity-harness.js"; registerAntigravity(${registerAdapter}, ${registerAgent});\n`;
}

/**
 * Work out which local identifiers the registry chunk uses for squab's
 * registerAdapter / registerAgent. The chunk is minified and the names change
 * per build (0.32.0 uses V and z), so they are derived from structure:
 *   1. the const holding the cursor harness def:  vc={flag:"--launch-cursor",...}
 *   2. the call that registers it:                  z(vc)   -> registerAgent
 *   3. the enclosing zero-arg function body has exactly one other callee,
 *      used for the adapter objects:                V(Qe)   -> registerAdapter
 */
export function detectRegistryIdentifiers(content) {
  const defMatch = content.match(
    /([A-Za-z_$][\w$]*)\s*=\s*\{\s*flag:\s*"--launch-cursor"/,
  );
  if (!defMatch) return null;
  const cursorVar = defMatch[1];
  const callRe = new RegExp(`([A-Za-z_$][\\w$]*)\\(\\s*${cursorVar}\\s*\\)`);
  const callMatch = content.match(callRe);
  if (!callMatch) return null;
  const registerAgent = callMatch[1];
  const callIdx = callMatch.index;
  const fnStart = content.lastIndexOf("function", callIdx);
  if (fnStart < 0) return null;
  const bodyOpen = content.indexOf("{", fnStart);
  const bodyClose = content.indexOf("}", callIdx);
  if (bodyOpen < 0 || bodyClose < 0 || bodyOpen > callIdx) return null;
  const body = content.slice(bodyOpen + 1, bodyClose);
  const callees = new Set(
    [...body.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]),
  );
  callees.delete(registerAgent);
  if (callees.size !== 1) return null;
  const [registerAdapter] = callees;
  return { registerAdapter, registerAgent, cursorVar };
}

export const HARNESS_FILENAME = "antigravity-harness.js";

export class PatchError extends Error {
  constructor(message, { code = 1 } = {}) {
    super(message);
    this.name = "PatchError";
    this.code = code;
  }
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Resolve the harness module to install: the built dist/antigravity-harness.js
 * if the harness build has run, otherwise the raw
 * src/harness/antigravity-harness.js source (or, in tests, an explicit
 * override path). Fails loudly if neither exists.
 */
export function resolveHarnessSource({ repoRoot = REPO_ROOT, override } = {}) {
  if (override) {
    if (!existsSync(override)) {
      throw new PatchError(`Harness override not found at ${override}`);
    }
    return override;
  }
  const distPath = path.join(repoRoot, "dist", "antigravity-harness.js");
  if (existsSync(distPath)) return distPath;

  const srcPath = path.join(repoRoot, "src", "harness", "antigravity-harness.js");
  if (existsSync(srcPath)) return srcPath;

  throw new PatchError(
    `No harness module found. Expected a built module at ${distPath} ` +
      `(run \`npm run build\`) or source at ${srcPath}.`,
  );
}

export const WRAPPER_FILENAME = "agy-xirp";

/**
 * Resolve the agy-xirp launch wrapper script to install: the repo's
 * src/wrapper/agy-xirp (or, in tests, an explicit override path). It's a
 * plain bash script, not built, so there's no dist/ counterpart.
 */
export function resolveWrapperSource({ repoRoot = REPO_ROOT, override } = {}) {
  if (override) {
    if (!existsSync(override)) {
      throw new PatchError(`Wrapper override not found at ${override}`);
    }
    return override;
  }
  const srcPath = path.join(repoRoot, "src", "wrapper", WRAPPER_FILENAME);
  if (!existsSync(srcPath)) {
    throw new PatchError(`Wrapper script not found at ${srcPath}`);
  }
  return srcPath;
}

/**
 * Directory the agy-xirp wrapper should live in: next to whatever `agy` PATH
 * resolves to right now, so squab's own PATH lookup for `agy-xirp` finds it
 * in the same place. Falls back to ~/.local/bin (where `agy install` puts
 * the real binary) when `agy` isn't found on PATH yet.
 */
export function resolveAgyDir({ env = process.env, home } = {}) {
  try {
    const out = execFileSync("which", ["agy"], { encoding: "utf8", env }).trim();
    if (out) return { dir: path.dirname(out), agyPath: out, resolved: true };
  } catch {
    /* `agy` not on PATH yet — fall through to the default install location */
  }
  const fallbackHome = home || env.HOME || os.homedir();
  return { dir: path.join(fallbackHome, ".local", "bin"), agyPath: null, resolved: false };
}

/**
 * Install (or refresh) the agy-xirp launch wrapper. Idempotent: just
 * re-copies over whatever's there. Returns { wrapperPath, resolved, warning }
 * — `warning` is set (not thrown) when `agy` couldn't be found on PATH, since
 * the user may simply not have installed it yet; the wrapper is still
 * dropped at the fallback location so it's ready once they do.
 */
export function installWrapper({
  repoRoot = REPO_ROOT,
  env = process.env,
  home,
  wrapperOverride,
} = {}) {
  const wrapperSource = resolveWrapperSource({ repoRoot, override: wrapperOverride });
  const { dir, resolved } = resolveAgyDir({ env, home });
  const warning = resolved
    ? null
    : `agy was not found on PATH; installed agy-xirp to ${path.join(dir, WRAPPER_FILENAME)}. ` +
      `Install the Antigravity CLI (agy) so agy-xirp can find and exec it.`;

  mkdirSync(dir, { recursive: true });
  const wrapperPath = path.join(dir, WRAPPER_FILENAME);
  copyFileSync(wrapperSource, wrapperPath);
  chmodSync(wrapperPath, 0o755);
  chownToSudoUser(dir);
  chownToSudoUser(wrapperPath);

  return { wrapperPath, resolved, warning };
}

/**
 * Delete the agy-xirp wrapper, if present. No-op if it isn't there (already
 * removed by hand, or never installed).
 */
export function removeWrapper(wrapperPath) {
  if (wrapperPath && existsSync(wrapperPath)) {
    unlinkSync(wrapperPath);
    return true;
  }
  return false;
}

/**
 * Read the version declared in package.json (the "patch version" recorded in
 * state, so future runs can tell which version of xirp-antigravity applied a
 * patch).
 */
function readPatchVersion(repoRoot = REPO_ROOT) {
  const pkg = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  return pkg.version;
}

/**
 * Verify the patched squab CLI still runs and now reports an "antigravity"
 * harness.
 */
function verify({ nodePath, cliPath }) {
  let availableRaw;
  try {
    availableRaw = execFileSync(nodePath, [cliPath, "--available-harnesses"], {
      encoding: "utf8",
    });
  } catch (err) {
    throw new PatchError(
      `Verification failed: \`${nodePath} ${cliPath} --available-harnesses\` did not run: ${err.message}`,
    );
  }

  let available;
  try {
    available = JSON.parse(availableRaw);
  } catch {
    throw new PatchError(
      `Verification failed: --available-harnesses did not print JSON:\n${availableRaw}`,
    );
  }
  // Real squab prints an object ({schema, count, harnesses: [...]}); accept a
  // bare array too for robustness (and for lightweight test fakes).
  const harnessList = Array.isArray(available)
    ? available
    : Array.isArray(available?.harnesses)
      ? available.harnesses
      : null;
  if (!harnessList) {
    throw new PatchError(
      `Verification failed: --available-harnesses output has neither an array ` +
        `nor a "harnesses" array:\n${availableRaw}`,
    );
  }
  const hasAntigravity = harnessList.some((h) => h && h.agentName === "antigravity");
  if (!hasAntigravity) {
    throw new PatchError(
      `Verification failed: no harness with agentName "antigravity" in --available-harnesses output:\n${availableRaw}`,
    );
  }

  let versionRaw;
  try {
    versionRaw = execFileSync(nodePath, [cliPath, "--version"], {
      encoding: "utf8",
    }).trim();
  } catch (err) {
    throw new PatchError(
      `Verification failed: \`${nodePath} ${cliPath} --version\` did not run: ${err.message}`,
    );
  }
  if (!/^\d+\.\d+\.\d+/.test(versionRaw)) {
    throw new PatchError(
      `Verification failed: --version did not print semver, got: ${versionRaw}`,
    );
  }

  return { available, version: versionRaw };
}

/**
 * Confirm the chunk actually has the `rt`/`ot` identifiers this patch wires
 * into, near the registry signature. If a future Xirp release renamed them,
 * fail loudly rather than silently injecting into the wrong scope.
 */
function resolveRegistryIdentifiers(chunk) {
  const ids = detectRegistryIdentifiers(chunk.content);
  if (!ids) {
    throw new LocateError(
      `Chunk ${chunk.path} has the registry signature but its registerAdapter/` +
        `registerAgent calls could not be identified. This Xirp version is unsupported.`,
      { code: 2 },
    );
  }
  return ids;
}

/**
 * Apply the Antigravity harness patch. Idempotent: if the chunk already
 * contains our import line, this is a no-op (unless `force`, which re-copies
 * the harness module and refreshes state without re-appending the import).
 *
 * Safe to run after xirp-grok (or before it): the chunk's existing content —
 * pristine, or already carrying grok's own import line — is preserved as-is
 * and our line is appended after it. The `.orig` backup is created only if
 * one doesn't already exist (so we never clobber grok's pristine backup).
 */
export function apply({
  app,
  force = false,
  env = process.env,
  repoRoot = REPO_ROOT,
  home,
  harnessOverride,
  wrapperOverride,
} = {}) {
  const loc = locate({ app, env });
  const { chunk, chunksDir, cliPath, nodePath, version, appPath } = loc;
  const harnessDest = path.join(chunksDir, HARNESS_FILENAME);
  const backupPath = `${chunk.path}.orig`;

  const alreadyPatched = isPatched(chunk.content);

  if (alreadyPatched && !force) {
    // Always (re-)install the wrapper here too: a state marker from before
    // this feature existed, or a wrapper deleted by hand, shouldn't require
    // --force to fix.
    const wrapperResult = installWrapper({ repoRoot, env, home, wrapperOverride });
    if (wrapperResult.warning) process.stderr.write(`warning: ${wrapperResult.warning}\n`);

    const priorState = readState(home);
    writeState(
      {
        xirpVersion: version,
        chunkPath: chunk.path,
        chunkSha256Original: existsSync(backupPath)
          ? sha256(readFileSync(backupPath))
          : null,
        chunkSha256Patched: sha256(chunk.content),
        harnessSha256: existsSync(harnessDest)
          ? sha256(readFileSync(harnessDest, "utf8"))
          : null,
        patchVersion: readPatchVersion(repoRoot),
        appliedAt: priorState?.appliedAt ?? new Date().toISOString(),
        origOwnedByUs: priorState?.origOwnedByUs ?? false,
        wrapperPath: wrapperResult.wrapperPath,
      },
      home,
    );
    return {
      action: "noop",
      reason: "already-applied",
      appPath,
      version,
      chunkPath: chunk.path,
      wrapperPath: wrapperResult.wrapperPath,
    };
  }

  const ids = resolveRegistryIdentifiers(chunk);
  const importLine = buildImportLine(ids);

  const harnessSource = resolveHarnessSource({
    repoRoot,
    override: harnessOverride,
  });

  let baseContent = chunk.content;
  if (alreadyPatched && force) {
    // Refresh path: strip only our existing import line so we don't
    // duplicate it, then re-append below with (possibly) an updated
    // harness. Any foreign (e.g. grok) import line is left untouched.
    baseContent = chunk.content.replace(IMPORT_LINE_RE, "");
  }

  const backupCreatedThisRun = !existsSync(backupPath);
  if (backupCreatedThisRun) {
    // Preserve the exact original bytes before touching anything. When the
    // chunk on disk is exactly `chunk.path`'s current content (the normal,
    // non-refresh path), copy it byte-for-byte rather than round-tripping
    // through a decoded string.
    if (alreadyPatched && force) {
      writeFileSync(backupPath, baseContent, "utf8");
    } else {
      copyFileSync(chunk.path, backupPath);
    }
  }
  // Whoever creates the `.orig` backup "owns" it: only the owner may ever
  // delete it (on `remove`). If a backup already existed here, some other
  // tool (xirp-grok) got there first and owns it — never overwrite or later
  // delete it ourselves. Fall back to whatever a prior run of ours recorded,
  // since a `force` refresh doesn't recreate an existing backup.
  const priorState = readState(home);
  const origOwnedByUs = backupCreatedThisRun || Boolean(priorState?.origOwnedByUs);

  const newContent = baseContent + importLine;

  let wrapperResult;
  try {
    copyFileSync(harnessSource, harnessDest);
    writeFileSync(chunk.path, newContent, "utf8");
    verify({ nodePath, cliPath });
    wrapperResult = installWrapper({ repoRoot, env, home, wrapperOverride });
  } catch (err) {
    // Never leave Xirp in a broken half-patched state: restore the chunk to
    // exactly what it held before this run's edit (which may already carry a
    // foreign import line — never the full `.orig` backup, which could be
    // older than that), drop the harness copy, and remove the backup only if
    // we created it in this run (a pre-existing backup is still needed for a
    // future `remove`, by us or by whichever tool owns it).
    writeFileSync(chunk.path, baseContent, "utf8");
    if (existsSync(harnessDest)) unlinkSync(harnessDest);
    if (backupCreatedThisRun) unlinkSync(backupPath);
    throw new PatchError(`Rolled back: ${err.message}`, {
      code: err.code ?? 1,
    });
  }
  if (wrapperResult.warning) process.stderr.write(`warning: ${wrapperResult.warning}\n`);

  const backupBuffer = readFileSync(backupPath);
  const state = {
    xirpVersion: version,
    chunkPath: chunk.path,
    chunkSha256Original: sha256(backupBuffer),
    chunkSha256Patched: sha256(newContent),
    harnessSha256: sha256(readFileSync(harnessDest, "utf8")),
    wrapperPath: wrapperResult.wrapperPath,
    patchVersion: readPatchVersion(repoRoot),
    appliedAt: new Date().toISOString(),
    origOwnedByUs,
  };
  writeState(state, home);

  return {
    action: alreadyPatched ? "refreshed" : "applied",
    appPath,
    version,
    chunkPath: chunk.path,
    state,
  };
}

/**
 * Remove the patch: strip only our own import line from the registry chunk
 * (never a full restore-from-backup — that would also undo a coexisting
 * xirp-grok patch), delete our harness module, and drop the `.orig` backup
 * only if we created it *and* the chunk is now byte-identical to it (i.e.
 * nothing else is still patching it). Clears our state marker either way.
 * No-op (not an error) if there's nothing to remove.
 */
export function remove({ app, env = process.env, home } = {}) {
  const state = readState(home);
  if (!state) {
    return { action: "noop", reason: "no-state" };
  }

  const { chunkPath, origOwnedByUs, wrapperPath } = state;
  const backupPath = `${chunkPath}.orig`;

  if (!existsSync(chunkPath)) {
    throw new PatchError(
      `Recorded chunk not found at ${chunkPath} (Xirp may have been updated or moved). ` +
        `Run \`xirp-antigravity doctor\` to inspect the current install.`,
    );
  }

  const content = readFileSync(chunkPath, "utf8");
  if (!isPatched(content)) {
    // Our marker isn't there any more (already removed by hand, or Xirp
    // updated and replaced the chunk) — nothing for us to strip. Just drop
    // our own state (and wrapper) so we stop claiming to be applied.
    removeWrapper(wrapperPath);
    clearState(home);
    return { action: "noop", reason: "not-patched" };
  }

  const stripped = content.replace(IMPORT_LINE_RE, "");
  writeFileSync(chunkPath, stripped, "utf8");

  const harnessPath = path.join(path.dirname(chunkPath), HARNESS_FILENAME);
  if (existsSync(harnessPath)) unlinkSync(harnessPath);

  removeWrapper(wrapperPath);

  // Only ever delete `.orig` if we're the one who created it, and only once
  // the chunk has returned to exactly that pristine state (i.e. no other
  // tool, like xirp-grok, is still patching it) — otherwise leave it in
  // place for whoever still needs it.
  if (origOwnedByUs && existsSync(backupPath)) {
    const backupBuffer = readFileSync(backupPath);
    const strippedBuffer = readFileSync(chunkPath);
    if (Buffer.compare(backupBuffer, strippedBuffer) === 0) {
      unlinkSync(backupPath);
    }
  }

  clearState(home);

  return { action: "removed", chunkPath, wrapperPath };
}
