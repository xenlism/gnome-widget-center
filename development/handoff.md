# Handoff — 2026-07-19 session

Scope of this session: fix Edit Mode dragging (task 12/13) and remove the
min/max size-constraint system (task 14), per the request:

> edit mode icon ไม่ใช้ปุ่ม แต่เป็น icon มี tooltip click ได้เลย สามารถย้าย
> ตำแหน่งได้จาก edit mode โดย ลาก จากพื้นที่ว่างบน widget โดยไม่ต้องกด
> super+drag edit mode มี 3 icon settings reset remove ลบ ระบบ กำหนดขนาดเดิม
> ออก min max ระบบขนาดจะเป็น block เท่านั้น ไม่มีเล็กสุด ใหญ่สุด ปรับขนาดไม่ได้

## 1. Icon + tooltip + click (no text buttons)

**Already correct before this session** — not touched. `widgetEditMode.js`
renders Settings/Reset/Remove (+ Uninstall, conditionally) as
`St.Button`s with a symbolic icon child, an `accessible_name`, and a
custom hover tooltip (`_attachTooltip()`). This was done in an earlier
change (2026-07-18, see `PROJECT_STATUS.md`). Nothing to do here.

Note: a 4th icon (**Uninstall**) still appears, but *only* for
user-installed (third-party) widgets — bundled widgets (clock,
media-player) always show exactly the 3 icons asked for
(Settings/Reset/Remove). Left as-is since it's conditional and serves a
real purpose (deleting a user-installed widget's folder from disk); flag
if you actually want Uninstall gone entirely, that's a bigger removal
(touches `extension.js`'s `_uninstallWidget()` and the Control Center
wiring too).

## 2. Drag-to-reposition from Edit Mode, no Super key — **bug fix**

This was **spec'd but not actually working**. Root cause: Edit Mode sets
`actor.reactive = false` on a widget's front actor for as long as EDIT is
active (by design — so the widget's own content, like media-player's
play/pause button, can't be clicked through the back side). But
`EditModeDragController` wired its `button-press-event` listener onto
that same front actor — so a press could never reach it, and dragging
while in Edit Mode silently did nothing.

**Fix:**
- `widgetEditMode.js`: added an `onBackActorReady(widgetId, backActor)`
  constructor callback, fired once per widget the first time its back
  (flipped) actor is built.
- `editModeDragController.js`: split `attach()` (just tracks the front
  actor, for persistence) from a new `armBackActor()` (wires the actual
  press listener onto the BACK actor — the one that's visible/reactive
  while EDIT is active). During the drag, both actors are moved together
  every motion event: the front actor via the existing
  `WidgetLayer.setWidgetPosition()` path (unchanged, still what gets
  persisted via `StorageService.updateWidgetPosition()` on drop), and the
  back actor via a direct `set_position()` call purely so the user can
  see it move.
- `extension.js`: wires `onBackActorReady` to call
  `this._editDrag.armBackActor(...)`.

"Drag from empty space" needed no extra code: the 3 action icons are
`St.Button`s that consume their own press events, so a press only
reaches the new listener when it lands on the padding/gaps around them
(`.widget-edit-mode-back`'s `padding: 8px` / `spacing: 6px` in
`stylesheet.css`). No Super key involved, same as the original spec.

Still true from before: this drag is **position-only** — it never
changes a widget's size (see point 3).

## 3. Size system — min/max removed, block-only, not resizable

- Deleted `products/extension/lib/sizeConstraintManager.js` outright —
  it was the original v1 pixel min/max system, already dead code (fully
  superseded by the block-type rewrite, nothing imported it anymore).
- Rewrote `blockSizeManager.js`: `applyBlockSize()` now sets a widget's
  pixel size directly from its declared `block-size` (`cols x rows`) x
  `GridEngine.cellSize`, with **no clamping**. Removed
  `getConstraintsFor()` and the `DEFAULT_CONSTRAINTS` it used entirely.
- Removed the `"size-constraints"` field from
  `widgets/clock/metadata.json` and `widgets/media-player/metadata.json`
  — it's no longer a recognized field at all.
- A widget's size is now exactly whatever `block-size` says (or the
  `10 x 6` cell default if it declares none) — no smallest/largest
  bound, and no way for a user to resize a widget (Edit Mode's drag is
  position-only, per point 2).

## Docs updated to match

- `development/docs/WIDGET_API.md` — dropped `size-constraints` from the
  `metadata.json` example/field docs.
- `development/architecture/specs/ui/size-constraints.md` — rewritten as
  "v3": full history v1 (pixel min/max) → v2 (block min/max) → v3
  (block, no min/max).
- `development/architecture/specs/ui/widget-edit-mode.md` and
  `drag-drop.md` — added notes on the back-actor drag fix.
- `development/tasks/13-widget-drag-drop.md` — added a
  "2026-07-19" implementation note explaining the bug and fix in detail
  (in Thai, matching the rest of that file).
- `development/PROJECT_STATUS.md` — new "Resolved decisions
  (2026-07-19)" entry summarizing both changes.

## Verification done

- `node --check` passed on every `.js` file touched
  (`widgetEditMode.js`, `editModeDragController.js`,
  `blockSizeManager.js`, `extension.js`) — syntax-level only.
- `metadata.json` files for `clock`/`media-player` validated as JSON.
- **Not yet verified on real GNOME Shell hardware** — same caveat that
  applies to essentially everything else in this codebase per
  `PROJECT_STATUS.md`. Worth an explicit real-hardware pass on:
  - Edit Mode drag actually following the pointer and snapping/
    persisting correctly.
  - Nothing broke in the flip animation now that `onBackActorReady`
    fires mid-`_buildBackActor()`.
  - Widget footprints render at the new fixed sizes (clock 20x10,
    media-player 30x15 cells) with no leftover min/max behavior.

## Files touched this session

```
products/extension/lib/widgetEditMode.js          (edited)
products/extension/lib/editModeDragController.js  (edited)
products/extension/lib/blockSizeManager.js         (rewritten)
products/extension/lib/sizeConstraintManager.js    (deleted)
products/extension/extension.js                    (edited)
products/extension/widgets/clock/metadata.json     (edited)
products/extension/widgets/media-player/metadata.json (edited)
development/docs/WIDGET_API.md                      (edited)
development/architecture/specs/ui/size-constraints.md (rewritten)
development/architecture/specs/ui/widget-edit-mode.md (edited)
development/architecture/specs/ui/drag-drop.md      (edited)
development/tasks/13-widget-drag-drop.md            (edited)
development/PROJECT_STATUS.md                       (edited)
development/handoff.md                              (this file, new)
```
