# Handover — item #2 from the previous handover, actually closed now

Continues `HANDOVER_2026-08-10-force-settings-gap.md`. That session's item #2
("Force Settings' opacity/blur override widgets with themeable=false") was
fixed in `extension.js`'s `_applyCardEffects()` (the `ignoreForce` computed
from `entry.metadata?.["themeable"]`, passed to `applyCardOpacity`/
`applyCardBlur`) — but that fix only covers widgets going through the normal
`_applyCardEffects()` path. It doesn't cover widgets that opted out of that
path via `createLayeredCard()`.

## The gap that was left

`_applyCardEffects(entry)` in `extension.js` has this at the top:

```js
if (entry.instance?._layers) return;
```

Any widget using `createLayeredCard()` (the `circles-*` family — battery,
battery-half, clock, cpu, disk, mem, system, year) sets `this._layers` in
`buildActor()`, so it's skipped here entirely. Instead, these widgets style
their own `_layers.background` directly by calling
`applyLayeredCardStyle(this._layers, this._settings, {...})` from
`lib/cardLayers.js`. That function internally called:

```js
applyCardBlur(layers.background, settings);      // ignoreForce defaulted to false
applyCardOpacity(layers.background, settings);   // same
```

No `ignoreForce` was ever passed through, and there was no way for it to be —
`applyLayeredCardStyle()` didn't accept the parameter, and the widget's own
`api` object (built in `WidgetLoader._buildApi()`) never exposed the widget's
own `themeable` flag from its `metadata.json` in the first place. So Force
Settings' global opacity/blur always won for every `circles-*` widget,
including the ones with `"themeable": false` explicitly set
(`circles-battery-half`, `circles-cpu-half`, etc. — though note the `-half`
variants don't all use `createLayeredCard()`; only the full-circle ones do,
see below) and the ones where the key is simply absent (same falsy result).

## Fix applied (3 files)

1. **`lib/cardLayers.js`** — `applyLayeredCardStyle()` now takes a 4th param
   `ignoreForce = false` and forwards it to both `applyCardBlur()` and
   `applyCardOpacity()` instead of calling them with just 2 args.

2. **`lib/widgetLoader.js`** — `_buildApi()` now sets
   `themeable: !!widgetInfo.metadata?.["themeable"]` on the api object handed
   to every widget's constructor. This mirrors the same gate `extension.js`
   already uses, so widgets that manage their own card styling have a single
   consistent source of truth instead of re-deriving it.

3. **8 widget files** — every `circles-*/widget.js` that calls
   `applyLayeredCardStyle()` now passes `!this._api.themeable` as the 4th
   arg:
   - `circles-battery-half/widget.js`
   - `circles-battery/widget.js`
   - `circles-clock/widget.js`
   - `circles-cpu/widget.js`
   - `circles-disk/widget.js`
   - `circles-mem/widget.js`
   - `circles-system/widget.js`
   - `circles-year/widget.js`

Confirmed via grep that these 8 are the only `applyLayeredCardStyle()` call
sites in the codebase, and all 8 have the identical call shape (same two
options keys, `backgroundColorFallback`/`cornerRadiusFallback`), so the same
mechanical edit applies to all of them.

Note: the `-half` variants that *don't* use `createLayeredCard()`
(`circles-cpu-half`, `circles-disk-half`, `circles-mem-half`,
`circles-net-half`) weren't touched — they never had this bug, they go
through the normal `_applyCardEffects()` path in `extension.js` which was
already fixed last session.

## Validation

`node --check` on all 10 touched files — passes. No live GNOME Shell runtime
testing done (same caveat as every prior session).

## Also fixed this session: launcher-big/-square/-folder + power-menu* +
   settings-control* spamming `st_widget_get_theme_node ... not in the
   stage` on startup

Not a Force Settings bug — a separate layout bug the user hit in
`journalctl --user -f -o cat /usr/bin/gnome-shell`. All 9 of these widgets
had an identical, fully redundant block in `buildActor()`:

