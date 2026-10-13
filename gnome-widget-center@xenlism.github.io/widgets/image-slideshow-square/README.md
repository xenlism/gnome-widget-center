# Image Slideshow (Square)

1x1 crossfading slideshow through a folder of photos - the same
widget as `image-slideshow`, just defaulting to a compact square size
instead of 2x2. Both are fully resizable by dragging after they're
placed, so this variant exists purely so the square size is what you
get when adding the widget from the picker, without an extra resize
step.

## Implementation notes

- The folder is scanned once (on load and whenever the folder path
  setting changes) with a synchronous `Gio.File.enumerate_children()` -
  only top-level files matching `.png .jpg .jpeg .webp .bmp .gif` are
  collected; subfolders aren't walked. A GIF here is shown as a still
  frame (this widget doesn't animate them - see `image-gif` for that).
- Two overlapping `St.Widget` layers (CSS `background-image`, same
  technique as `image-gif`'s static path) are cross-faded with
  `actor.ease({opacity, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD})`
  - the incoming photo fades in on one layer while the outgoing one
    fades out on the other, then they swap roles for the next photo.
- **Shuffled** order re-shuffles the whole list every time it loops
  back to the start (rather than picking independently at random each
  tick), so a photo never repeats back-to-back across a loop boundary.
- Each photo layer carries the card's `border-radius` itself (St clips a
  CSS background-image to the widget's own radius, not its parent's), so
  photos follow the card's rounded corners instead of overflowing them.

## Settings (Image Slideshow tab)

- **Card**: background color (visible as letterboxing when "Fit" is
  Contain).
- **Source**: folder picker for the photos.
- **Playback**: time per photo, crossfade duration, and order
  (sequential by file name, or shuffled).
- **Display**: Fit (Contain/Stretch), and an optional file name
  overlay in the bottom-right corner.
- **Shadow**: standard drop-shadow tab shared by all widgets.
