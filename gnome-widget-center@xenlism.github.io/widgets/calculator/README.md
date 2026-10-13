# Calculator

`2x2` basic four-function calculator styled after the macOS Calculator
app: dark digit keys, light gray function keys (`AC`, `+/-`, `%`), and
orange pill-shaped operator keys, with a right-aligned display.

## Behavior

- Standard chained-entry calculator logic (`5 + 3 × 2 =` evaluates
  left-to-right as you go, the same way a physical/desktop calculator
  does - not full operator-precedence math).
- `AC` clears everything; `+/-` flips the sign of the current entry;
  `%` divides the current entry by 100.
- Grid is a real `Clutter.GridLayout` (`layout.attach(button, col, row,
  colSpan, rowSpan)`, same technique `power-menu`'s 2x2 action grid
  uses) so the `0` key can cleanly span two columns like the real app.
- All calculator state (current entry, pending operator/value) is kept
  in memory only, not written to the widget's settings file - a
  calculator resetting to `0` after a Shell restart matches how every
  real calculator app/widget behaves, so there was no reason to persist
  it the way `pomodoro-timer`'s timer state or `todo-list`'s tasks are.
- Buttons use the plain `St.Button` `"clicked"` signal (like every
  other bundled multi-button widget - `power-menu`, `settings-control`,
  media player transport controls), so no manual Super+drag guard is
  needed here the way `sticky-note`'s single big click region needed
  one.

## Settings (Calculator tab)

- **Card**: background color, corner radius.
- **Display**: font, text color.
- **Buttons**: digit/function/operator background colors, and text
  colors for each.
- **Shadow**: standard drop-shadow tab shared by all widgets.
