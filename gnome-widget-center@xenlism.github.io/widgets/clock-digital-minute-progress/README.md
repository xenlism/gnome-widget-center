# clock-digital-minute-progress

Digital-only clock card (1x1) - a big HH:MM readout with a ring of
short dash marks near the card's edge, same look as
`clock-digital-dashed`, but the ring doubles as a minute-progress
indicator: dashes for minutes already reached this hour (including the
current minute) paint in a dark color, dashes for minutes still to come
paint in a light color. No hands, no analog face, no numerals, no
circle outline.

Drawn each tick in a single `St.DrawingArea` (`_onRepaint()`), same
Cairo-drawing pattern as `clock-digital-dashed` / `circles-clock`.

## Settings (config.json)

- **Card**: `backgroundColor`, `cornerRadius`.
- **Minute progress ring**: `showDashes`, `dashCount` (how many dashes
  make up the ring - 60 gives one dash per minute), `dashColorElapsed`
  (dark - minutes already reached), `dashColorRemaining` (light -
  minutes not reached yet).
- **Digits**: `format24h`, `digitFont`, `digitColor`.
- **Behavior**: `refreshRateSeconds` (default 5s), `launchAppPath`.

## Notes

- The dash ring is drawn as `dashCount` separate short radial line
  segments, not one stroked circle with a Cairo dash pattern - that's
  what gives the gapped "ring of ticks" look rather than a continuous
  dashed circle.
- Each dash represents a `60 / dashCount`-minute slice of the current
  hour (`minuteForDash = floor(i * 60 / dashCount)`). A dash is
  "elapsed" (dark) when its slice's start minute is `<=` the current
  minute, otherwise it's "remaining" (light). With the default
  `dashCount: 60` this is exactly one dash per minute.
- Digits are drawn with Cairo's toy text API
  (`selectFontFace`/`showText`); `_splitFamilyAndWeight()` strips
  "Bold"/"Italic"/etc. out of the Pango-style font string before
  handing the family to Cairo, mapping "Bold" to
  `Cairo.FontWeight.BOLD` instead.
