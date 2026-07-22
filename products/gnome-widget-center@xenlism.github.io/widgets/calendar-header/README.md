# Calendar (Header)

A two-tone calendar widget for GNOME Widget Center: a colored header band
holds the month and weekday, and a plain body section below holds the
day number. Shows only:

- Month (e.g. `OCTOBER`)
- Day of week (e.g. `TUESDAY`)
- Day number (e.g. `3`)

No full date, day-of-year, week number, or progress indicator is shown.

## Block type

`10 x 10`, fixed.

## Settings

Configurable from the Control Center (`prefs.js`):

| Setting           | Type  | Default   | Description                        |
|-------------------|-------|-----------|--------------------------------------|
| `headerColor`     | color | `#2563eb` | Background of the header band        |
| `headerTextColor` | color | `#ffffff` | Color of month/weekday text          |
| `bodyColor`        | color | `#ffffff` | Background behind the day number     |
| `dayColor`         | color | `#1a1a1a` | Color of the day number              |

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
`stylesheet.css`, so the header/body styling is applied via inline St
`style` strings in `widget.js`'s `_render()`, driven by the settings
above. `stylesheet.css` is still shipped for documentation/hooks
consistency with the rest of the project.
