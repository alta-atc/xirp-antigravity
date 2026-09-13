# xirp-grok

Adds xAI's **Grok Build** CLI (`grok`) as a coding agent inside Spotify's **Xirp** desktop app.

Not affiliated with Spotify or xAI.

## How it works

Xirp bundles a package called `@chirp/squab` at
`Xirp.app/Contents/Resources/app.asar.unpacked/node_modules/@chirp/squab/dist/` — outside
`app.asar`, which is integrity-checked and therefore off-limits. `squab` is what registers each
coding-agent harness (Claude, Cursor, etc.) that shows up in Xirp's agent picker.

`xirp-grok apply`:

1. Finds the squab chunk that registers harnesses (`chunks/index-<hash>.js` — the hash changes
   every Xirp release, so it's located by a content signature, not a filename) and backs it up
   byte-for-byte as `chunks/<chunk>.js.orig` (once, before the first edit).
2. Detects that chunk's local variable names for squab's `registerAdapter`/`registerAgent`
   functions (they're minified and change per build) and appends one line to it:
   `import { registerGrok } from "./grok-harness.js"; registerGrok(<adapter>, <agent>);`
3. Copies one self-contained file, `chunks/grok-harness.js`, next to it. This is the whole
   integration: a harness definition (flag, binary, install hint) plus a session adapter that
   reads/writes Grok's own session files so Xirp can track and resume sessions.
4. Writes a state marker to `~/.xirp-grok/state.json` (hashes, versions, timestamp) so future runs
   can tell whether Xirp has been updated and needs re-patching.

Nothing else is modified. `app.asar` is never touched.

## Requirements

- macOS
- Xirp 0.32.x (see `docs/COMPAT.md` for exactly what's been verified)
- [Grok Build](https://x.ai/cli/install.sh) installed and signed in:
  `curl -fsSL https://x.ai/cli/install.sh | bash`
- Node >= 20, to run `xirp-grok` itself (Xirp's own bundled runtime is untouched)

## Install

Run these **from your own terminal, as sudo**. Do not run `apply` from inside Claude Code,
Codex, Xirp, or any other agent or TUI: macOS attributes the write to whichever app hosts the
shell, and those apps do not have permission to modify other app bundles, so the patch fails
with `EPERM` even though you own the files.

```sh
git clone https://github.com/alta-atc/xirp-grok
cd xirp-grok
npm run build
sudo node bin/xirp-grok.js apply
```

Or link it onto your `PATH` and run `sudo xirp-grok apply`.

Quit Xirp first, then **launch it again** after the patch. Grok appears in the agent picker.

### Why sudo, and the alternative

Since macOS 13, writing inside another app's bundle in `/Applications` is gated by the
**App Management** privacy permission (the bundle carries `com.apple.provenance`). A plain
terminal does not have it, so `apply` and `remove` fail with:

```
error: EPERM: operation not permitted, copyfile '/Applications/Xirp.app/.../index-<hash>.js' -> ...
```

Two ways through:

1. **`sudo`** (simplest). The state marker in `~/.xirp-grok/` is chowned back to your user, so
   `status` and `doctor` keep working without sudo.
2. **Grant your terminal App Management.** System Settings → **Privacy & Security** →
   **App Management** → turn on **Terminal** (or iTerm2, Ghostty, etc.; click **+** and pick the
   app if it is not listed). Quit and reopen the terminal for the grant to take effect. After
   that, `apply` works without sudo.

The launchd watcher (`install-watcher`) runs unprivileged as `node`, so it only works once
App Management is granted to that `node` binary. Until then, re-apply by hand after each
Xirp update:

```sh
sudo node bin/xirp-grok.js apply --if-needed
```

## Commands

```
xirp-grok status              # is the harness applied? which Xirp version?
xirp-grok apply               # patch Xirp.app to add the grok harness
xirp-grok apply --if-needed   # apply only if not already applied/up to date
xirp-grok apply --force       # re-copy the harness and refresh state even if already patched
xirp-grok apply --app <path>  # target an Xirp.app at a non-default location
xirp-grok remove              # undo the patch, restoring Xirp exactly as it was
xirp-grok doctor              # detailed diagnostics: app, chunk, grok binary, state, watcher
xirp-grok install-watcher     # install a LaunchAgent that re-applies after Xirp updates
xirp-grok uninstall-watcher   # remove that LaunchAgent
```

Exit codes: `0` success/no-op, `1` error, `2` unsupported Xirp version (the patcher couldn't
identify its injection point in this build — see Risks below).

By default the tool targets `/Applications/Xirp.app`; override with `--app <path>`.

### install-watcher

Xirp auto-updates, which overwrites the patched chunk. `install-watcher` writes a LaunchAgent
(`~/Library/LaunchAgents/com.alta-atc.xirp-grok.plist`) that watches Xirp's `Contents/Info.plist`
for changes and runs `apply --if-needed` whenever it's touched — i.e. whenever Xirp updates. It
re-patches the app automatically; **you still need to restart Xirp** for the change to take
effect, since the watcher doesn't relaunch it for you.

## What works

- Grok shows up in Xirp's agent picker like any other coding agent.
- Sessions are pinned by session id and tracked by Xirp (status, activity).
- Transcript and token usage are parsed from Grok's own session files on disk.
- Resume and fork both work.
- A read-only settings catalog (config.toml, AGENTS.md, MCP config, hooks) is exposed to Xirp.

## Known limitations

- **Cross-agent handoff into Grok is best-effort.** Grok's history format has no per-message
  timestamps, and its reasoning content is encrypted and not carried over — a transcript handed
  off from another agent will seed Grok with the conversation text but not timing or prior
  reasoning.
- **No per-agent settings UI.** Xirp's model/permission dropdowns aren't available for Grok; set
  defaults in `~/.grok/config.toml` instead.

## Risks, plainly

1. **Signature.** Editing files inside a signed app bundle invalidates its code signature seal.
   Xirp is expected to still launch (the patched files are plain JS loaded by the bundled node, not by the system loader), but `codesign --verify` will report a failure. This has been verified on a scratch copy of squab, not yet on a live install; see `docs/COMPAT.md`. We
   deliberately do not re-sign the app — re-signing changes its identity, which can lock Xirp out
   of its own Keychain-stored login.
2. **Auto-update.** Xirp updates overwrite the patched chunk with a fresh, unpatched one. Re-run
   `xirp-grok apply` (or install the watcher — see above).
3. **Future Xirp releases.** If a later Xirp release changes the registry chunk's shape enough
   that the patcher can't identify `registerAdapter`/`registerAgent`, `apply` exits with code `2`
   and the message "unsupported" — and changes nothing on disk.
4. **Removing it.** `xirp-grok remove` restores the original chunk byte-for-byte from the `.orig`
   backup, deletes the harness file and backup, and clears the state marker.

## Development

```sh
npm test    # node --test test/*.test.js
npm run build
```

Layout:

- `src/patcher/` — locating Xirp's install, injecting/removing the patch, state tracking
  (`locate.js`, `inject.js`, `state.js`)
- `src/harness/` — the Grok harness definition and squab session adapter that get built into
  `chunks/grok-harness.js` (`adapter.js`, `paths.js`, `transcript.js`, `grok-harness.js`)
- `scripts/build-harness.js` — bundles `src/harness/` into the single-file `dist/grok-harness.js`
  that `apply` copies into Xirp

## License

MIT
