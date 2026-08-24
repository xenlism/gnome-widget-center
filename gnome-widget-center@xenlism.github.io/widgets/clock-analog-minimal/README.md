# clock-analog-minimal

Minimalist round analog clock (1x1) - hour/minute/second hands and
tick marks only, no numerals, no digital readout. See
`clock-analog-classic` for the numeral-face sibling and
`clock-digital-dashed` for the digital-only sibling.

Drawn each tick in a single `St.DrawingArea` (`_onRepaint()`), same
Cairo-drawing pattern as `circles-clock`.

## Settings (config.json)

- **Card**: `backgroundColor`, `cornerRadius` - the square card behind
  the round dial.
- **Face**: `faceColor` (clock circle color).
- **Tick marks**: `showMinuteTicks`, `tickColor` (HH/MM line color -
  shared by both hour and minute ticks).
- **Hands**: `hourHandColor`, `minuteHandColor`, `showSecondHand`,
  `secondHandColor`.
- **Behavior**: `refreshRateSeconds`, `launchAppPath`.

## Notes

- Hand angles are computed from `GLib.DateTime` each tick
  (`refreshRateSeconds`, default 1s).
