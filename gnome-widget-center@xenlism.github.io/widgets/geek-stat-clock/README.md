# Geek Stat Clock (Architect)

An Architect Widget (see `lib/architectWidgetKit.js` / development docs:
XTile Architecture) for the "Geek" series. A themeable, 3-line card
where each line independently shows a **Clock**, a **Long date**, a
**Short date**, or a **System stat** (CPU/MEM/DISK/NET) readout.

## Why Architect, not a plain widget

The old `geek-week-stat-big`/`geek-week-stat-bay` pair is 2 fixed lines
(weekday + CPU/MEM/DISK) hardcoded to one block size each, duplicated
almost verbatim between the two files. This widget generalizes that:
3 independently-sourced lines, `themeable:true` (full card style comes
free from the host's ThemeService instead of being hand-rolled), and a
**+ Add Widget** button that spawns as many differently-sized,
differently-configured Children as you want from one Parent - no new
code per size or per line combination, ever.

## Using it

1. Drop the Parent card ("Geek Stat Clock (Architect)") anywhere.
2. Click **+ Add Widget**, give the Child a name, pick a size (Bar (2),
   Bar (3), Big Bar (4), Card (3), Big Card (4)), click **Add**. Bar (2)
   starts with line 3 already turned off.
3. Open the new Child's own Settings page (Control Center) to choose
   each line's Source (Clock/Long date/Short date/System stat), font,
   color, and text-shadow (color/opacity/distance/blur only - see
   below), plus the shared clock/date formats. Lines 2 and 3 each have
   a **Show this line** switch (`line2Enabled`/`line3Enabled`) - line 1
   has no such switch and is always shown.
4. Repeat for as many Children as you like - a "CPU+time" bar, a
   "full date+stat" big card, a 2-line "time only" bar, etc.

## Formats

- **Clock**: `HH:MM:SS` or `HH:MM`, each in 24-hour or 12-hour (AM/PM).
- **Long date**: `DD MMM YYYY`, `MMM DD YYYY`, `DD MMMM YYYY`,
  `MMMM DD YYYY`.
- **Short date**: `DD-MM-YY`, `MM-DD-YY`, `DD-MMM-YY`, `MMM-DD-YY`.
- **System stat**: `CPU N%   MEM N%   DISK N%   NET ↓rate ↑rate` (the
  `NET` term is new versus the old geek-week-stat-* widgets).

## Why there's no per-line Shadow Angle field

Every shadow in this widget - each line's text shadow AND the card's
own drop shadow (themeable, so it comes from ThemeService) - always
follows the single global **Shadow Angle** in Settings > Appearance.
Distance/blur/color/opacity are still fully per-line; only the angle is
deliberately not exposed here, so every shadow on the desktop points
the same direction instead of 3 lines potentially fighting each other
(or the card) over "which way is down". See
`lib/widgetVisualKit.js`'s `textShadowCss()`/`shadowBoxShadowCss()` and
`lib/forceSettingsHelper.js`'s `getGlobalShadowDistanceAngle()`.

## Adding a size preset

Edit `BLOCK_TYPE_PRESETS` at the top of `widget.js` - each entry is
`{id, label, blockType, fontOverrides}`. `blockType` must be one of the
10 valid names in `lib/blockSizeManager.js` (`WIDGET_API.md` §2's
table). No other file needs to change; `child/config.json` already
carries the full field schema every preset's `fontOverrides` writes
into.
