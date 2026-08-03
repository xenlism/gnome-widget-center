# Geek Week Stat Big

Large `4x1` card (47×11 grid cells) with two centered lines:

```
        THURSDAY

        CPU 100%  MEM 100%  DISK 100%
```

## Settings

- **Week text** — font face/size (`weekFont`) and color (`weekColor`) for the top line.
- **System text** — font face/size (`systemFont`) and color (`systemColor`) for the bottom line. Also controls how often it's re-sampled (`updateInterval`, seconds) and which filesystem path DISK measures (`diskPath`, default `/`).
- **Layout** — horizontal text alignment (`textAlign`): `left`, `center` (default), or `right`.
- **Card** — background color (`backgroundColor`, transparency supported
  via an 8-digit hex or alpha color picker) and corner radius
  (`cornerRadius`).
- **Text Shadow** — optional shadow drawn under the text itself (color,
  opacity, angle, distance, blur).
- **Widget Shadow** — optional drop shadow behind the whole card (color,
  opacity, angle, distance, blur) — same mechanism every other bundled
  card widget uses.

Both text lines are always horizontally centered inside the card.

CPU/RAM come from the shared `lib/systemMetricsApi.js`; disk usage is read
directly via `Gio.File.query_filesystem_info()` since there's no shared
helper for it yet (same approach as `system-monitor-mini`).
