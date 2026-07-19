# Handoff — 2026-07-19 Development Mode + debug logging session

Scope: user re-tested the 5 bugs from `handoff-2026-07-19-editmode-bugs.md`
on real hardware and reported 3 of them still happening (right-click
closes/removes the widget instead of toggling back, icon clicks do
nothing, can't drag in Edit Mode), plus asked for a "Development Mode"
option in Preferences that turns on debug logging, so the next session
can fix the right thing instead of guessing again.

## 1. New: `lib/logger.js`

`createLogger(settingsService)` returns `{debug, warn, error}`. `debug()`
is a no-op unless the `dev-mode` GSettings key is on — reused the
*existing* key (previously only wired to task 08's hot-reload watcher,
with no UI of its own) rather than adding a second one, since both are
"developer/bug-reporter only" toggles.

View output on real hardware:
```
journalctl -f -o cat | grep widget-center
journalctl -f -o cat | grep 'widget-center:edit-mode'   # narrower
journalctl -f -o cat | grep 'widget-center:edit-drag'
```

## 2. New: Preferences → Advanced page

`prefs.js` now has a second `Adw.PreferencesPage` ("Advanced") with a
"Development Mode" `Adw.SwitchRow`, live-bound to `dev-mode`. This key
existed before but had no UI — the user had no way to turn on hot-reload
or (now) debug logging without `gsettings set` by hand.

## 3. Instrumented the exact paths behind the 3 reported bugs

`widgetEditMode.js` and `editModeDragController.js` now log every
decision point on the way to right-click/toggle, back-side button
clicks, and drag-start — including *why* something was skipped (wrong
button, already dragging, `isEditing()` false, widget not attached).
`_buildBackActor()` also warns if it's ever built with a non-positive
front-actor size (would render invisibly — checked as a hypothesis for
bug #1, see below).

## 4. Found and fixed one real bug: `_flip()` listener leak

Root cause: `_flip()`'s `notify::rotation-angle-y` listener (the one
that swaps front/back visibility at the 90° mark) was kept in a bare
local variable, never tracked anywhere. If `toggle()` fired again (fast
double right-click, or any re-entry) before the in-flight flip's
listener had reached its own disconnect condition, the OLD listener
stayed connected — a second, stale listener then fought the new one over
`actor.visible` on every subsequent flip. Depending on firing order this
could leave the front actor stuck invisible with the back actor also not
properly shown, i.e. the widget appears to just vanish instead of
cleanly flipping — matches the reported "right-click closes/removes the
widget instead of toggling" symptom.

Fix: the listener id is now stored on the widget's own `entry`
(`entry.flipListenerId`), and any previous one is disconnected before a
new `_flip()` call connects another — at most one live per widget.
`detach()` also cleans it up.

**Not confirmed as the (or the only) root cause** — plausible from
reading the code, matches the symptom, but not verified against real
hardware in this session either. The debug logs added in this session
are the next tool to confirm it directly (or find the real cause if this
wasn't it).

## 5. Bugs #2 (icon clicks) and #3 (can't drag) — not changed

Read `widgetEditMode.js`'s button wiring and
`editModeDragController.js`'s `armBackActor()` press handler closely;
the logic looked correct (right-click/left-click gating, event
propagation order between the back actor's two `button-press-event`
listeners, `St.Button` consuming its own press events before they'd
reach `back`). No code change made here beyond the debug logging —
genuinely couldn't find a bug by reading, and didn't want to guess-fix
working code. **Please re-test with Development Mode ON and share the
`journalctl` output for a right-click → icon-click → drag attempt** —
the logs should show exactly which handler fires (or doesn't) at each
step.

## Files touched this session

```
products/extension/lib/logger.js                                    (new)
products/extension/lib/widgetEditMode.js                             (edited)
products/extension/lib/editModeDragController.js                     (edited)
products/extension/extension.js                                      (edited)
products/extension/prefs.js                                          (edited)
products/extension/schemas/org.gnome.shell.extensions.widget-center.gschema.xml (edited)
products/extension/schemas/gschemas.compiled                         (recompiled)
```

## Verification done

- `node --check` passed on every `.js` file touched.
- `glib-compile-schemas` re-ran cleanly on the schema directory (no
  key/type changes, only a description update — existing dconf values
  for `dev-mode`/`disabled-widgets` are unaffected).
- **Not verified on real GNOME Shell hardware** — same caveat as every
  prior session. This is exactly what Development Mode + these logs are
  for; please re-test bugs #1–#3 with it on.
