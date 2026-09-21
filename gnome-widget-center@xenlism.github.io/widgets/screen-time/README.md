# Screen Time

2x1 card tracking today's active screen time against a daily goal.

## Implementation notes

- Activity is detected via Mutter's idle monitor
  (`global.backend.get_core_idle_monitor().get_idletime()`), not by
  watching any particular app - any keyboard/mouse input within the
  configured "Idle threshold" counts as active. This is the same
  mechanism GNOME Shell itself uses for screen-blank/lock timers, and
  works on both X11 and Wayland.
- Polled every "Check interval" seconds (default 15s). Each poll where
  idle time is below the threshold adds one interval's worth of
  seconds to today's total.
- The running total is kept in memory and only written to the
  widget's settings file (so it survives a Shell restart) at most
  once a minute, plus immediately on disable/removal - not on every
  single poll - to avoid needless disk writes.
- Rolls over to a fresh count automatically at local midnight
  (compared using `GLib.DateTime.new_now_local()`), flushing the
  previous day's total first.
- The bar and its color (green / yellow / red) reflect percent of the
  configured daily goal: under 70%, 70-100%, and over 100%.

## Settings (Screen Time tab)

- **Card**: background color.
- **Tracking**: idle threshold (how long without input counts as
  "away"), and how often idle state is checked.
- **Daily goal**: target hours the bar and percentage are measured
  against.
- **Bar colors**: track color plus the three threshold colors.
- **Text & icon**: show/hide the icon and its color, caption text and
  font/color, value font/color, and the goal sub-caption color.
- **Shadow**: standard drop-shadow tab shared by all widgets.

## Caveat

This measures *desktop* activity (any input, any window), not
per-application usage - it's a simple "how long was I at the
computer today" tracker, not an app-by-app breakdown.
