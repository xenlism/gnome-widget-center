# Widget Edit Mode Specification

Status: Draft (implemented — pending verification on real hardware, see
`development/tasks/12-widget-edit-mode.md` "Notes from implementation")

## Purpose

Lets a user reconfigure a single widget (settings, reset, remove,
uninstall) without leaving the desktop, and is the gate that Widget Drag &
Drop (`development/tasks/13-widget-drag-drop.md`) requires before a drag
may start.

## Trigger

- Right-click a widget's front side → enters Edit Mode for THAT widget
  only. Every other widget on the desktop is unaffected — there is no
  single "desktop-wide edit mode" toggle.

## Transition

- The widget flips 180° about its own center (not a corner) over ~250ms.
- At the halfway point (90°, edge-on) the front content is swapped for
  the back side, so neither side is ever seen mirrored.
- Widget content is disabled while Edit Mode is active (front actor is
  non-reactive) — a widget's own interactive elements (e.g. the
  media-player widget's play/pause button) cannot be triggered by a click
  that lands on it while its back side is what's actually showing.

## Back side — available actions

Each action is rendered as a small icon button (not a text label) with a
hover tooltip and an explicit `accessible_name` carrying the label below
— see Accessibility.

- **Settings** (`preferences-system-symbolic`) — opens the Control Center
  (`development/tasks/05-prefs-control-center.md`) to the top-level
  widget list (no per-widget deep link yet — see Out of scope in the
  task doc).
- **Reset** (`view-refresh-symbolic`) — clears this widget's saved
  settings (`widgets/<id>.json`) AND its saved position (`layout.json`
  entry), so it reappears at its `metadata.json` defaults on next load.
  Exits Edit Mode immediately afterward.
- **Remove** (`window-close-symbolic`) — same effect as switching the
  widget off in the Control Center (adds it to the `disabled-widgets`
  GSettings key) — does not delete anything from disk, the widget can be
  re-enabled later with all its settings/position intact.
- **Uninstall** (`user-trash-symbolic`) — only shown for user-installed
  widgets (never for bundled ones). Removes the widget the same way
  Remove does, then deletes its folder from disk. This is destructive and
  not currently guarded by a confirmation dialog — see Out of scope in
  the task doc.

## Exit

- Right-click again, or ESC — flips back to the front side, content
  re-enabled once the flip completes.
- A drag (`development/tasks/13-widget-drag-drop.md`) does NOT exit Edit
  Mode on drop — the widget stays flipped/editable until the user
  explicitly exits, since a single reposition doesn't imply they're done
  editing.

## State machine

```
NORMAL <--(pointer leave)--- HOVER
  |  ^                         |
  |  (pointer leave)   (pointer enter)
  |  |                         |
  +--+-------------------------+
  |
  | (right-click, from NORMAL or HOVER)
  v
EDIT <--------------------------+
  |                             |
  | (drag start, task 13)       | (drop, task 13)
  v                             |
DRAGGING ------------------------+
  |
  | (right-click / ESC, only reachable from EDIT — not DRAGGING)
  v
NORMAL
```

Right-click/ESC while DRAGGING is a no-op — a drag can only be exited by
dropping, which task 13 returns to EDIT, not NORMAL directly.

## Accessibility

- Keyboard: ESC exits Edit Mode.
- Focus follows the normal actor focus chain — no custom focus trap is
  installed for the back side.
- Screen reader: each back-side button carries an explicit
  `accessible_name` (e.g. `"Settings"`, `"Reset"`) even though the
  visible content is icon-only — screen readers get the same label a
  sighted user gets from the hover tooltip.
- Hover tooltip: since `St` has no built-in tooltip widget (unlike Gtk's
  `tooltip-text`, used on the prefs side), each button shows a small
  `St.Label` after ~500ms of hover, dismissed on `leave-event`/`clicked`.
  Purely a sighted-pointer-user affordance — doesn't affect the
  screen-reader path above.
- High-contrast: not yet addressed — icon color/contrast against
  `.widget-edit-mode-back`'s background hasn't been checked against a
  high-contrast theme. Still open, unlike the text-label gap this section
  used to flag.

## Non-goals

- Multiple simultaneous Edit-Mode widgets are fully supported (each
  widget's state is independent) — this section instead means there is
  no *single* Edit Mode covering the whole desktop at once the way, e.g.,
  a "rearrange icons" mode on a phone home screen might.
- Resize is NOT supported — flipping never changes width/height, only
  rotation/opacity (and, via task 13, position).
