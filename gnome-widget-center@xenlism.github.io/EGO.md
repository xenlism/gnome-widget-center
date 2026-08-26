# Reviewer notes — EGO-P-007 (files not reachable from extension.js / prefs.js)

The automated review flags several files as "not reachable" because it only follows
**static** `import` statements starting from `extension.js` and `prefs.js`. This
extension intentionally loads a number of files through **runtime dynamic
`import()`** calls, driven by data (a locale name, a widget's folder path) rather
than by a fixed import graph. Static analysis cannot trace that, which is why these
files show up as "unreachable" even though they are all shipped and used.

Below is the reason for each group.

## 1. Locale files — `i18n/en.js`, `i18n/de.js`, `i18n/es.js`, `i18n/ja.js`, `i18n/th.js`, `i18n/zh.js`

`i18n/index.js` (which *is* imported from `extension.js`/`prefs.js`) picks the
user's locale at runtime and loads only that one file:

```js
const filePath = GLib.build_filenamev([dirPath, `${locale}.js`]);
const module = await import(`file://${filePath}`);
```

Only one of the six files is ever loaded in a given session, and which one is
chosen depends on `GLib.get_language_names()` / the user's settings override, so
there is no fixed file to point a static `import` at. All six are real,
used translation files, not dead code.

## 2. Widget "kit" helper libraries

`lib/architectWidgetKit.js`, `lib/calendarGridKit.js`, `lib/halfCircleGaugeKit.js`,
`lib/iconAccentColor.js`, `lib/mediaApi.js`, `lib/systemCalendarEvents.js`,
`lib/systemMetricsApi.js`, `lib/utils.js`, `lib/widgetConfigDefaults.js`, and
`lib/widgetTooltip.js` form the small internal API surface that individual widgets
are built on.

Widgets themselves are not statically linked into the extension either: each
widget lives in its own folder under `widgets/<id>/` with its own `widget.js`, and
`lib/widgetLoader.js` loads that entry file dynamically based on the widget's
`metadata.json`:

```js
const entryPath = GLib.build_filenamev([widgetInfo.path, entry]);
const module = await import(`file://${entryPath}`);
```

Each `widgets/<id>/widget.js` then imports whichever of the kit files it needs
(e.g. `widgets/calendar-modern/widget.js` imports `calendarGridKit.js`,
`widgets/circles-cpu/widget.js` imports `systemMetricsApi.js`). Because the widget
files themselves are only reachable dynamically, the kit modules one level below
them are invisible to a static reachability check too — but every one of these
files is imported by at least one shipped widget.

## 3. `widget-center-prefs-app.js`

This file is not a module imported by `prefs.js` — it is a **separate,
self-executing GJS program** (`#!/usr/bin/gjs -m`) that provides a standalone
preferences window you can launch outside of `gnome-extensions prefs`. It is
started as its own process, not `import`-ed, from
`lib/shell/globalScreenshotKeybinding.js`, which spawns it via `Gio.Subprocess`/
`GLib.spawn` when the user triggers the "open prefs" action from the
screenshot-overlay keybinding. That is also why it declares its own
`Adw.Application` and `application_id` rather than reusing the in-process prefs
window controller.

## Why we're not restructuring this

Widgets, locales, and the standalone prefs launcher are plugin-style, path/data
driven components by design — that's what lets widgets be added, and locales
translated, without touching `extension.js`. Forcing them into static imports
would mean either eagerly loading every locale and every widget's dependencies on
every run (wasted memory/startup time, and loading GNOME Shell library code for
widgets the user hasn't enabled), or maintaining a manually-updated static import
list that duplicates what `metadata.json` and the locale folder already express.
We consider the current dynamic-loading architecture correct for this project and
have documented it here per the reviewer's request rather than changing it.

---

# Reviewer notes — EGO-A-001 (`lib/crypto/sha256.js` flagged as possibly obfuscated)

We renamed the incidental short names in this file (`x`, `n`, `h`, `w`, `i` →
`value`, `bits`, `state`, `schedule`, `index`) to bring the short-identifier
ratio down, and added a copyright/SPDX header. One set of names was
deliberately **left short**: the eight working variables `a, b, c, d, e, f, g, h`
used inside the compression-round loop. Below is why those specifically can't
be expanded to long descriptive names.

**They are the algorithm's own variable names, not ours.** FIPS 180-4 §6.2.2
defines the SHA-256 compression function using exactly these eight one-letter
names (`a` through `h`) for the working variables, and every widely used
reference implementation of SHA-256 (OpenSSL, the Node.js/Web Crypto internals,
Python's `hashlib` C source, countless textbook implementations) keeps that
same naming, because the code is a direct transcription of the spec's
pseudocode, round by round. Renaming them to something like
`temporaryStateA, temporaryStateB, ...` would not add information — the
letters already carry exactly the meaning the spec gives them — and would
actively make the code harder to review, because it could no longer be checked
line-by-line against the FIPS document a reader already has open.

**They also aren't 8 independent "concepts" — they're one array, rotating.**
Each round, the values simply shift down one slot (`h = g; g = f; f = e; ...`)
the way the spec describes it. Giving each slot a unique long name would
suggest they each mean something distinct, when the entire point of the
algorithm is that the same 8-word state rotates through the same 8 named
positions every round.

**Renaming them would risk introducing a real bug for a cosmetic reason.**
This function is a cryptographic primitive: an off-by-one or swapped
assignment among `a..h` silently produces wrong hashes rather than an error.
Touching all eight names throughout the round loop, purely to satisfy an
identifier-length heuristic, is exactly the kind of low-value, high-risk edit
we'd want a security-sensitive file to avoid.

We consider the file no longer obfuscated (compact ≠ obfuscated — the file has
no minification, no name-mangling, and now has a header comment plus expanded
names everywhere the names were actually arbitrary), and have documented the
one remaining deliberate exception here per the reviewer's request.
