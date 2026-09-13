# Compatibility

`xirp-grok` locates its injection point in Xirp's `@chirp/squab` bundle by content signature and
structure, not by pinning to a specific build — see `src/patcher/inject.js`. It should keep
working across minor squab releases as long as the registry chunk's general shape holds. This
table tracks combinations that have actually been verified end-to-end, and what registry
identifiers squab used at each.

| Xirp version | squab version | Grok Build version | registry identifiers | status | date |
|---|---|---|---|---|---|
| 0.32.0 | 0.10.12-chirp.93ea528.5 | 1.0.30 | `V` / `z` | verified end-to-end against a scratch copy (harness listed, session pinned and tracked, parse OK, `/exit` terminates) | 2026-09-13 |

`registry identifiers` are the local variable names squab's minified bundle uses for
`registerAdapter` / `registerAgent` in that build (detected automatically by
`detectRegistryIdentifiers` in `src/patcher/inject.js` — listed here only for reference when
diagnosing a new build).

## Adding a row

Against a scratch copy of Xirp (never a live install you depend on):

1. `xirp-grok doctor` — reports the Xirp version, the registry chunk path, whether it's patched,
   and the detected registry identifiers.
2. `grok --version` — the Grok Build version in use.
3. Confirm the harness actually works: `xirp-grok apply`, restart Xirp, check Grok appears in the
   agent picker, start a session, resume it, and confirm `/exit` terminates it cleanly.
4. Add a row with the Xirp version, squab version (from
   `app.asar.unpacked/node_modules/@chirp/squab/package.json`), Grok Build version, the detected
   identifiers, a one-line status, and today's date.

If `xirp-grok apply` exits with code `2` ("unsupported"), that Xirp/squab combination isn't
supported yet — no row to add, and nothing on disk was changed.
