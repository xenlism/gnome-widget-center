# Pomodoro Timer

1x1 ring-gauge Pomodoro timer. Draws a Cairo progress ring (same
technique as `circles-battery`) around a centered `mm:ss` countdown and
a phase caption (`WORK` / `SHORT BREAK` / `LONG BREAK`), with a
play/pause button below the ring.

## Behavior

- Cycles **Work → Short break → Work → ... → Long break** automatically,
  taking a long break every *N* completed work sessions ("Sessions
  before long break").
- The ring depletes clockwise from full as the phase's time counts
  down (starts as a full circle, empties toward zero).
- Timer state (`pomodoroPhase`, `pomodoroRunning`, an absolute
  end-epoch while running, and completed-session count) is written
  into the widget's own settings file as plain extra keys - not user
  config fields - so a running/paused timer survives a Shell restart.
  Only state *transitions* (play, pause, phase change) write to disk;
  the once-a-second tick just recomputes remaining time from the
  stored end-epoch and repaints, so this doesn't spam disk I/O.
- If the countdown's end-epoch has already passed when the widget is
  rebuilt (e.g. the machine was suspended through it), exactly one
  phase transition is resolved on load rather than fast-forwarding
  through every phase that could theoretically have elapsed.
- Optional desktop notification (`Main.notify`) when a phase ends.

## Settings (Pomodoro Timer tab)

- **Card**: background color.
- **Durations**: work / short break / long break length in minutes,
  and how many work sessions happen before a long break.
- **Behavior**: auto-start the next phase vs. wait for a manual play
  press; notify on phase end.
- **Ring colors**: track color, ring thickness, and either
  - *Color by time remaining (%)* (default on) - green above 50% of
    the phase left, yellow 20-50%, red below 20%, or
  - two fixed colors (Work / Break) when that toggle is off.
- **Text**: the three phase caption strings, and font/color for the
  time and the caption.
- **Play/pause button**: show/hide, and its background/border/icon
  colors. The icon itself swaps between
  `media-playback-start-symbolic` and `media-playback-pause-symbolic`.
- **Shadow**: standard drop-shadow tab shared by all widgets.
