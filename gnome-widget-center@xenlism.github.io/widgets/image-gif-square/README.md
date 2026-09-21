# Image / Animated GIF (Square)

1x1 desktop picture frame for a single image or an animated GIF - the
same widget as `image-gif`, just defaulting to a compact square size
instead of 2x2. Both are fully resizable by dragging after they're
placed, so this variant exists purely so the square size is what you
get when adding the widget from the picker, without an extra resize
step.

## Implementation notes

- Static images (and any non-GIF format GdkPixbuf can load - PNG, JPEG,
  WebP, BMP...) are drawn with plain CSS `background-image` on an
  `St.Widget`, the same technique `media-player-poster` uses for album
  art.
- An animated GIF is detected via
  `GdkPixbuf.PixbufAnimation.new_from_file(path).is_static_image()`.
  When it's actually animated, frames are decoded one at a time with a
  `PixbufAnimationIter`. Each composited frame is written once to a temp
  PNG (keyed by pixel checksum, so later loops are pure cache hits) and
  shown by swapping the same CSS `background-image` used for stills,
  re-scheduled per-frame from the frame's own `get_delay_time()`. The temp
  files are removed on `disable()`.
- Because stills and animation frames both go through CSS
  `background-image`, the picture is clipped to the widget's
  `border-radius`. The widget copies the card's corner radius onto the
  picture so the image no longer overflows the rounded card corners.
- No Cogl / `Clutter.Image` dependency (the previous animated path relied on
  it and could silently fall back to a still frame).

## Settings (Image / GIF tab)

- **Card**: background color (visible as letterboxing when "Fit" is
  Contain).
- **Source**: file picker for the image/GIF (filters: gif, png, jpg,
  jpeg, webp, bmp).
- **Display**: Fit - *Contain* (keep aspect ratio, may letterbox) or
  *Stretch* (fill the card, ignoring aspect ratio).
- **Shadow**: standard drop-shadow tab shared by all widgets.
