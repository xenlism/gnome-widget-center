# Handover — themeable-widget render race + double-card metadata regression

Continues `HANDOVER_2026-08-11-circles-force-settings-fix.md`. User reported
three symptoms this session, all traced to two separate root causes. Neither
is Force-Settings-specific — both also affect the plain theme-pack path.

## Bug A — `themeable: true` widgets fight ThemeService over `entry.actor`'s
   style, causing Force Settings to revert, labels to shift, and (for a
   subset) visible double borders/backgrounds

**Symptoms reported:** "force setting on themeable=false is work perfectly
but forcesetting with themeable=true have bug"; "geek- date clock week move
when force setting maybe because it not clip".

**Root cause:** `extension.js` calls `ThemeService.applyWidgetStyle(entry.actor,
entry.id)` for every `themeable: true` widget at placement time and on
`_reapplyTheme()`. But 34 widgets *also* call
`this._actor.set_style(_cardStyleCss(this._settings, {...}) + "padding: ...;")`
directly from their own `_render()` — on a settings-changed callback, on
`enable()`, and (critically) on a periodic `GLib.timeout_add`/`timeout_add_seconds`
tick (clock/date refresh, stat refresh, etc.).

`St.Widget.set_style()` **replaces the whole inline style string, it does not
merge**. So whichever of the two callers ran most recently "wins" and the
other's CSS is silently discarded — there's no actual simultaneous double
paint, it's two independent owners overwriting the same property. Concretely:

- Right after load: `buildActor()` → widget's own `_render()` (own CSS) →
  `enable()` → own `_render()` again → then `_placeEntry()` →
  `ThemeService.applyWidgetStyle()` (theme-pack/Force CSS) last. Looks correct
  at boot.
- One tick later (e.g. `geek-date-week-bar`'s 60s clock refresh,
  `cpu-monitor`/`mem-monitor`/`system-monitor`/`network-monitor`'s stat
  refresh, any widget's `onSettingsChanged()`), the widget's own `_render()`
  fires again and overwrites `entry.actor`'s style with
  `_cardStyleCss(this._settings, {...})` — computed from the widget's *own*
  local settings, not from `ThemeService.getEffectiveWidgetTheme()`. Any
  Force Settings / theme-pack override that was showing reverts to (or
  flickers against) the widget's own local appearance config.
- `ThemeService.applyWidgetStyle()` has an explicit `box-sizing: border-box;`
  line (comment: `// เพิ่มบรรทัดนี้เพื่อแก้ปัญหา Label ขยับเมื่อใช้ Force
  corner-radius`) added specifically to stop labels shifting when a forced
  corner-radius/border changes the actor's box model. `cardStyleCss()` (the
  widget-local helper) never had that fix. So every periodic
  self-render on a `themeable` widget silently drops `box-sizing: border-box`
  again — that's the "geek date/clock/week moves" report.

**Fix (3 files + 34 widgets):**

1. `lib/themeService.js` — split `applyWidgetStyle(actor, widgetId)` into a
   pure `computeWidgetStyleCss(widgetId)` (returns the CSS string, no actor,
   no side effects) plus a thin `applyWidgetStyle()` that just calls
   `actor.set_style(this.computeWidgetStyleCss(widgetId))`. Same output as
   before, just reusable.
2. `lib/widgetLoader.js` — `WidgetLoader` constructor now accepts an optional
   6th arg `themeService`; `extension.js` passes `this._themeService` when
   constructing the runtime loader (`lib/prefsWidgetList.js`'s loader doesn't
   need it — prefs never render widget actors). `_buildApi()` now exposes
   `api.resolveCardCss()` — returns `this._themeService.computeWidgetStyleCss(id)`
   when the widget is `themeable` and a `ThemeService` was supplied, else
   `null`.
3. **34 widget files** — every `this._actor.set_style(_cardStyleCss(this._settings,
   {...}) + <padding/spacing suffix>)` call site now wraps just the
   `_cardStyleCss(...)` call: `(this._api.resolveCardCss?.() ?? _cardStyleCss(...))`,
   leaving the appended padding/spacing suffix untouched and unconditional.
   Themeable widgets now always defer card CSS (background, corner-radius,
   border, shadow, blur, `box-sizing: border-box`) to `ThemeService`, on
   every render including periodic ticks — non-themeable widgets are
   byte-for-byte unchanged (the `?? _cardStyleCss(...)` fallback is exactly
   their old code path).

   Files touched: `calendar-modern`, `circles-cpu-half`, `circles-disk-half`,
   `circles-mem-half`, `circles-net`, `circles-net-half`,
   `circles-system-nested`, `clock-modern`, `cpu-monitor`,
   `geek-archey-systech-bay`, `geek-archey-systech-squre`,
   `geek-clock-date-bar`, `geek-clock-date-bay`, `geek-clock-date-big`,
   `geek-date-stat-bar`, `geek-date-stat-big`, `geek-date-week-bar`,
   `geek-date-week-bay`, `geek-date-week-big`, `geek-week-date-bar`,
   `geek-week-date-bay`, `geek-week-date-big`, `geek-week-stat-bar`,
   `geek-week-stat-bay`, `geek-week-stat-big`, `media-player-circle`,
   `media-player-poster`, `media-player-square`, `media-player-wide`,
   `mem-monitor`, `network-monitor`, `system-monitor`, `weather-dark`,
   `weather-minimal`, `weather-modern`.

   `weather-dark` needed the same treatment inside its existing
   `_deferUntilMapped(this._actor, () => ...)` wrapper — confirmed the
   surgical rewrite found and wrapped that call site too (it uses the same
   `_cardStyleCss(` call shape, just inside an arrow function).

   Note: `power-menu-bar`, `settings-control-bar`, and `switches` also
   matched the initial `_cardStyleCss(` scan, but their calls style
   `this._content` (an inner child), not `this._actor` — the surgical
   rewrite correctly skipped them (lookback check for
   `this._actor.set_style(`). Turned out these needed a different fix — see
   Bug B.

