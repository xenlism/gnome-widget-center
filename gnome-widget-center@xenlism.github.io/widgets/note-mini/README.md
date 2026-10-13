# Note (Mini)

`1x1` companion to the `note` widget - same colored header band with
rounded top corners over a title/note/date body, scaled down for a
single grid cell: smaller header/padding/type, title and date
ellipsized to one line each. The note field itself always wraps across
multiple lines, same as the 2x2 widget - it's the one field meant to
hold real content, so it's never the thing that gets clipped or hidden.

Same click-to-edit dialog (Title + multi-line Note) and left-click-only
guard as the 2x2 `note` widget - see its README for the shared behavior
notes, including why the note text has no separate show/hide switch.

## Settings (Note tab)

- **Card**: card background, header gradient (top/bottom), corner radius,
  show/hide the dashed divider.
- **Text**: title (+ font/color), note placeholder + font/color (the
  note's own text is edited by clicking the card, not here), use-today's-
  date toggle, fixed date text (+ font/color).
- **Shadow**: standard drop-shadow tab shared by all widgets.
