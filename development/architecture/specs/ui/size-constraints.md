# Size Constraints (Task 14) — Block-Type System

## History

**v1 (2026-07-18, pixel-based):** `size-constraints: {minW,minH,maxW,maxH}`
in px per widget, applied via `SizeConstraintManager` reading
`actor.get_size()`. Had a real ordering bug (see git history of this
file) — applying it before the actor was placed/allocated read back
`(0, 0)` and forced every widget down to its minimum size.

**v2 (2026-07-19, current) — full rewrite to a block-type system,**
requested after real-hardware testing kept surfacing size weirdness on
top of the v1 ordering fix. Pixel sizing is gone entirely now.

## How it works now

Every widget's on-screen footprint is `cols x rows` **GridEngine cells**
— declared in its own `metadata.json`:

```json
"block-size": { "cols": 14, "rows": 6 },
"size-constraints": { "minCols": 7, "minRows": 4, "maxCols": 31, "maxRows": 31 }
```

`BlockSizeManager.applyBlockSize(metadata, actor, cellSize)`
(`blockSizeManager.js`, replaces `sizeConstraintManager.js`) clamps the
declared `block-size` to `size-constraints` (both in cells, not px),
then sets `actor.set_size(cols * cellSize, rows * cellSize)` directly —
`cellSize` comes from `GridEngine.cellSize` (currently `GRID_SIZE = 16`
px/cell, see `gridEngine.js`).

Neither declaration is required — an widget with no `block-size` gets a
default `10 x 6` cell footprint; no `size-constraints` gets a generous
default clamp range. Widget authors don't have to touch the host to add
either.

## Why this fully sidesteps the old ordering bug

v1's bug existed because it read `actor.get_size()` — a value that
depends on *when* you ask (pre- vs post-allocation). v2 never reads the
actor's current size at all: block span (cells) x cellSize (px/cell) is
fully determined by metadata + GridEngine config, so
`applyBlockSize()` can run before OR after `WidgetLayer.addWidgetActor()`
with an identical result — `extension.js` now calls it *before*, purely
because "size it, then place it" reads more naturally, not because
ordering matters anymore.

## Bundled widgets

| widget | block-size | constraints |
|---|---|---|
| clock | 14 x 6 (224 x 96px) | 7–31 cols, 4–31 rows |
| media-player | 16 x 8 (256 x 128px) | 10–50 cols, 7–37 rows |

(Chosen to match each widget's old pixel footprint as closely as a
16px grid allows — a few px off from the original 220x90/260x130.)

## Non-goals (still true)

Resize is still NOT supported — `block-size` only controls the size a
widget is placed at, not a size the user can change by dragging an edge
(see `widget-edit-mode.md`'s Non-goals section). A future resize
feature would reuse the same `minCols/minRows/maxCols/maxRows` clamp
range this system already declares per-widget.
