// Locates the pieces of an installed Xirp.app that xirp-antigravity needs to patch:
// the app itself, its version, the bundled node runtime, the squab CLI, its
// chunks directory, and the specific chunk that registers coding-agent
// harnesses (identified by a stable string signature, since the chunk's
// filename hash changes on every Xirp release).
//
// Every function here takes the app path explicitly (no hidden globals) so
// tests can point them at a fake app tree under a temp directory instead of
// the real /Applications/Xirp.app.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

export const DEFAULT_APP_PATH = "/Applications/Xirp.app";

// The string that identifies the squab chunk responsible for registering
// coding-agent harnesses (Cursor is one of the built-in ones).
// Matched as a regex because the shipped chunk is minified (`flag:"--launch-cursor"`)
// while prettified copies have a space after the colon.
export const REGISTRY_SIGNATURE = /flag:\s*"--launch-cursor"/;

export class LocateError extends Error {
  constructor(message, { code = 1 } = {}) {
    super(message);
    this.name = "LocateError";
    this.code = code;
  }
}

/**
 * Resolve which Xirp.app to operate on.
 * Precedence: explicit `app` argument > `XIRP_APP` env var > default.
 */
export function resolveAppPath({ app, env = process.env } = {}) {
  return app || env.XIRP_APP || DEFAULT_APP_PATH;
}

/**
 * Read CFBundleShortVersionString out of Contents/Info.plist.
 * Prefers `plutil -convert json -o -` (present on every macOS install, no
 * deps); falls back to a small regex-based XML plist parse if plutil is
 * unavailable (e.g. in a non-macOS test/CI environment).
 */
export function readAppVersion(appPath) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  if (!existsSync(plistPath)) {
    throw new LocateError(
      `Info.plist not found at ${plistPath} — is ${appPath} a valid Xirp.app?`,
    );
  }

  try {
    const json = execFileSync(
      "plutil",
      ["-convert", "json", "-o", "-", plistPath],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(json);
    if (!parsed.CFBundleShortVersionString) {
      throw new LocateError(
        `${plistPath} has no CFBundleShortVersionString key`,
      );
    }
    return parsed.CFBundleShortVersionString;
  } catch (err) {
    if (err instanceof LocateError) throw err;
    // plutil missing or failed (e.g. non-macOS test env) — fall back to a
    // minimal regex parse of the XML plist.
    const xml = readFileSync(plistPath, "utf8");
    const match = xml.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
    );
    if (!match) {
      throw new LocateError(
        `Could not find CFBundleShortVersionString in ${plistPath} (plutil failed: ${err.message})`,
      );
    }
    return match[1];
  }
}

export function resolveNodeRuntime(appPath) {
  const nodePath = path.join(
    appPath,
    "Contents",
    "Resources",
    "node-runtime",
    "node",
  );
  if (!existsSync(nodePath)) {
    throw new LocateError(`Bundled node runtime not found at ${nodePath}`);
  }
  return nodePath;
}

export function resolveCliPath(appPath) {
  const cliPath = path.join(
    appPath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "@chirp",
    "squab",
    "dist",
    "cli.js",
  );
  if (!existsSync(cliPath)) {
    throw new LocateError(`Squab CLI not found at ${cliPath}`);
  }
  return cliPath;
}

export function resolveChunksDir(cliPath) {
  const chunksDir = path.join(path.dirname(cliPath), "chunks");
  if (!existsSync(chunksDir)) {
    throw new LocateError(`Squab chunks directory not found at ${chunksDir}`);
  }
  return chunksDir;
}

/**
 * Scan the chunks directory for the file whose content contains
 * REGISTRY_SIGNATURE. Throws LocateError (code 2 — "unsupported Xirp
 * version") if no chunk matches, naming the directory searched.
 */
export function findRegistryChunk(chunksDir) {
  const entries = readdirSync(chunksDir).filter((f) => f.endsWith(".js"));
  for (const name of entries) {
    const filePath = path.join(chunksDir, name);
    const content = readFileSync(filePath, "utf8");
    if (REGISTRY_SIGNATURE.test(content)) {
      return { path: filePath, name, content };
    }
  }
  throw new LocateError(
    `No chunk in ${chunksDir} contains the registry signature (${REGISTRY_SIGNATURE.source}). ` +
      `This Xirp version is unsupported.`,
    { code: 2 },
  );
}

/**
 * Locate everything needed to patch a given Xirp.app, in one call.
 * Returns { appPath, version, nodePath, cliPath, chunksDir, chunk }.
 */
export function locate({ app, env = process.env } = {}) {
  const appPath = resolveAppPath({ app, env });
  if (!existsSync(appPath)) {
    throw new LocateError(`Xirp.app not found at ${appPath}`);
  }
  const version = readAppVersion(appPath);
  const nodePath = resolveNodeRuntime(appPath);
  const cliPath = resolveCliPath(appPath);
  const chunksDir = resolveChunksDir(cliPath);
  const chunk = findRegistryChunk(chunksDir);
  return { appPath, version, nodePath, cliPath, chunksDir, chunk };
}
