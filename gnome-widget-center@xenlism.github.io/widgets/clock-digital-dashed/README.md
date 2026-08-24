# clock-digital-dashed

Digital-only clock card (1x1) - a big HH:MM readout with a ring of
short dash marks near the card's edge. No hands, no analog face, no
numerals. See `clock-analog-classic` / `clock-analog-minimal` for the
analog siblings.

Drawn each tick in a single `St.DrawingArea` (`_onRepaint()`), same
Cairo-drawing pattern as `circles-clock`.

## Settings (config.json)

- **Card**: `backgroundColor`, `cornerRadius`.
- **Dash ring**: `showDashes`, `dashColor` (HH/MM line color),
  `dashCount` (how many dashes make up the ring).
- **Digits**: `format24h`, `digitFont`, `digitColor`.
- **Behavior**: `refreshRateSeconds` (default 5s - no second hand to
  animate, so a faster refresh buys nothing), `launchAppPath`.

## Notes

- The dash ring is drawn as `dashCount` separate short radial line
  segments, not one stroked circle with a Cairo dash pattern - that's
  what gives the gapped "ring of ticks" look in the reference image
  rather than a continuous dashed circle.
- Digits are drawn with Cairo's toy text API
  (`selectFontFace`/`showText`); `_splitFamilyAndWeight()` strips
  "Bold"/"Italic"/etc. out of the Pango-style font string before
  handing the family to Cairo, mapping "Bold" to
  `Cairo.FontWeight.BOLD` instead.
