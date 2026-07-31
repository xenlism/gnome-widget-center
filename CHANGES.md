# Summary of all changes across this project

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