```js
const syncContentSize = () => {
    this._content.set_position(0, 0);
    this._content.set_size(this._actor.width, this._actor.height);
};
this._actor.connect("notify::width", syncContentSize);
this._actor.connect("notify::height", syncContentSize);
syncContentSize();
```

Reading `this._actor.width`/`.height` (property getters, not the `set_size`
call itself) forces St to resolve a preferred-size, which requires a theme
node. The very first call happens synchronously inside `buildActor()`,
before the actor is ever added to the widget layer/stage — hence "not in
the stage". `BlockSizeManager.applyBlockSize()`'s own `set_size()` call in
`_placeEntry()` (also pre-stage) re-triggers the same thing via the
`notify::width`/`notify::height` listeners, so it fired repeatedly per
widget instance at startup.

The fix removes it entirely rather than gating it: the
`Clutter.BindConstraint({source: this._actor, coordinate: SIZE})` sitting
right above it in every one of these widgets already keeps content's size
in sync with the root purely through Clutter's native allocation cycle - no
JS property reads, no theme-node resolution, safe unmapped or not. Position
is a constant `(0, 0)` (FixedLayout doesn't auto-position children like
BinLayout does), so that one call stays, just no longer inside a
width/height-triggered closure. The `switches` widget already does exactly
this (BindConstraint only, no manual sync) and was never affected — used it
as the reference.

Files touched: `launcher-big-1`, `launcher-big-2`, `launcher-square-1`,
`launcher-square-2`, `launcher-folder-square-big`, `power-menu`,
`power-menu-bar`, `settings-control`, `settings-control-bar` — all
`widget.js`. `node --check` passes on all 9.

## Also fixed this session: power-menu/power-menu-bar/settings-control/
   settings-control-bar now honor Force Opacity and Force Blur

Closes the rest of the previous handover's item #1. Turned out to be less
than it looked: background-color, corner-radius, border, and CSS blur
(`-st-background-blur` via `blurCss()`) were *already* Force Settings-aware
for these 4 widgets — an earlier session had routed their `_cardStyle()`
through `cardStyleCss()`, which resolves `ForceSettingsHelper` unconditionally
with no themeable gate at all (see the `_cardStyle()` comments already in
`power-menu/widget.js`/`settings-control/widget.js`).

What was still missing: Force **Opacity** and the effect-based Force
**Blur** (`Shell.BlurEffect`, applied to `entry.actor` centrally by
`extension.js`'s `_applyCardEffects()`) never reached these 4, because
`ignoreForce` there was computed purely from `themeable`, and none of these
4 are themeable — same `ignoreForce` gate this session's circles-widget fix
relies on to keep Force Settings *off* the circles family. Marking these 4
`themeable: true` was rejected as the fix: that would also route them
through `ThemeService.applyWidgetStyle(entry.actor, ...)`, which paints the
shared theme-pack background onto `entry.actor` (the root) — but these
widgets already paint their own bespoke background onto an inner
`this._content` actor, so it'd draw a second, misaligned background behind
the real one.

Confirmed with the user this was in fact wanted (opacity+blur should be
force-aware, not exempt like circles), so the fix adds a second, narrower
opt-in instead of reusing `themeable`:

1. **`extension.js`** — `_applyCardEffects()`'s `ignoreForce` is now
   `!(entry.metadata?.["themeable"] || entry.metadata?.["forceSettingsAware"])`.
   `forceSettingsAware: true` only affects this ignoreForce gate (Force
   Opacity/Blur on `entry.actor`) — it does *not* touch the
   `applyWidgetStyle()`/`themeable` gate a few lines away in
   `_placeEntry()`/`_reapplyTheme()`, so these widgets keep their own
   bespoke background/corner-radius rendering exactly as before.
2. **`metadata.json`** for `power-menu`, `power-menu-bar`,
   `settings-control`, `settings-control-bar` — added
   `"forceSettingsAware": true`.

All 4 `metadata.json` files validate as JSON; `extension.js` passes
`node --check`.

## Still open from the previous handover

Item #3 (bake-current-settings-into-config.json dev tool, in progress) is
untouched — see `HANDOVER_2026-08-10-force-settings-gap.md` for full detail.
