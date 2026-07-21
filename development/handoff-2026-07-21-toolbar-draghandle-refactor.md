# Handoff — 2026-07-21 session: Toolbar Icon Click vs Drag Conflict

Scope: implement the approved "Bug Fix Proposal: Toolbar Icon Click vs
Drag Conflict" handover — a real-hardware report that clicking a
back-side toolbar icon (Settings/Reset/Remove) in Edit Mode started a
drag instead of firing the icon's own action.

## Root cause (recap from the handover doc)

`EditModeDragController`'s drag-start press listener (added in the
2026-07-19 fix, see `handoff-2026-07-19-editmode-bugs.md` / task 13's
own dated note) was armed on the BACK actor as a whole
(`armBackActor(widgetId, backActor)`). Toolbar buttons only worked at
all because `St.Button` happens to consume its own press event before
it can bubble up to that handler — an implicit assumption about event
ordering, not a real separation between "click a toolbar button" and
"start a drag". The approved design decision explicitly rejected fixing
this with `event.get_source()` checks, propagation hacks, or
`EVENT_STOP` workarounds, in favor of separating responsibilities at
the actor level.

## What changed

### `products/extension/lib/widgetEditMode.js` — `_buildBackActor()`

The back card (`back`) now has two children instead of one:

- **`dragHandle`** — a new, full-size (`x_expand`/`y_expand`), always-
  `reactive` `St.Widget`, added FIRST (bottom of z-order). This is the
  only actor anything is ever allowed to arm a drag-start listener onto.
- **`toolbar`** (renamed from the old `iconRow`) — the same horizontal
  `St.BoxLayout` of icon buttons as before, added on top of
  `dragHandle`, centered, natural size. Deliberately left non-`reactive`
  and given no button-press listener of its own — a press that misses
  every button falls straight through to `dragHandle` beneath it, which
  is what preserves "drag from empty space around the icons" without
  relying on propagation-stopping behavior of the buttons.

Right-click-to-exit-Edit-Mode still listens on `back` as a whole
(unrelated concern, different mouse button, unaffected by this change).

The `onBackActorReady` callback now fires as
`onBackActorReady(widgetId, backActor, dragHandle)` (previously just
`(widgetId, backActor)`).

### `products/extension/lib/editModeDragController.js`

- `armBackActor(widgetId, backActor)` → renamed
  `armDragHandle(widgetId, backActor, dragHandle)`. The button-press
  listener is now connected to `dragHandle`, never to `backActor`.
  `backActor` is still tracked/passed through — it's still what gets
  moved/eased on screen during the drag for visual feedback (persistence
  is still the front actor via `WidgetLayer`/`StorageService`, unchanged)
  — `dragHandle` is purely the event surface, and rides along as
  `backActor`'s own child for free.
- `entry.backPressId` → renamed `entry.dragPressId`; `entry.dragHandle`
  added to the tracked-widget shape. `detach()` now disconnects from
  `entry.dragHandle` instead of `entry.backActor`.

### `products/extension/extension.js`

`onBackActorReady` callback updated to accept `dragHandle` and call
`this._editDrag?.armDragHandle(id, backActor, dragHandle)` instead of
`armBackActor(id, backActor)`.

### `products/extension/stylesheet.css`

Added an (intentionally empty/no-op) `.widget-edit-mode-drag-handle`
rule — the drag handle has no background/border of its own, it just
sits under `.widget-edit-mode-back`'s existing styling. `toolbar` keeps
using the existing `.widget-edit-mode-icon-row` class (with
`.widget-edit-mode-toolbar` added alongside it) so no visual change was
introduced — this was a structural/behavioral fix only, no CSS look
change.

### Docs updated

- `development/architecture/specs/ui/widget-edit-mode.md` — new
  "2026-07-21" dated entry under "Real-hardware findings".
- `development/tasks/13-widget-drag-drop.md` — new dated Thai-language
  entry (matching the existing log style in that file) describing the
  same fix.
- `development/PROJECT_STATUS.md` — new "Resolved decisions
  (2026-07-21)" section.

Historical, already-dated files (`handoff-2026-07-19-*.md`, the old
`development/PROJECT_STATUS.md`/task-13 2026-07-19 entries) were left
untouched — they're accurate logs of what was true at the time, not
living documentation.

## What did NOT change

- No behavior change to Settings/Reset/Remove/Uninstall's actions
  themselves, right-click-to-exit, ESC-to-exit, tooltips, or the flip
  animation.
- No new "Content" actor was added — the current back side has no
  widget-info display (title/version/etc.) to separate out; the
  handover doc's `Content` section is optional/forward-looking and
  nothing in this codebase currently needs it. `dragHandle` fills the
  role the ASCII mock's "Drag Area" shows.
- Grid snap, collision detection, monitor lock, and placeholder
  rendering during a drag are all unchanged — only which actor the
  drag-start press listener lives on changed.

## Verification done

- `node --check` passed on every `.js` file touched
  (`widgetEditMode.js`, `editModeDragController.js`, `extension.js`).
- Grepped the whole repo for stale references to `armBackActor`,
  `iconRow`, and `backPressId` outside of already-dated historical
  handoff logs — none found in live code.
- **Not verified on real GNOME Shell hardware** — same caveat as every
  prior session. Please re-test: right-click a widget into Edit Mode,
  confirm each toolbar icon (Settings/Reset/Remove, and Uninstall for a
  user-installed widget) fires its own action on click, and confirm
  dragging still works from anywhere on the card that isn't one of the
  icons.
