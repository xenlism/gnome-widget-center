# Handoff — 2026-07-19 real-hardware bug-fix session

Scope: 5 real-hardware Edit Mode bugs reported by the user (screenshot +
list), all in `widgetEditMode.js` / `prefs.js`. None of these needed new
features — all were bugs in code that a previous session believed was
already working (see `handoff.md`'s "not yet verified on real hardware"
caveat — this is that verification).

## 1. Right-click didn't flip back to Widget Mode

Root cause: only the FRONT actor had a right-click listener. Once
flipped into EDIT, the front actor is `reactive = false` and hidden (by
design, so widget content can't be clicked through), so nothing was
listening for the right-click meant to flip it back — only ESC worked.

Fix: `widgetEditMode.js` `_buildBackActor()` now also wires a
right-click (`BUTTON_SECONDARY`) listener directly onto `back`, calling
the same `toggle()`. St.Button only consumes PRIMARY presses for its own
click handling, so this still fires even when right-clicking directly
over one of the icons.

## 2. Icon tooltip rendered inline instead of floating over

Root cause: `_attachTooltip()` inserted the tooltip `St.Label` directly
into the icon row's `St.BoxLayout` (`back.insert_child_above(tooltipLabel,
button)`, back then WAS the box layout). A BoxLayout lays out EVERY
child it's given, tooltip included — so on hover the label became a real
extra column in the row (with its own dark background), pushing every
button after it sideways, instead of floating above them. This is
exactly the extra dark "Settings" box visible in the user's screenshot.

Fix: `back` is now a plain `St.Widget` with `Clutter.BinLayout` (children
positioned purely by `set_position()`), holding a separate, content-sized
`iconRow` (the actual `St.BoxLayout`) centered inside it. The tooltip
label is parented into `back` (a sibling of `iconRow`, not a participant
in its layout) and manually positioned above the button using
`iconRow`'s position + the button's position — a true floating overlay.

## 3. Clicking Settings/Reset/Remove did nothing

Root cause: same bug as #2. Every button had `x_expand: true` filling
100% of the row's width; when the (buggy) tooltip appeared as an extra
box-layout child, the whole row reflowed and every button after it
shifted sideways out from under the pointer. A click on the "moved"
target's old position landed on now-empty backdrop, which (per #4's
drag handler) started a drag instead of registering a click — so it
looked like the icon "did nothing."

Fix: same as #2 (tooltip no longer participates in box layout, so the
row never reflows), plus buttons no longer `x_expand` — the row is
exactly as wide as its content and never moves after being built.

## 4. Not draggable

Root cause: the draggable "empty space" was only the row's own
6px spacing / a few pixels of padding around 3-4 full-width-expanding
buttons — in practice there was barely a pixel of real empty space to
grab, especially once bug #2/#3's reflow was also eating into it.

Fix: `back` (the whole card, reactive and armed for drag/right-click) is
now a full-size `St.Widget`, with the icon row centered inside it at its
own natural (small) content size. Everywhere on the card OUTSIDE that
small centered row is real, generous, always-in-the-same-place empty
space — reliably grabbable for a drag no matter how many icons a widget
has.

## 5. Widget Settings had no Save/Close

Root cause: every settings row (`settingsSchemaUI.js` and hand-written
`prefs.js` widgets) already writes straight to disk on change
(`WidgetSettings`'s ~300ms debounced auto-save) — by design there was
never a separate "Save" step, and closing relied entirely on the Control
Center window's own title-bar chrome, which isn't obvious/visible
enough on its own.

Fix: `prefs.js` now routes every settings subpage (both the
auto-generated schema page and a widget's own hand-written
`buildPrefsWidget()`) through a new `_presentPrefsPage()` that appends an
explicit action bar: "Close" (navigates back, `window.close_subpage()`)
and "Save & Close" (`WidgetSettings.flush()` — writes any pending change
immediately instead of waiting out the debounce — then closes).

## Files touched this session

```
products/extension/lib/widgetEditMode.js  (edited)
products/extension/stylesheet.css         (edited)
products/extension/prefs.js               (edited)
```

## Verification done

- `node --check` passed on every `.js` file touched.
- **Not verified on real GNOME Shell hardware** — same caveat as every
  prior session. Please re-test all 5 items on real hardware before
  calling this closed.
