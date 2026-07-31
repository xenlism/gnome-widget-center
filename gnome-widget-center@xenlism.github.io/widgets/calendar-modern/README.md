# Calendar (Modern)

A flat, rounded "card" calendar widget for GNOME Widget Center. Shows only:

- Month (e.g. `OCTOBER`)
- Day of week (e.g. `TUESDAY`)
- Day number (e.g. `3`)

No full date, day-of-year, week number, or progress indicator is shown.

## Block type

`10 x 10`, fixed.

## Settings

Configurable from the Control Center (`prefs.js`):

| Setting       | Type  | Default   | Description                          |
|---------------|-------|-----------|---------------------------------------|
| `cardColor`   | color | `#ffffff` | Background of the card                |
| `accentColor` | color | `#d81f26` | Color of the day-of-week text         |
| `textColor`   | color | `#1a1a1a` | Color of the month and day number     |

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
`stylesheet.css`, so the visible card styling is applied via inline St
`style` strings in `widget.js`'s `_render()`, driven by the settings
above. `stylesheet.css` is still shipped for documentation/hooks
consistency with the rest of the project.
