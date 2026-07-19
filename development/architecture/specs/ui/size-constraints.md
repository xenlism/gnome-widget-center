# Size Constraints (Task 14) — Block-Type System

## History

**v1 (2026-07-18, pixel-based):** `size-constraints: {minW,minH,maxW,maxH}`
in px per widget, applied via `SizeConstraintManager` reading
`actor.get_size()`. Had a real ordering bug (see git history of this
file) — applying it before the actor was placed/allocated read back
`(0, 0)` and forced every widget down to its minimum size.

**v2 (2026-07-19):** full rewrite to a block-type system, requested
after real-hardware testing kept surfacing size weirdness on top of the
v1 ordering fix. Pixel sizing was gone, but each widget still declared a
`minCols/minRows/maxCols/maxRows` clamp range in cells.

**v3 (2026-07-19, current, same day) — min/max removed entirely.**
`size-constraints` is no longer a recognized `metadata.json` field at
all. A widget's `block-size` (`cols x rows`) IS its size, full stop —
there is no smallest/largest bound to clamp against, and no clamping
logic runs anymore. `SizeConstraintManager` (v1) has been deleted from
the codebase outright, not just left unused — it had already been fully
superseded by v2's `BlockSizeManager` and nothing referenced it anymore.

## How it works now

Every widget's on-screen footprint is `cols x rows` **GridEngine cells**
— declared in its own `metadata.json`:

```json
"block-size": { "cols": 14, "rows": 6 }
```

`BlockSizeManager.applyBlockSize(metadata, actor, cellSize)`
(`blockSizeManager.js`) reads the declared `block-size` and sets
`actor.set_size(cols * cellSize, rows * cellSize)` directly, with no
clamping step — `cellSize` comes from `GridEngine.cellSize` (currently
`GRID_SIZE = 16` px/cell, see `gridEngine.js`).

Declaring `block-size` isn't required — a widget with none gets a
default `10 x 6` cell footprint. Either way, whatever size is in effect
(declared or default) is exactly what gets drawn — the host never
grows or shrinks it.

## Why this fully sidesteps the old ordering bug

v1's bug existed because it read `actor.get_size()` — a value that
depends on *when* you ask (pre- vs post-allocation). Every version since
v2 never reads the actor's current size at all: block span (cells) x
cellSize (px/cell) is fully determined by metadata + GridEngine config,
so `applyBlockSize()` can run before OR after
`WidgetLayer.addWidgetActor()` with an identical result — `extension.js`
calls it *before*, purely because "size it, then place it" reads more
naturally, not because ordering matters.

## Bundled widgets

| widget | block-size |
|---|---|
| clock | 20 x 10 (320 x 160px) |
| media-player | 30 x 15 (480 x 240px) |

## Non-goals (still true, now stronger)

Resize is NOT supported, in any form:

- `block-size` only controls the fixed size a widget is placed at — a
  user cannot change it by dragging an edge/corner, and Edit Mode's own
  drag (`widget-edit-mode.md` / `drag-drop.md`) only ever changes
  POSITION, never size.
- There is no "smallest" or "largest" a widget can become — no min, no
  max, no clamp range at all. `block-size` is the only number that
  matters, and it's fixed per-widget by its own `metadata.json`.
- A future resize feature, if one is ever built, would need its own new
  design from scratch — there is no leftover min/max range anywhere in
  this system for it to reuse anymore (the v2 range this section used to
  point to no longer exists).
