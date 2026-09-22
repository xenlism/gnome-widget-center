# Note

`2x2` folder/file-preview style card - a colored header band with rounded
top corners over a plain body showing a title, an optional subtitle and a
date, matching the "Customized Filtration - 1 photo - 2/28/25" reference
look.

## Behavior

- Click the body to open an "Edit note" dialog with a Title field and a
  multi-line Note field (Enter inserts a newline; only **Save** or
  Escape closes it) - the same left-click-only guard (`BUTTON_PRIMARY` +
  `MOD4_MASK` check on `button-press-event`) every other clickable
  bundled widget uses, so Super+drag (move) and right-click (Edit Mode)
  are untouched.
- The note text (`noteText`) lives outside `config.json`, the same
  "state lives outside `config.json`" pattern `sticky-note`'s `noteText`
  uses - only its look (font, color, placeholder) is a settings-panel
  field. It always wraps across multiple lines and has no separate
  show/hide switch, so anything typed into it is guaranteed to be
  visible; an earlier version gated it behind a switch that defaulted
  off, which could make an edit look like it silently failed.
- Empty note shows an italic placeholder (**Note placeholder**) instead
  of blank space.
- The header band is an `St.DrawingArea` (Cairo), painted as a top-to-
  bottom gradient (`headerColorTop` -> `headerColorBottom`) clipped to a
  rounded-top/flat-bottom path so its corners line up with the card's own
  `cornerRadius` - same `repaint`-signal technique `sticky-note`'s folded
  corner uses, just filling a full-width band instead of a small corner.
- Below it, an optional thin dashed divider (Cairo `setDash`) gives a
  tear-off-perforation look; toggle it off in **Card** settings.
- The date is either a fixed string (`dateText`) or, with **Use today's
  date** switched on, computed fresh from the system clock on every
  render/settings-change.

A `1x1` companion, `note-mini`, ships alongside this widget for tighter
grid layouts - same behavior, smaller defaults (header height, padding,
type size), title/date ellipsized to one line to fit the smaller cell,
note still wraps across multiple lines.

## Settings (Note tab)

- **Card**: card background, header gradient (top/bottom), corner radius,
  show/hide the dashed divider.
- **Text**: title (+ font/color), note placeholder + font/color (the
  note's own text is edited by clicking the card, not here), use-today's-
  date toggle, fixed date text (+ font/color).
- **Shadow**: standard drop-shadow tab shared by all widgets.
