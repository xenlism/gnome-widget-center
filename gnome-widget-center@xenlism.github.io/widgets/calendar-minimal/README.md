# Calendar (Minimal)

A chromeless calendar widget for GNOME Widget Center - no card
background, no border, just typography. Shows only:

- Day number (dominant, e.g. `3`)
- Day of week (small subtitle, e.g. `TUESDAY`)
- Month (small subtitle, optional, e.g. `OCTOBER`)

No full date, day-of-year, week number, or progress indicator is shown.

## Block type

`10 x 10`, fixed.

## Settings

Configurable from the Control Center (`prefs.js`):

| Setting       | Type    | Default   | Description                               |
|---------------|---------|-----------|---------------------------------------------|
| `textColor`   | color   | `#1a1a1a` | Color of the big day number                  |
| `accentColor` | color   | `#6b6b6b` | Color of the weekday/month subtitle line     |
| `showMonth`   | boolean | `true`    | Whether the month is shown next to weekday   |

## Files

```
metadata.json
widget.js
stylesheet.css
prefs.js
README.md
```

## Notes

Built from `widgets/_template` and `widgets/clock` per the project's
widget contract - no new core structure was introduced. As with `clock`
and `_template`, the host does not yet auto-load a widget's
`stylesheet.css`, so the typography styling is applied via inline St
`style` strings in `widget.js`'s `_render()`, driven by the settings
above. `stylesheet.css` is still shipped for documentation/hooks
consistency with the rest of the project.
