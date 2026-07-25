# Date (Modern)

A vertical, stacked date card for GNOME Widget Center, copied from
`widgets/clock-modern` and remapped from HH/MM/SS to month / day-of-week /
day-of-month. Each unit is on its own line, top to bottom:

```
      Jul
      TU
      21
```

- Month — locale abbreviated month name (e.g. `Jul`)
- Day-of-week — fixed two-letter code, `MO`/`TU`/`WE`/`TH`/`FR`/`SA`/`SU`
  (locale-independent)
- Day-of-month — zero-padded `01`-`31`

## Block type

`10 x 10`, fixed.

## Settings

Configurable from the Control Center (`config.json`):

| Setting            | Type    | Default        | Description                                              |
|---------------------|---------|----------------|------------------------------------------------------------|
| `monthFont`         | string  | `Sans Bold 14` | Combined font face + size for the month line                |
| `dowFont`           | string  | `Sans Bold 16` | Combined font face + size for the day-of-week line           |
| `dayFont`           | string  | `Sans Bold 30` | Combined font face + size for the day-of-month line          |
| `colorMonth`        | color   | `#d81f26`      | Color of the month line                                      |
| `colorDow`          | color   | `#1a1a1a`      | Color of the day-of-week line                                |
| `colorDay`          | color   | `#1a1a1a`      | Color of the day-of-month line                               |
| `cardColor`         | color   | `#ffffff`      | Background of the card                                       |
| `cornerRadius`      | number  | `18`           | Corner radius of the card, in px                              |
| `launchOnClick`     | boolean | `false`        | Launch an app when the card is clicked                       |
| `desktopFilePath`   | string  | `''`           | Path to the `.desktop` file to launch, chosen via a file picker |

`launchOnClick` uses a plain click (no modifier held). Super+click is
reserved for the host's drag-to-reposition gesture
(`lib/dragController.js`), so the two never conflict.

## Files

```
metadata.json
config.json
widget.js
stylesheet.css
README.md
```

## Notes

Copied from `widgets/clock-modern` per the project's widget contract - no
new core structure was introduced. As with `clock-modern`, the host does
not yet auto-load a widget's `stylesheet.css`, so the visible styling is
applied via inline St `style` strings in `widget.js`'s `_render()`, driven
by the settings above. `stylesheet.css` is still shipped for
documentation/hooks consistency with the rest of the project.

App launching uses `Gio.DesktopAppInfo.new_from_filename()` +
`appInfo.launch()` - the same mechanism GNOME Shell itself uses for
`.desktop` entries - rather than shelling out to a raw command string.
