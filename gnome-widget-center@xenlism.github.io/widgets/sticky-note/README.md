# Sticky Note

`2x2` note styled after the classic Mac OS X **Stickies** widget -
colored paper, a folded page-curl in the corner, click anywhere on the
body to write.

## Behavior

- Click the note's body to open an "Edit note" dialog (multi-line
  entry - Enter inserts a new line, only **Save** closes it). Text is
  written into the widget's own settings file as a plain extra key
  (`noteText`), the same "state lives outside `config.json`" pattern
  `pomodoro-timer`/`todo-list` use, so it survives a Shell restart.
- The small dot in the top-right corner cycles through six preset
  paper colors (yellow, pink, green, blue, purple, gray) - the classic
  Stickies palette - and writes straight into the same `paperColor`
  field the Control Center's color picker uses, so either way of
  changing it stays in sync.
- A left click opens the editor without disturbing how the widget is
  normally moved: right-click still enters **Edit Mode** and drags via
  its toolbar handle (`WidgetEditMode`/`EditModeDragController`), and
  the quick Super+drag shortcut (`lib/shell/dragController.js`) still
  works too - the body's click handler only swallows a *plain* left
  click, propagating everything else (right-click, Super+left-click)
  up to the root actor, same guard (`BUTTON_PRIMARY` + `MOD4_MASK`
  check on `button-press-event`) every other clickable bundled widget
  (`circles-year`, `xtile`, `mem-monitor`, ...) already uses.
- The folded corner is a small fixed-size `St.DrawingArea` (Cairo),
  painted as a darker shade of the current paper color with a thin
  highlight along the crease - same `repaint`-signal technique
  `pomodoro-timer`'s ring and `circles-battery` use, just drawn once in
  a corner instead of filling the whole card. It's pinned to the
  bottom-right with the same expanding-spacer technique the color dot
  uses (a `y_expand` spacer above a row with an `x_expand` spacer
  before it), not `BinLayout` end-alignment on its own - that was
  landing the fold near the middle of the card instead of the corner.
- Empty note shows an italic placeholder instead of blank paper.
- The "Edit note" dialog is a wide (480px), tall, word-wrapping
  multi-line `St.Entry` (`single_line_mode` and `activatable` both
  off, `line_wrap_mode: Pango.WrapMode.WORD_CHAR`) so Enter adds a
  line instead of submitting - only **Save**/Escape closes it.

A `1x1` companion, `sticky-note-mini`, ships alongside this widget for
tighter grid layouts - same behavior, smaller defaults (fold, dot,
padding, type size).

## Settings (Sticky Note tab)

- **Paper**: paper color, corner radius, show/hide the folded corner,
  show/hide the color-cycle dot.
- **Text**: placeholder text, font, text color, alignment (left/center).
- **Shadow**: standard drop-shadow tab shared by all widgets.
