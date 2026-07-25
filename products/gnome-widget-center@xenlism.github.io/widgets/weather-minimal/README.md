# Weather (Minimal)

A minimal weather card - icon, condition, and temperature stacked
vertically, e.g.:

```
  (icon)
  Storm
   28°
```

## Data source

[Open-Meteo](https://open-meteo.com) - free, no API key or signup
required:

- **Geocoding API** (`geocoding-api.open-meteo.com`) backs the settings
  page's **Place** and **Location** fields (see "Location Picker" below)
  - resolving a typed city name into a human-readable place string and
    its `lat,lon` coordinates. This runs entirely in the Control
    Center/prefs process, when you're picking a location - `widget.js`
    itself never calls it.
- **Forecast API** (`api.open-meteo.com`) returns current temperature, a
  [WMO weather code](https://open-meteo.com/en/docs), and day/night
  (`is_day`) for the coordinates stored in the `location` setting.

Weather is refreshed every 15 minutes, and immediately whenever
`location` changes in settings. A failed request keeps the last good
reading on screen instead of blanking the card; the very first load shows
`--` until the first successful fetch.

## Location Picker

`place` and `location` are both `fieldType: "autocomplete"` fields (see
`WIDGET_API.md` §6.4 and `autocomplete.js` in this folder) sharing one
Open-Meteo geocoding lookup:

- **Place** - type a city name, pick a suggestion (e.g. "Bangkok,
  Thailand"). Selecting one also fills **Location** with its resolved
  coordinates.
- **Location** - type a city name here too (or paste a `lat,lon` pair
  directly - it's validated against that shape either way). Selecting a
  suggestion also fills **Place** with its name.

Only `location` (the `lat,lon` pair) actually drives the weather fetch;
`place` is a human-readable display value.

## Block type

`10 x 10`, fixed.

## Settings

| Setting          | Type    | Default        | Description                                    |
|-------------------|---------|----------------|--------------------------------------------------|
| `place`           | autocomplete | `Bangkok, Thailand` | Human-readable place name |
| `location`         | autocomplete | `13.756331,100.501762` | `lat,lon` pair actually used for the weather fetch |
| `cardColor`        | color   | `#ffffff`      | Card background color                              |
| `cornerRadius`     | number  | `18`           | Card corner radius, px                              |
| `iconColor`        | color   | `#1a1a1a`      | Weather icon tint                                   |
| `iconSize`         | number  | `64`           | Weather icon size, px                               |
| `conditionFont`    | string  | `Sans Bold 16` | Font face + size for the condition text            |
| `conditionColor`   | color   | `#1a1a1a`      | Condition text color                                |
| `tempFont`         | string  | `Sans Bold 34` | Font face + size for the temperature                |
| `tempColor`        | color   | `#1a1a1a`      | Temperature text color                              |
| `tempUnit`         | dropdown| `celsius`      | `celsius` or `fahrenheit`                           |

## Icons

`icons/*.svg` - 16 single-color SVGs, named after the icon-key
conventions used by [weather-iconic](https://github.com/konradmichalik/weather-iconic)
(`weather-sun`, `weather-cloud-rain`, `weather-cloud-lightning`, etc.),
covering every [WMO weather code](https://open-meteo.com/en/docs) Open-Meteo
returns with a distinct icon:

| Icon file                      | Covers WMO code(s)          |
|----------------------------------|------------------------------|
| `weather-sun` / `weather-moon`          | 0, 1 (clear / mainly clear) |
| `weather-cloud-sun` / `weather-cloud-moon` | 2 (partly cloudy)        |
| `weather-cloud`                     | 3 (overcast)                 |
| `weather-fog`                       | 45, 48 (fog)                 |
| `weather-cloud-drizzle`             | 51, 53, 55 (drizzle)         |
| `weather-cloud-sleet`               | 56, 57, 66, 67 (freezing drizzle/rain) |
| `weather-cloud-rain`                | 61, 63, 65 (rain)            |
| `weather-cloud-snow`                 | 71, 73, 75 (snow)            |
| `weather-cloud-snow-fine`           | 77 (snow grains)             |
| `weather-cloud-sun-rain`            | 80, 81, 82 (rain showers, daytime) |
| `weather-cloud-sun-snow`            | 85, 86 (snow showers, daytime) |
| `weather-cloud-lightning`           | 95 (thunderstorm)             |
| `weather-cloud-lightning-hail`      | 96, 99 (thunderstorm w/ hail) |
| `weather-wind`                      | fallback for any unmapped code |

These are original, minimal placeholder artwork drawn for this widget
under the same filenames/keys weather-iconic uses - not a redistribution
of that project's actual icon files (which are separately licensed). To
use the real weather-iconic artwork instead, download the single-color
SVGs from https://github.com/konradmichalik/weather-iconic and replace
the files in this widget's `icons/` folder, keeping the same filenames.

Icons are recolored at render time: each SVG ships with a literal
`fill="#000000"` placeholder; `widget.js` swaps that for the configured
`iconColor` and caches the recolored copy under
`~/.cache/gnome-widget-center/weather-minimal/`.

## Files

```
metadata.json
config.json
widget.js
autocomplete.js
stylesheet.css
icons/*.svg
README.md
```

## Notes

Networking uses `Soup.Session` (libsoup3, `gi://Soup?version=3.0`) via
`send_and_read_async` - the standard HTTP client for GNOME Shell
extensions - wrapped in try/catch so a network hiccup never crashes the
widget.

This widget reads its own bundled icons via `api.path.me`, the absolute
path to its own folder on disk (see `WIDGET_API.md` §5).
