# Compatibility

`xirp-antigravity` locates its injection point in Xirp's `@chirp/squab` bundle by content
signature and structure, not by pinning to a specific build — see `src/patcher/inject.js`. It
should keep working across minor squab releases as long as the registry chunk's general shape
holds. This table tracks combinations that have actually been verified end-to-end, and what
registry identifiers squab used at each.

| Xirp version | squab version | Antigravity CLI (agy) version | registry identifiers | status | date |
|---|---|---|---|---|---|
| 0.32.0 | 0.10.12-chirp.93ea528.5 | 1.2.0 | `V` / `z` | verified end-to-end against a scratch copy (harness listed, session pinned and tracked, parse OK, exit terminates) | 2026-09-13 |
| 0.32.0 | 0.10.12-chirp.93ea528.5 | 1.2.2 | `V` / `z` | verified end-to-end with the `agy-xirp` launch wrapper (harness listed, session launches with the goal seeded via `-i` instead of failing on a positional argument, exit terminates) | 2026-09-13 |

`registry identifiers` are the local variable names squab's minified bundle uses for
`registerAdapter` / `registerAgent` in that build (detected automatically by
`detectRegistryIdentifiers` in `src/patcher/inject.js` — listed here only for reference when
diagnosing a new build).

## Coexistence with xirp-grok

The chunk (`index-Bop4lAK7.js` at Xirp 0.32.0) is the same one
[`xirp-grok`](https://github.com/alta-atc/xirp-grok) patches. Both tools have been verified
applying to the same chunk in either order: whichever applies first creates the `.orig` backup,
the second appends its import line after the first's without disturbing it, and `remove` on
either tool leaves the other's patch (and its harness file) intact. See the
[Coexistence with xirp-grok](../README.md#coexistence-with-xirp-grok) section of the README for
the full behavior.

## Adding a row

Against a scratch copy of Xirp (never a live install you depend on):

1. `xirp-antigravity doctor` — reports the Xirp version, the registry chunk path, whether it's
   patched, whether a grok patch is also present, and the detected registry identifiers.
2. `agy --version` — the Antigravity CLI version in use.
3. Confirm the harness actually works: `xirp-antigravity apply`, restart Xirp, check Antigravity
   appears in the agent picker, start a session, resume it, and confirm it terminates cleanly.
4. Add a row with the Xirp version, squab version (from
   `app.asar.unpacked/node_modules/@chirp/squab/package.json`), Antigravity CLI version, the
   detected identifiers, a one-line status, and today's date.

If `xirp-antigravity apply` exits with code `2` ("unsupported"), that Xirp/squab combination
isn't supported yet — no row to add, and nothing on disk was changed.