## Bug B — 11 widgets shipped `themeable: true` while painting their own
   bespoke background onto an inner `this._content` actor, producing a
   literal double border/double background with nothing forced

**Symptom reported:** "another widget some widget have two border and have
two background border effective without enable force settings or enable
global".

**Root cause:** `HANDOVER_2026-08-10-force-settings-gap.md` (item #1) and
`HANDOVER_2026-08-11-circles-force-settings-fix.md` both document that
`power-menu`, `power-menu-bar`, `settings-control`, `settings-control-bar`
paint their real, visible card onto `this._content` — a child of
`entry.actor` — with their own settings-driven border/background/shadow
logic, and that the *previous* session **explicitly rejected** marking them
`themeable: true` for exactly this reason:

> "Marking these 4 themeable: true was rejected as the fix: that would also
> route them through `ThemeService.applyWidgetStyle(entry.actor, ...)`,
> which paints the shared theme-pack background onto `entry.actor` (the
> root) — but these widgets already paint their own bespoke background onto
> an inner `this._content` actor, so it'd draw a second, misaligned
> background behind the real one."

That session's actual fix was `forceSettingsAware: true` (a narrower opt-in
that only affects Force Opacity/Blur on the root, not `applyWidgetStyle`).
But in the metadata.json shipped this session, all 4 had **both**
`forceSettingsAware: true` **and** `themeable: true` — the exact combination
that was rejected. `entry.actor` (root) got a theme-pack
background/corner-radius/border painted on it by `ThemeService.applyWidgetStyle()`,
while `this._content` (child, same footprint) painted its own separate
background/border on top — two nested boxes, each with a border, always
visible, independent of Force Settings or global theme state entirely
(purely a `themeable` metadata bug, not a runtime race like Bug A).

Grepping for the same shape (`themeable: true` + a widget that only ever
calls `set_style()` with card CSS on `this._content`, never on
`this._actor`) turned up **7 more widgets** with the identical bug, not
previously flagged in any handover: `launcher-big-1`, `launcher-big-2`,
`launcher-folder-big`, `launcher-folder-square-1`, `launcher-square-1`,
`launcher-square-2`, `switches`.

**Fix:** `metadata.json` for all 11 — `"themeable": false`,
`"forceSettingsAware": true` (the launcher family and `switches` didn't have
`forceSettingsAware` set at all before, so they's a genuinely new opt-in,
not a revert — previously they had *no* Force Opacity/Blur support and no
double-card bug either, since `themeable` used to presumably be `false` for
them before whatever changed it; can't confirm the prior value since there's
no earlier handover mentioning these 7, but `themeable: false +
forceSettingsAware: true` is definitely the correct end state given their
`this._content`-only painting architecture).

Widgets fixed: `power-menu`, `power-menu-bar`, `settings-control`,
`settings-control-bar`, `launcher-big-1`, `launcher-big-2`,
`launcher-folder-big`, `launcher-folder-square-1`, `launcher-square-1`,
`launcher-square-2`, `switches`.

## Validation

- `node --check` on every `.js` file in the repo (not just touched ones) —
  all pass.
- `python3 -m json.tool` (via `json.load`) on every touched `metadata.json`
  — all valid.
- Re-ran the "themeable + content-only card styling" grep after the metadata
  fix — zero remaining matches.
- Cross-checked that none of the 34 `resolveCardCss`-wrapped widgets from
  Bug A overlap with the 11 `themeable: false` widgets from Bug B (they
  don't — Bug A's rewrite only touched `this._actor.set_style(...)` call
  sites, which the Bug B widgets never had).
- No live GNOME Shell runtime testing done (same caveat as every prior
  session — worth prioritizing actually loading this in a nested Shell or
  on the real session next time given how much has now shipped on
  `node --check` alone).

## Still open

- Item #3 from `HANDOVER_2026-08-10-force-settings-gap.md` ("bake current
  settings into config.json defaults" dev tool) — still not wired in.
- Given Bug B was a *silent* metadata regression between sessions (the
  previous session's own documented decision got reverted somehow), it'd be
  worth double-checking the other `forceSettingsAware: true` widgets don't
  have the same `themeable` flip next time either — there's no automated
  check preventing "bespoke self-painted card" + "themeable: true" from
  recurring. A cheap guard: a small script (or a `node --check`-adjacent
  lint step) that flags any widget whose `widget.js` calls
  `this._content.set_style()` with card-shaped CSS while its `metadata.json`
  has `themeable: true` and never touches `this._actor`'s style directly.
