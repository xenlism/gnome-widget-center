# Grid Engine Specification

Status: Draft (implemented — pending verification on real hardware, see
`development/tasks/14-grid-engine.md` "Notes from implementation")

## Purpose

Pure-geometry helper used by Widget Drag & Drop
(`development/architecture/specs/ui/drag-drop.md`) for snapping, collision
avoidance, and (optionally) alignment guides. Deliberately has NO
dependency on Clutter/St, WidgetLayer, or StorageService — every method
takes plain rects/coordinates in and returns plain data out, so it can be
exercised in a unit test without a running GNOME Shell.

## Grid unit

- 16px cells (`GRID_SIZE`), matching the unit already implied by existing
  widget default sizes/positions in `development/docs/WIDGET_API.md`'s
  `metadata.json` example.

## API

- `snap(value)` / `snapPoint(x, y)` — round a raw coordinate to the
  nearest grid line.
- `rectsOverlap(a, b)` — axis-aligned bounding-box overlap test. Widgets
  are treated as opaque rectangles, same boundary WidgetLayer already
  keeps (it "does not know or care what's inside a widget's actor").
- `hasCollision(candidate, others, excludeId)` — whether a candidate rect
  overlaps any OTHER widget's current rect on the same monitor.
- `findNearestFreeCell(x, y, width, height, monitorBounds, others, excludeId, maxRings)` —
  snaps the desired point, and if occupied or out of bounds, spirals
  outward one grid ring at a time (bounded by `maxRings`, default 24 ≈
  384px search radius) until a free, in-bounds cell is found. If no cell
  is found within the search bound (e.g. a monitor tiled edge-to-edge with
  widgets), returns the snapped-but-colliding point anyway with
  `collided: true` rather than looping forever or throwing — the drop
  still completes, it just won't be perfectly separated. Origin-only
  clamping for a widget larger than the monitor mirrors
  `WidgetLayer._clampToMonitor()`'s accepted MVP limitation.
- `getAlignmentGuides(candidate, others, threshold)` — returns at most one
  vertical + one horizontal "smart guide" (the closest edge/center-line
  alignment with another widget within `threshold` px, default 6),
  Inkscape/GIMP-style. Computed but not yet drawn — see Out of scope.

## Auto-rearrangement

- Handled entirely by `findNearestFreeCell()`'s spiral search — there is
  no separate "rearrange everything" pass; each widget only ever avoids
  collision with the others at drop time, individually.

## Layout engine APIs

- `GridEngine` has no persistence and no signals — `EditModeDragController`
  (task 13) is the only caller, and it alone is responsible for turning
  the coordinates this module returns into an actual actor move
  (`WidgetLayer.setWidgetPosition()`) and a single
  `StorageService.updateWidgetPosition()` write on drop.

## Out of scope

- Alignment guides are computed (`getAlignmentGuides()`) but not yet
  rendered as visible lines during a drag — task 13's placeholder only
  reflects the collision-avoided snap target, not guide lines. Left as a
  follow-up.
- No visual "grid overlay" (faint lines across the whole desktop while
  dragging) — only the drop target placeholder is shown.
