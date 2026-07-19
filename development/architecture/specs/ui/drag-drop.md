# Drag & Drop Specification

Status: Draft (implemented — pending verification on real hardware, see
`development/tasks/13-widget-drag-drop.md` "Notes from implementation")

## Scope

Covers dragging a widget while it is in Edit Mode
(`development/architecture/specs/ui/widget-edit-mode.md`) only. Normal-mode
Super+drag (`development/tasks/04-drag-reposition.md`) is a separate,
existing feature and is untouched by this spec — see
`development/tasks/13-widget-drag-drop.md` for the full comparison already
recorded there.

## Start condition

- Left mouse button press on a widget that is currently in EDIT (or
  DRAGGING — re-entrant presses are ignored, only one drag at a time).
- No modifier key required (unlike task 04's Super+drag) — the mode
  switch into Edit Mode is itself the explicit gesture.
- **2026-07-19 fix:** in practice this means pressing on the widget's
  BACK side (the Settings/Reset/Remove card) — the front side is
  non-reactive for as long as EDIT is active
  (`widget-edit-mode.md`'s Transition section), so it can never be what
  receives the press. A press has to land on empty space on the back
  side to count as a drag start (not one of the 3 action icons — those
  are `St.Button`s that consume their own presses), which is what
  "empty area" means in practice: the padding around/between the icons.

## During drag

- **Drag Preview** — the widget's own actor follows the pointer exactly
  (no grid snap), at reduced opacity, so it's clearly a preview rather
  than the widget's final resting state.
- **Placeholder** — a separate dashed-border ghost rect shows the actual
  grid cell the widget would land in if released right now, including
  collision avoidance (see Grid Integration below). Tinted red when the
  intended cell can't be found free (see Grid Engine's "gave up" case).
- Purely in-memory — no disk write happens per motion event, same
  discipline as task 04.

## Drop

- On release, the current (unsnapped) position is passed to the Grid
  Engine's nearest-free-cell search, and the widget animates (120ms
  ease-out) to the resulting cell.
- Persisted with a SINGLE write via `StorageService.updateWidgetPosition()`
  — the exact same method and persistence layer task 04 already uses (see
  `development/docs/SETTINGS_SPEC.md`), just called with the grid-snapped
  target instead of the raw drop point.
- The widget's Edit Mode state returns to EDIT (not NORMAL) — see
  `widget-edit-mode.md`'s Exit section.

## Grid Integration

- Every drop snap and mid-drag placeholder position goes through
  `development/architecture/specs/ui/grid-engine.md`'s `findNearestFreeCell()`
  — this spec does not re-implement grid math itself, only calls it.

## Collision Detection

- A candidate drop cell that would overlap another widget currently on
  the same monitor is rejected in favor of the nearest free cell (spiral
  search outward from the snapped point) — see Grid Engine spec for the
  search bound and its documented pathological fallback.

## Out of scope

- Cross-monitor drag (dragging a widget from one monitor's Widget Layer
  container onto another mid-drag) — not implemented. A widget can still
  be reassigned to a different monitor via the existing
  `reconcileMonitors()` path (task 07) if that monitor disappears, but not
  by dragging across a boundary while in Edit Mode.
- A drag that is aborted mid-flight by e.g. the extension being disabled
  is handled defensively (placeholder destroyed, Edit Mode state
  restored) but has no dedicated "cancel via Escape mid-drag" gesture —
  ESC while DRAGGING is currently a no-op, matching
  `widget-edit-mode.md`'s state machine.
