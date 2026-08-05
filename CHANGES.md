# Summary of all changes across this project

## Theme export now includes host GSettings + only enabled widgets (this session, 2026-08-05)
`lib/exportService.js`'s `.gwct` export previously only captured global
`theme.json` appearance + every discovered widget's settings, regardless
of whether that widget was actually turned on. Two changes:

- **Host preferences added:** a new `hostSettings` block in the document
  carries every non-secret host-level GSettings preference (edge margin,
  widget spacing, snapping, language, overlay keybinding, etc — see
  `HOST_SETTINGS_KEYS` in `exportService.js`). Deliberately excludes
  `disabled-widgets` (superseded by the enabled-only filtering below),
  `requested-widget-id` (a transient IPC hint, not a real preference —
  already documented as such in the schema itself), and `dev-mode` (a
  developer toggle, not part of "how this desktop looks"). None of these
  keys are secrets, so nothing here goes through `secretFields.js`.
- **Only enabled widgets exported:** `buildGwctDocument()` now filters
  out anything in the host's `disabled-widgets` list before building
  `widgets[]`, instead of exporting every discovered widget whether it's
  in use or not.

`importGwctDocument()` updated to match: applies `hostSettings` back
(skipping any key the local schema doesn't recognize, so one mismatched
key can't fail the whole import), and explicitly re-enables each
imported widget (removing it from `disabled-widgets` if present) — since
every entry in an exported file was enabled at export time, importing it
should reproduce that, even onto a machine where that widget happens to
be currently disabled. Both changes are additive to the `.gwct` format
(no version bump) — a `hostSettings`-less older file still imports fine,
and an older build reading a new file just won't apply the extra block.

Both `settings` params are optional on both functions, so existing/
tested callers without a `SettingsService` handy keep working exactly as
before. Import/Export page's description text updated (`en`/`th`
locales) to reflect the new scope; other locale files not touched.

## Theme export crash: "structuredClone is not defined" (this session, 2026-08-05)
`lib/secretFields.js`'s `redactSecrets()` — called for every widget on
every `.gwct` theme export — used `structuredClone()` to deep-copy a
widget's settings before redacting secrets from the copy. GJS doesn't
reliably provide `structuredClone` as a global the way browsers/Node do,
so this threw `structuredClone is not defined` immediately, before any
export or redaction actually happened. Replaced with a
`JSON.parse(JSON.stringify(...))` round-trip, which is a safe deep clone
here since widget settings are always plain JSON-serializable data (no
Dates/Maps/functions to worry about losing).

## Media-player first-play fix + background-color alpha rollout (this session, 2026-08-05)
Partial session — see `development/handoff-2026-08-05-bg-alpha-media-fix.md`
for what's still outstanding (geek top-label font size, overlay tab/content
centering, Overview help text + sort).

- **Fixed:** `lib/mediaApi.js`'s `MprisMediaService._attachToPlayer()` now
  calls `_refreshThenEmit()` (a live `Properties.GetAll`) instead of
  `_emitFromProxy()` (a plain cache read) as its first render after attach.
  A freshly-launched player that flips `PlaybackStatus` to `Playing` right
  around when its MPRIS name registers could have that transition lost to
  a race against `GDBusProxy`'s own construction-time cache sync, leaving
  the widget stuck showing the pre-playback icon indefinitely. Affects all
  four bundled media widgets (`media-player-poster`/`-square`/`-circle`/
  `-wide`), which all share this file.
- **Changed:** every `backgroundColor` field across **48 widgets**
  (full list in the handoff doc) now has `alpha: true` and defaults to
  `#FFFFFF00` (fully transparent), in both `config.json` and each
  `widget.js`'s `getDefaultSettings()`/render-time fallback. `mini-notes`
  was deliberately left alone (its opaque sticky-note yellow isn't a card
  background). `widgets/_template/widget.js` updated too for consistency.
  **Note:** this changes default on-screen appearance — all 48 now render
  with a transparent card background out of the box until a color/opacity
  is set.

