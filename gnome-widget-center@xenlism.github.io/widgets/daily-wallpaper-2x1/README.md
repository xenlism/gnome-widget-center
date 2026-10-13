# Daily Wallpaper (2x1)

A GNOME Widget Center wallpaper card using providers that do not require an API key.

## Providers
- **Bing Daily**: chooses randomly from the latest Bing homepage image archive.
- **Wikimedia Commons**: chooses a file from Featured Pictures on Wikimedia Commons.
- **Lorem Picsum**: requests a random landscape image.

## Features
- Refresh image on a configurable interval (1–168 hours; default 24 hours).
- **Random** action requests/selects another image for the supported provider.
- **Apply wallpaper** sets the downloaded image as the GNOME desktop wallpaper using `org.gnome.desktop.background`.
- Images are cached in `~/.cache/gnome-widget-center/daily-wallpaper`.
- No API key or third-party JavaScript runtime is required.

## Notes
Provider endpoints and availability can change. Bing's homepage archive is an undocumented endpoint; Wikimedia Commons content may have individual license/attribution requirements. Check attribution and licensing before redistributing images.


### Resolution and display options

- Automatically detects the primary monitor resolution and scale factor to request an appropriately sized download (with a safe fallback to 1920×1080).
- Widget display: Cover/crop, Contain/fit, or Stretch.
- Desktop Apply mode: Zoom, Scaled, Stretched, Centered, Tiled, or Span across monitors.

### Changelog
- Fixed: cache folder creation failed on every download after the first (Gio `EXISTS` error), so Random/refresh silently did nothing.
- Fixed: widget stayed dead after disable → enable.
- Fixed: every settings change (colour, shadow…) re-downloaded an image; now only provider/resolution changes do.
- Bing: uses `urlbase` + `_UHD`/`_1920x1080`; the daily pick is the newest image, Random picks from the last 8.
- Wikimedia: random sort direction so results are not always the same 50 files.
- Validates that the download really is an image; old cache files are pruned (last 6 kept).
- Photo corners follow the card's corner radius; shadow settings now have descriptions (config validation).
- v2: rebuilt on the image-slideshow structure (two crossfading CSS-background layers); "cover" is computed in pixels because St CSS does not reliably support it; icon buttons (random / apply) in a bottom overlay.
