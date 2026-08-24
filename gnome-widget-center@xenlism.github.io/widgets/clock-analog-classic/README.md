# clock-analog-classic

Classic round analog clock (1x1) - hour/minute/second hands, all 12
numerals around the dial, hour and minute tick marks. No digital
readout - see `clock-digital-dashed` for a pure-digital sibling and
`clock-analog-minimal` for a numeral-free face.

Drawn each tick in a single `St.DrawingArea` (`_onRepaint()`), same
Cairo-drawing pattern as `circles-clock`.

## Settings (config.json)

- **Card**: `backgroundColor`, `cornerRadius` - the square card behind
  the round dial.
- **Face**: `faceColor` (clock circle color), `numberFont`,
  `numberColor` (clock text color) - numerals are always shown, 1-12.
- **Tick marks**: `showMinuteTicks`, `tickColor` (HH/MM line color -
  shared by both hour and minute ticks).
- **Hands**: `hourHandColor`, `minuteHandColor`, `showSecondHand`,
  `secondHandColor`.
- **Behavior**: `refreshRateSeconds`, `launchAppPath`.

## Notes

- Numerals are drawn with Cairo's toy text API
  (`selectFontFace`/`showText`). `_splitFamilyAndWeight()` strips
  "Bold"/"Italic"/etc. out of the Pango-style font string before
  handing the family to Cairo, mapping "Bold" to
  `Cairo.FontWeight.BOLD` instead - passing a raw string like "Sans
  Bold" straight to `selectFontFace()` is not reliable across
  fontconfig setups.
- Hand angles are computed from `GLib.DateTime` each tick
  (`refreshRateSeconds`, default 1s).
