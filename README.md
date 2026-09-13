# xirp-antigravity

Adds Google's **Antigravity CLI** (`agy`) as a coding agent inside Spotify's **Xirp** desktop app.

Not affiliated with Spotify or Google.

## How it works

Xirp bundles a package called `@chirp/squab` at
`Xirp.app/Contents/Resources/app.asar.unpacked/node_modules/@chirp/squab/dist/` — outside
`app.asar`, which is integrity-checked and therefore off-limits. `squab` is what registers each
coding-agent harness (Claude, Cursor, etc.) that shows up in Xirp's agent picker.

`xirp-antigravity apply`:

1. Finds the squab chunk that registers harnesses (`chunks/index-<hash>.js` — the hash changes
   every Xirp release, so it's located by a content signature, not a filename) and backs it up
   byte-for-byte as `chunks/<chunk>.js.orig` (once, before the first edit — see
   [Coexistence with xirp-grok](#coexistence-with-xirp-grok) if that backup already exists).
2. Detects that chunk's local variable names for squab's `registerAdapter`/`registerAgent`
   functions (they're minified and change per build) and appends one line to it:
   `import { registerAntigravity } from "./antigravity-harness.js"; registerAntigravity(<adapter>, <agent>);`
3. Copies one self-contained file, `chunks/antigravity-harness.js`, next to it. This is the whole
   integration: a harness definition (flag, binary, install hint) plus a session adapter that
   reads/writes Antigravity's own conversation files so Xirp can track and resume sessions.
4. Installs the `agy-xirp` launch wrapper next to whatever `agy` resolves to on `PATH` (see
   [Launch wrapper](#launch-wrapper) below) and points the harness at it instead of `agy` directly.
5. Writes a state marker to `~/.xirp-antigravity/state.json` (hashes, versions, wrapper path,
   timestamp) so future runs can tell whether Xirp has been updated and needs re-patching.

Nothing else is modified. `app.asar` is never touched.

## Launch wrapper

Xirp builds every coding agent's command line itself, and for **every** agent it appends the
session's initial prompt as a bare trailing positional argument — something like
`agy --launch-antigravity --session-id <id> 'do the thing'`. That argv-building code lives inside
squab's integrity-checked `app.asar` and can't be patched from outside it. `agy` (a Go binary
built on the standard `flag` package) rejects positional arguments outright — `Error: unexpected
argument "do the thing". Prompts are read only from -p/--print, -i/--prompt-interactive, or
stdin` — and exits non-zero, which from Xirp looks like the terminal flashing open and closing.

`apply` installs `src/wrapper/agy-xirp`, a small bash script, as `agy-xirp` in the same directory
`agy` resolves to on `PATH` (falling back to `~/.local/bin` — where `agy install` puts the real
binary — if `agy` isn't on `PATH` yet), and the harness definition's `binary` points at
`agy-xirp` instead of `agy`. The wrapper rewrites a trailing positional argument into
`-i "<text>"` (folding it into an already-present `-i`/`--prompt-interactive` value instead, if
one exists) and then `exec`s the real `agy` with the rewritten argv. Every other invocation shape
— no args, a subcommand like `agy mcp ...`, an already-flag-only argv — passes straight through
untouched.

`remove` deletes the wrapper it installed (recorded as `wrapperPath` in
`~/.xirp-antigravity/state.json`); it never touches the real `agy` binary.

## Requirements

- macOS
- Xirp 0.32.x (see `docs/COMPAT.md` for exactly what's been verified)
- [Antigravity CLI](https://antigravity.google/) (`agy`) installed and signed in
- Node >= 20, to run `xirp-antigravity` itself (Xirp's own bundled runtime is untouched)

## Install

Run these **from your own terminal, as sudo**. Do not run `apply` from inside Claude Code,
Codex, Xirp, or any other agent or TUI: macOS attributes the write to whichever app hosts the
shell, and those apps do not have permission to modify other app bundles, so the patch fails
with `EPERM` even though you own the files.

```sh
git clone https://github.com/alta-atc/xirp-antigravity
cd xirp-antigravity
npm run build
sudo node bin/xirp-antigravity.js apply
```

Or link it onto your `PATH` and run `sudo xirp-antigravity apply`.

Quit Xirp first, then **launch it again** after the patch. Antigravity appears in the agent
picker.

### Why sudo, and the alternative

Since macOS 13, writing inside another app's bundle in `/Applications` is gated by the
**App Management** privacy permission (the bundle carries `com.apple.provenance`). A plain
terminal does not have it, so `apply` and `remove` fail with:

```
error: EPERM: operation not permitted, copyfile '/Applications/Xirp.app/.../index-<hash>.js' -> ...
```

Two ways through:

1. **`sudo`** (simplest). The state marker in `~/.xirp-antigravity/` is chowned back to your
   user, so `status` and `doctor` keep working without sudo.
2. **Grant your terminal App Management.** System Settings → **Privacy & Security** →
   **App Management** → turn on **Terminal** (or iTerm2, Ghostty, etc.; click **+** and pick the
   app if it is not listed). Quit and reopen the terminal for the grant to take effect. After
   that, `apply` works without sudo.

The launchd watcher (`install-watcher`) runs unprivileged as `node`, so it only works once
App Management is granted to that `node` binary. Until then, re-apply by hand after each
Xirp update:

```sh
sudo node bin/xirp-antigravity.js apply --if-needed
```

## Commands

```
xirp-antigravity status              # is the harness applied? which Xirp version?
xirp-antigravity apply               # patch Xirp.app to add the antigravity harness
xirp-antigravity apply --if-needed   # apply only if not already applied/up to date
xirp-antigravity apply --force       # re-copy the harness and refresh state even if already patched
xirp-antigravity apply --app <path>  # target an Xirp.app at a non-default location
xirp-antigravity remove              # undo the patch, restoring Xirp exactly as it was
xirp-antigravity doctor              # detailed diagnostics: app, chunk, agy binary, state, watcher
xirp-antigravity install-watcher     # install a LaunchAgent that re-applies after Xirp updates
xirp-antigravity uninstall-watcher   # remove that LaunchAgent
```

Exit codes: `0` success/no-op, `1` error, `2` unsupported Xirp version (the patcher couldn't
identify its injection point in this build — see Risks below).

By default the tool targets `/Applications/Xirp.app`; override with `--app <path>`.

### install-watcher

Xirp auto-updates, which overwrites the patched chunk. `install-watcher` writes a LaunchAgent
(`~/Library/LaunchAgents/com.alta-atc.xirp-antigravity.plist`) that watches Xirp's
`Contents/Info.plist` for changes and runs `apply --if-needed` whenever it's touched — i.e.
whenever Xirp updates. It re-patches the app automatically; **you still need to restart Xirp**
for the change to take effect, since the watcher doesn't relaunch it for you.

## Coexistence with xirp-grok

`xirp-antigravity` and [`xirp-grok`](https://github.com/alta-atc/xirp-grok) both patch the exact
same squab registry chunk, each by appending its own single import line. They're designed to be
installed side by side, in either order:

- **Backup ownership.** Whichever tool runs `apply` first creates the pristine `chunks/<chunk>.js.orig`
  backup and "owns" it; the second tool detects the backup already exists and never overwrites it.
  `xirp-antigravity`'s own state file records which case happened (`origOwnedByUs`).
- **Applying.** Each tool's `apply` only checks for its *own* marker to decide whether it's
  already patched — a grok import line is never mistaken for ours, or vice versa. Whichever tool
  applies second appends its line after the other's, so both survive.
- **Removing.** `xirp-antigravity remove` strips only its own import line and deletes only
  `chunks/antigravity-harness.js` — never a full restore from `.orig`, which would silently rip
  out a coexisting grok patch too. The `.orig` backup is only ever deleted once the chunk is back
  to byte-for-byte pristine *and* this tool is the one that created that backup in the first
  place; otherwise it's left alone for whichever tool still needs it.
- `xirp-antigravity doctor` and `status` report whether a grok patch is also present on the
  chunk, purely informational.

Removing one tool never affects the other's harness.

## What works

- Antigravity shows up in Xirp's agent picker like any other coding agent.
- Sessions are pinned by conversation id and tracked by Xirp (status, activity).
- Transcript and token usage are parsed from Antigravity's own conversation files on disk.
- Resume and fork both work.
- A read-only settings catalog is exposed to Xirp.

## Known limitations

- **Cross-agent handoff into Antigravity is a seeded launch, not a real resume.** `agy` has no
  way to create or pre-seed a conversation from the outside — conversation ids can't be preset,
  and there's no API to fabricate one. A handoff from another agent instead launches `agy -i`
  with the conversation text seeded as the opening prompt, and Xirp discovers the resulting new
  conversation by recency (most-recently-modified file under `~/.gemini/antigravity-cli/`) rather
  than by a known id.
- **No per-agent settings UI.** Xirp's model/permission dropdowns aren't available for
  Antigravity; configure `agy` directly instead.

## Risks, plainly

1. **Signature.** Editing files inside a signed app bundle invalidates its code signature seal.
   Xirp is expected to still launch (the patched files are plain JS loaded by the bundled node,
   not by the system loader), but `codesign --verify` will report a failure. This has been
   verified on a scratch copy of squab, not yet on a live install; see `docs/COMPAT.md`. We
   deliberately do not re-sign the app — re-signing changes its identity, which can lock Xirp out
   of its own Keychain-stored login.
2. **Auto-update.** Xirp updates overwrite the patched chunk with a fresh, unpatched one. Re-run
   `xirp-antigravity apply` (or install the watcher — see above).
3. **Future Xirp releases.** If a later Xirp release changes the registry chunk's shape enough
   that the patcher can't identify `registerAdapter`/`registerAgent`, `apply` exits with code `2`
   and the message "unsupported" — and changes nothing on disk.
4. **Removing it.** `xirp-antigravity remove` strips only this tool's own import line and harness
   file (never a blanket restore from `.orig`), so a coexisting xirp-grok patch — or a future
   third patch on the same chunk — is left untouched. See
   [Coexistence with xirp-grok](#coexistence-with-xirp-grok) for exactly when the `.orig` backup
   itself is deleted.

## Development

```sh
npm test    # node --test test/*.test.js
npm run build
```

Layout:

- `src/patcher/` — locating Xirp's install, injecting/removing the patch, state tracking
  (`locate.js`, `inject.js`, `state.js`)
- `src/harness/` — the Antigravity harness definition and squab session adapter that get built
  into `chunks/antigravity-harness.js` (`adapter.js`, `paths.js`, `transcript.js`,
  `antigravity-harness.js`)
- `src/wrapper/agy-xirp` — the launch wrapper `apply` installs next to `agy` on `PATH` (see
  [Launch wrapper](#launch-wrapper))
- `scripts/build-harness.js` — bundles `src/harness/` into the single-file
  `dist/antigravity-harness.js` that `apply` copies into Xirp

## License

MIT
