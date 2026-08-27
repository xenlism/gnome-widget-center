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

- **Forecast API** (`api.open-meteo.com`) returns current temperature, a
  [WMO weather code](https://open-meteo.com/en/docs), and day/night
  (`is_day`) for the coordinates stored in the `location` setting.

Weather is refreshed every 15 minutes, and immediately whenever
`location` changes in settings. A failed request keeps the last good
reading on screen instead of blanking the card; the very first load shows
`--` until the first successful fetch.

## Location

`location` is a `fieldType: "location"` field (see `WIDGET_API.md` §6.4):
type coordinates as `latitude,longitude` (e.g. `15.1111,85.2555`; spaces
around the comma are fine too). It's validated against that shape and
saved as you type, and is the only value that drives the weather fetch -
plus a built-in `find-location-symbolic` icon button next to the field
that looks up your approximate coordinates from your IP address and
fills them in for you.

An earlier version resolved city names via Open-Meteo's geocoding API
through an autocomplete "Place" field, but the autocomplete row didn't
reliably persist what you typed unless you clicked a suggestion, so it
was replaced with a plain validated field, and later (2026-07-31, see
`PROJECT_STATUS.md`) upgraded to this shared `location` field type with
its own IP-detect button, the same one every bundled weather widget now
uses.

### First-run auto-detect

If you've never set `location` (it's still the hardcoded
`13.756331,100.501762` default), `widget.js` tries once, on first load, to
replace it with your approximate location from a free IP-geolocation
lookup - in order: `freeipapi.com`, then `ipwhois.io`,
stopping at the first one that answers. This runs from the Shell process
(same as the weather fetch itself), not the prefs page, and is gated by
an internal `locationAutoDetected` flag so it only ever runs once per
widget instance - after that (or if all three lookups fail), `location`
is yours to edit freely and is never overwritten automatically again.

## Block type

`10 x 10`, fixed.

## Settings

| Setting          | Type    | Default        | Description                                    |
|-------------------|---------|----------------|--------------------------------------------------|
| `location`         | location | `13.756331,100.501762` | `lat,lon` pair actually used for the weather fetch, with a built-in IP-detect button |
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
