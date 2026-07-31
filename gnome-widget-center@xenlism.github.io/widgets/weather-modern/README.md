# Weather (Panel)

A rounded weather card - icon, big temperature, and condition text,
stacked vertically:

```
  (icon)
   28°
  Cloudy
```

Same visual family as `weather-minimal`/`weather-dark`, but with two
things they don't have: a user-configurable refresh rate and an
alpha-enabled background color (translucent/transparent card).

## Data source

[Open-Meteo](https://open-meteo.com) - free, no API key or signup
required:

- **Forecast API** (`api.open-meteo.com`) returns current temperature, a
  [WMO weather code](https://open-meteo.com/en/docs), and day/night
  (`is_day`) for the coordinates stored in the `location` setting.

## Location

`location` is a `fieldType: "location"` field (see
`WIDGET_API.md` §6.4): type coordinates as `latitude,longitude` (e.g.
`15.1111,85.2555`; spaces around the comma are fine too), validated
against that shape and saved as you type - plus a built-in
`find-location-symbolic` icon button next to the field that looks up
your approximate coordinates from your IP address and fills them in for
you, no typing required.

This one field type is shared by all three bundled weather widgets
(implemented once in `lib/widgetConfigUI.js`, see `PROJECT_STATUS.md`'s
2026-07-31 entry) - replacing this widget's own earlier separate
momentary "Detect automatically" switch, and, before that,
weather-dark/weather-minimal's original two-field "Place" (city-name)
autocomplete + "Location" pair, whose autocomplete row only saved on
`Adw.EntryRow`'s `apply` signal (Enter / clicking a suggestion), so
typing a city name and tabbing away silently didn't persist anything.

### First-run auto-detect

If you've never set `location` (it's still the hardcoded
`13.756331,100.501762` default), `widget.js` tries once, on first load,
to replace it with your approximate location from a free
IP-geolocation lookup - in order: `ip-api.com`, `freeipapi.com`, then
`ipwhois.io`, stopping at the first one that answers. Gated by an
internal `locationAutoDetected` flag so it only ever runs once per
widget instance. This is separate from, and independent of, the
settings page's own location button above (that one is entirely
prefs-process, and runs whenever you click it).

## Refresh rate

`refreshMinutes` is a dropdown: 5 / 10 / 15 / 30 / 45 / 60 minutes,
default 15. Changing it restarts the widget's internal refresh timer
immediately (see `_armRefreshTimer()`/`onSettingsChanged()` in
`widget.js`) rather than waiting for the next scheduled tick.

## Background transparency

`cardColor` is a `colorpicker` field with `"alpha": true`, which turns
on `Gtk.ColorDialog`'s alpha slider - drag it down for a translucent or
fully transparent card. Saved as `#rrggbbaa` when alpha is less than
fully opaque (see `lib/widgetConfigUI.js`'s `_rgbaToHex()`).

## Block type

`1x1` (grid cells), fixed.

## Settings

| Setting          | Type       | Default        | Description                                          |
|-------------------|------------|----------------|--------------------------------------------------------|
| `location`         | location   | `13.756331,100.501762` | `lat,lon` pair used for the weather fetch, with a built-in IP-detect button |
| `refreshMinutes`    | dropdown   | `15`           | 5 / 10 / 15 / 30 / 45 / 60 minutes between forecast fetches |
| `cardColor`         | color (alpha) | `#000000ff` | Card background color, alpha slider enabled             |
| `cornerRadius`      | number     | `18`           | Card corner radius, px                                  |
| `iconColor`         | color      | `#ffffff`      | Weather icon tint                                        |
| `iconSize`          | number     | `72`           | Weather icon size, px                                     |
| `conditionFont`     | font       | `Sans 18`      | Condition text face + size                                |
| `conditionColor`    | color      | `#e6e6e6`      | Condition text color                                       |
| `tempFont`          | font       | `Sans Bold 48` | Temperature text face + size                                |
| `tempColor`         | color      | `#ffffff`      | Temperature text color                                       |
| `tempUnit`          | dropdown   | `celsius`      | `celsius` or `fahrenheit`                                     |

## Icons

Custom SVGs under `icons/`, named after the
[weather-iconic](https://github.com/konradmichalik/weather-iconic) /
[weather-icons](https://github.com/erikflowers/weather-icons) naming
conventions (`weather-cloud`, `weather-sun`, `weather-cloud-rain`,
etc). Each SVG ships with a literal `fill="#000000"` placeholder that
`widget.js` recolors at render time to match `iconColor` - see
`_getColoredIconFile()`.