## Weather Dark alignment fix (this session)
`widgets/weather-dark/widget.js`'s root `St.Bin` had `x_align`/`y_align`
set correctly (standard `St.Align.START`/`MIDDLE` — `St.Align` has no
`CENTER`, only `MIDDLE`, so that part was already right) but was missing
`x_expand`/`y_expand`. Without expand flags, alignment properties often
have no extra space to actually center within. Added both. I could not
find a literal crash/error matching "align.Center" anywhere in the
codebase after a full search — if you still see a specific error message,
please paste it and I'll dig further (see checklist.md §8).

## `.gwcbak` backup format switched to tar+gzip+AES (this session)
Replaced shelling out to `zip -P`/`unzip -P` with:
- `tar -czf`/`tar -xzf` for the archive itself (one system dependency
  instead of two, and `tar` is close to universally preinstalled)
- A from-scratch pure-JS crypto stack (no `gi://` crypto primitive
  exists to lean on) in `lib/crypto/`: SHA-256, HMAC-SHA256, PBKDF2, and
  AES-256-CTR. Each piece was verified before being trusted — SHA-256
  and HMAC-SHA256 against official NIST/RFC test vectors, PBKDF2 against
  published test vectors, AES-256-CTR cross-checked against Node's own
  native `crypto` across 10 message lengths including block-boundary
  cases (my one attempt to hand-verify against a NIST vector directly
  failed because I mistyped the hex key — Node's own implementation is
  more trustworthy than my transcription anyway).
- Encrypt-then-MAC construction (HMAC-SHA256 tag over salt+iv+ciphertext)
  so a wrong password now fails with a clear "incorrect password" error
  instead of `unzip` silently producing garbage — a real improvement
  over the old design, not just a like-for-like swap.

While building the automated tests for this, found and fixed a real bug:
secret redaction *detected* secrets nested inside arrays/objects (e.g.
`accounts[].accessToken`) correctly but only *removed* top-level keys —
nested secrets would have silently survived into a `.gwct` export.
Rewrote `secretFields.js`'s redaction to walk the settings value and
schema in tandem recursively.

## Test widget + checklists (this session)
- `widgets/qa-test-widget/` — not a real desktop widget; exists purely
  to exercise the force/appearance system, secret redaction (explicit
  password/email fields, a name-heuristic field, and a secret nested
  inside a list of objects), and dependency checking (one always-present
  binary, one that never exists) in one place.
- `testsuite/` — automated tests that import the REAL extension source
  files (not reimplementations) via a Node module loader that redirects
  `gi://Gio`/`gi://GLib` to mocks backed by real file I/O and a real
  `tar` subprocess. 51 assertions, all passing on the current build.
- `checklist.md` — manual QA checklist for everything the automated
  suite can't click through (GTK dialogs, visual centering).

## `.gwct` theme export/import and `.gwcbak` full backup (earlier session)
- `lib/secretFields.js` — recursively detects and redacts secrets in a
  widget's settings based on its config.json schema (`fieldType:
  "password"`, `format: "email"`) plus a name-heuristic fallback.
- `lib/dependencyChecker.js` — reads a new `metadata.json` `dependencies`
  field and checks declared system binaries against `$PATH`.
- `lib/exportService.js` — builds/reads `.gwct`: global appearance +
  per-widget id/position/settings(redacted)/theme, never widget files.
- Wired into the "Import / Export" and "Backup & Restore" pages in
  `prefs.js` (previously "coming soon" placeholders).
- `WIDGET_API.md` documents the new `dependencies` metadata field.

## Force option (background-color / corner-radius) — checked, no bug found
Reviewed `lib/themeService.js` and both appearance UIs in `prefs.js`.
Already correct: forcing ignores per-widget overrides entirely and the
per-widget settings page correctly greys out overridden rows.

## Known limitations / next steps
- No "this will overwrite your settings" confirmation before applying a
  `.gwct` import or `.gwcbak` restore.
- No progress indicator — both actions block the Preferences window
  synchronously while running (`tar`, PBKDF2, AES all run on the main
  thread; GJS has no worker threads).
- `.gwct` export always includes every discovered widget — no per-widget
  picker yet.
- No password-confirmation field when creating a backup (a typo just
  locks you out with no warning).
- The AES/PBKDF2 implementation is verified against test vectors and
  cross-checked against Node's own crypto, but has not had independent
  security review the way a vetted library has.
