# Audit addendum — 2026-08-10 session, re-reviewed same day

Static re-review of HANDOVER_2026-08-10.md's item 1 ("Theme apply —
position not loading") turned up a real regression in that same fix,
now patched. Items 2–6 were re-checked and are fine as shipped; no
changes made to them.

## Item 1 fix had a gap: theme-applied widgets lost interactivity

`extension.js`'s `_applyActiveThemePack()` (the new method item 1 adds)
unloaded every running widget via:

```js
for (const loadedEntry of this._loader.instances)
    this._layer.removeWidgetActor(loadedEntry.id);
this._loader.unloadAll();
```

— skipping the per-widget `devWatcher.unwatchWidget()` /
`drag.detach()` / `editDrag.detach()` / `editMode.detach()` calls that
`_applyDisabledWidgets()`, right above it in the same file, already
does before its own `removeWidgetActor()`/`unloadOne()`.

That matters because `DragController.attach()`,
`EditModeDragController.attach()`, `WidgetEditMode.attach()`, and
`DevWatcher`'s watch call are all **idempotent-skip by widget id** —
each checks its own tracking map/set and does nothing if that id is
already present, on the assumption "already attached, nothing to do."
`unloadAll()` destroys the actors but the entries in those four maps
are never removed, so when `loadAll()` + `_placeEntry()` re-attach the
freshly reloaded widgets a moment later, every one of those four calls
is silently swallowed against the stale entry (which still points at
the now-`destroy()`ed old actor).

Net effect before this fix: applying a theme pack correctly repositions
widgets (item 1's stated goal) but **every widget it touches loses
Super+drag, right-click edit mode, edit-mode drag, and dev-mode
hot-reload watching**, with no error and no visual sign anything is
wrong — until the whole extension is disabled/re-enabled. Secondary,
milder effect: the stale map entries hold references to destroyed
`Clutter.Actor`s, so a later `detach()` on the same id (e.g. at
`disable()`) runs `entry.actor.disconnect(pressId)` against a disposed
actor — likely just a console warning, not fatal, but dead state
sitting in four different trackers after every theme switch.

**Fix**: `_applyActiveThemePack()`'s document branch now runs the same
four detach calls `_applyDisabledWidgets()` uses, per widget, before
`removeWidgetActor()`/`unloadAll()`. `node --check extension.js` clean.

## Items 2–6: re-checked, no issues found

- **Item 2** (Apply→switch): both switch handlers write/clear
  `active-theme-pack` correctly; the prefs-side guard against a
  re-render's own `.active = ...` assignment being mistaken for a user
  click reads correctly.
- **Item 3** (export validation): `EMAIL_PATTERN`/`URL_PATTERN` are
  reasonable permissive checks, wired to both live feedback and a hard
  gate on Export; one bad value blocks with `showReportDialog()` as
  documented.
- **Item 4** (screenshot ratio): 370:160 ≈ 2.3125:1; 456 / 2.3125 ≈
  197.2, so 197px checks out arithmetically against the stated
  Preferences card ratio.
- **Items 5 & 6**: no code changes to verify — confirmed-correct /
  carried-through as the original handover states.

## Still not done (unchanged from the original handover)

No runtime test against a real GNOME Shell session for any of this —
same caveat as before, now also covering this addendum's own fix.
Re-check in particular: after applying a theme pack, that a widget
it repositions can still be Super-dragged and right-click edited
without a shell restart.

## Addendum 2 — real-device test log surfaced a second screenshot bug

Runtime log from a real GNOME Shell session confirmed items 1/2/3/5 look
healthy (theme load, edit-mode attach/detach cycling correctly across
overlay open/close, no crashes). One thing the log couldn't show but a
follow-up screenshot did: **the overlay's screenshot box was stretching
real screenshots, not just cropping them to a slightly-off ratio.**

Root cause: `_buildScreenshot()` set `background-size: 456px 197px`
unconditionally - i.e. the box's own fixed dimensions - regardless of
the source image's actual aspect ratio. That's fine only when the
source happens to already be ~2.315:1. A real screenshot (960x320, 3:1)
has a different ratio, so it was stretched non-uniformly to fill the
box - unlike the Preferences window's own equivalent banner, which uses
real `Gtk.ContentFit.COVER` and therefore crops (never distorts)
regardless of source ratio.

**Fix**: added `_coverBackgroundStyle()` to
`lib/widgetCenterOverlay.js` - reads the source image's real pixel
dimensions via `GdkPixbuf.Pixbuf.get_file_info()` (header-only, no full
decode), scales up (never down) by whichever axis needs more growth to
fully cover the 456x197 box, and centers the overflow with a negative
`background-position` offset - manually replicating CSS
`background-size: cover; background-position: center`, which St's CSS
parser doesn't support as keywords (existing comment in the file
already noted this limitation, which is why the code had hardcoded
pixel dimensions in the first place - it just never accounted for the
source image's own ratio). Falls back to the old stretched-fit behavior
only if the image's dimensions can't be read at all.

Verified the math directly (Node, no Shell needed) against the reported
960x320 case plus three others (exact-ratio, portrait, and a small
square that needs upscaling) - all four crop correctly with no
distortion. `node --check lib/widgetCenterOverlay.js` clean.

Still needs an actual on-screen look against a real screenshot file to
confirm the crop reads well (not just correct arithmetic) - didn't
change item 5's own outstanding verification.
