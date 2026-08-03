# Geek Clock Date Bar

Wide `barx3` card (35×5 grid cells) with two centered lines:

```
           14:30

        12-02-2026
```

## Settings

- **Clock text** — font face/size (`clockFont`) and color (`clockColor`)
  for the big clock line, plus **24-hour format** (`clock24Hour`, switch —
  off shows 12-hour with AM/PM) and **show seconds** (`clockShowSeconds`,
  switch).
- **Date text** — **show date line** (`dateTextEnabled`, switch — hides
  the whole line, not just the text, so it doesn't reserve empty space),
  font face/size (`dateFont`) and color (`dateColor`), plus **date
  format** (`dateFormat`: `auto`, `mm-dd-yyyy`, or `dd-mm-yyyy` — auto
  picks month-first or day-first based on your system's country/locale).
- **Layout** — horizontal text alignment (`textAlign`): `left`, `center`
  (default), or `right`.
- **Card** — background color (`backgroundColor`, transparency supported
  via an 8-digit hex or alpha color picker) and corner radius
  (`cornerRadius`).
- **Text Shadow** — optional shadow drawn under the clock/date text itself
  (color, opacity, angle, distance, blur).
- **Widget Shadow** — optional drop shadow behind the whole card (color,
  opacity, angle, distance, blur) — same mechanism every other bundled
  card widget uses.

The clock re-renders every second while seconds are shown, and every 30
seconds otherwise (just enough to catch the minute/date rollover).
