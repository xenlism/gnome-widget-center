# Clock (Modern)

A vertical, stacked-digit clock card for GNOME Widget Center, built from
`widgets/calendar-modern` (card shell) and `widgets/clock` (time
formatting/timer pattern). Each unit is on its own line, top to bottom:

```
      pm
      10
      51
      01
```

- `am`/`pm` — only shown in 12-hour mode
- `HH`
- `MM`
- `SS` — always shown

## Block type

`10 x 10`, fixed.

## Settings

Configurable from the Control Center (`prefs.js`):

| Setting            | Type    | Default     | Description                                              |
|---------------------|---------|-------------|------------------------------------------------------------|
| `format24h`         | boolean | `true`      | 24-hour vs 12-hour (am/pm line shown only when off)         |
| `fontFamily`        | string  | `Sans Bold` | Font face shared by HH, MM and SS                          |
| `fontSize`          | number  | `26`        | Font size shared by HH, MM and SS                           |
| `ampmFontFamily`    | string  | `Sans Bold` | Font face for the am/pm line (separate from HH/MM/SS)        |
| `ampmFontSize`      | number  | `10`        | Font size for the am/pm line (separate from HH/MM/SS)        |
| `colorHH`           | color   | `#1a1a1a`   | Color of the HH line                                        |
| `colorMM`           | color   | `#1a1a1a`   | Color of the MM line                                        |
| `colorSS`           | color   | `#1a1a1a`   | Color of the SS line                                        |
| `colorAmPm`         | color   | `#d81f26`   | Color of the am/pm line                                     |
| `cardColor`         | color   | `#ffffff`   | Background of the card                                      |
| `launchOnClick`     | boolean | `false`     | Launch an app when the clock is clicked                     |
| `desktopFilePath`   | string  | `''`        | Path to the `.desktop` file to launch, chosen via a file browser in prefs |

`launchOnClick` uses a plain click (no modifier held). Super+click is
reserved for the host's drag-to-reposition gesture
(`lib/dragController.js`), so the two never conflict.

## Files

```
metadata.json
widget.js
stylesheet.css
prefs.js
README.md
```

## Notes

Built from `widgets/calendar-modern` and `widgets/clock` per the project's
widget contract - no new core structure was introduced. As with those two
widgets, the host does not yet auto-load a widget's `stylesheet.css`, so
the visible styling is applied via inline St `style` strings in
`widget.js`'s `_render()`, driven by the settings above. `stylesheet.css`
is still shipped for documentation/hooks consistency with the rest of the
project.

App launching uses `Gio.DesktopAppInfo.new_from_filename()` +
`appInfo.launch()` - the same mechanism GNOME Shell itself uses for
`.desktop` entries - rather than shelling out to a raw command string.
