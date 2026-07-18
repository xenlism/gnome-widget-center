# Project Status

> สถานะละเอียดจริงต่อ task ให้ดูที่ `development/tasks/ROADMAP.md` เสมอ (เป็น source of truth ของโปรเจกต์)
> ไฟล์นี้เป็นสรุปภาพรวมสั้น ๆ

## Completed

- Task 00 — Project setup (repo skeleton, feasibility validated on GNOME 50/Wayland)
- Task 09 — Packaging & third-party widget docs (`development/docs/PUBLISHING_A_WIDGET.md`,
  `products/extension/widgets/_template/`)

## First real-hardware confirmation (2026-07-16)

Got the first actual `journalctl` log from a real GNOME Shell session: `discover()` +
`loadAll()` (task 01) run end-to-end without crashing, and both bundled widgets from task 06
(`clock`, `media-player`) load successfully. Full details in
`development/tasks/01-widget-loader-core.md`'s "Real hardware verification" section.

This also surfaced a real bug: `widgets/_template/` (the scaffold folder, not a real widget)
was being scanned and loaded like any other widget, because its `metadata.json` has a valid
`id` (`my-widget`) and nothing skipped underscore-prefixed folders. **Fixed** —
`widgetLoader.js`'s `discover()` now skips any folder starting with `_` before it even reads
`metadata.json`. Not yet re-verified on the real machine.

While in there, extracted the MPRIS/DBus logic out of `media-player/widget.js` into a new
`products/extension/lib/mediaApi.js` (`MprisMediaService`) so it isn't duplicated if another
media-related widget gets added later. Behavior is unchanged; this is bundled-widget-only code
reuse, **not** a new public `api.media` hook — third-party widgets still follow the direct
`Gio.DBusProxy` pattern in `development/docs/WIDGET_API.md` §8. See task 06's notes for why
that distinction matters.

## Logic-complete, awaiting verification on real GNOME Shell

- Task 01 — Widget loader core (load/enable path now confirmed working on real hardware; the
  `_template`-skip bug still needs a re-test to confirm the fix)
- Task 02 — Widget layer rendering
- Task 03 — Settings store (has real unit tests, passing)
- Task 04 — Drag reposition (Super+drag, Normal mode only — see Resolved decisions re: task 13)
- Task 07 — Multi-monitor support (`monitorWatcher.js` + `widgetLayer.reconcileMonitors()`;
  Notes from implementation added 2026-07-16)
- Task 08 — Hot-reload dev mode (`devWatcher.js` + `widgetLoader.reloadWidget()`; Notes from
  implementation added 2026-07-16)
- Task 10 — Testing & release prep (`development/tests/e2e-checklist.md` + `products/CHANGELOG.md` written,
  `products/extension/metadata.json` version bumped 0→1; main acceptance criterion — clean install,
  1hr no warnings in journalctl — not yet confirmed on real hardware)

## Planned

- Task 05 — Prefs control center
- Task 06 — Widget SDK example pack (clock + media-player via MPRIS)
- Task 11 — Theme backup & restore (export/import as `.gwctheme` JSON)
- **Task 12 — Widget Edit Mode** *(spec draft:
  `development/architecture/specs/ui/widget-edit-mode.md`)*
- **Task 13 — Widget Drag & Drop** *(spec draft:
  `development/architecture/specs/ui/drag-drop.md`; scope decided 2026-07-16 — see Resolved
  decisions)*
- **Task 14 — Grid Engine** *(spec draft:
  `development/architecture/specs/ui/grid-engine.md`)*

## New supporting specs (not yet tied to a numbered task)

- `development/architecture/specs/ui/dashboard.md` — dashboard lifecycle, pages, widget containers
- `development/architecture/specs/ui/animation.md` — timing, easing, FPS targets

## Resolved decisions (2026-07-16)

- **Task 07/08 missing Notes from implementation** — backfilled, based on reading the actual
  code (`monitorWatcher.js`, `devWatcher.js`, the relevant `widgetLayer.js`/`widgetLoader.js`
  methods). Still not verified on real GNOME Shell hardware — same caveat as tasks 01-04.
- **Top-level `widgets/` vs `products/extension/widgets/` duplicate** — decided to drop the
  top-level folder entirely. `products/extension/widgets/` is the sole source of truth (it's
  the only path `extension.js` ever actually loads from). Updated `README.md`,
  `development/architecture/README.md`, and the bare `widgets/...` references in tasks 01/06
  and `PUBLISHING_A_WIDGET.md` to point at `products/extension/widgets/...` explicitly. Full
  reasoning in `development/tasks/ROADMAP.md`'s "Decision (2026-07-16)".
- **Task 13 vs task 04 scope overlap** — decided these are different interaction modes, not
  competing implementations: task 04 is Super+drag in Normal mode (ships today, unchanged);
  task 13 is drag-with-grid-snap that only runs while in Edit Mode (task 12). Both persist
  through the same `StorageService.updateWidgetPosition()`. See the note at the top of
  `development/tasks/13-widget-drag-drop.md`.
- **`architecture/specs/api/widget-api.md` vs `docs/WIDGET_API.md` duplicate spec** — decided
  `docs/WIDGET_API.md` is the one authoritative contract; the `architecture/specs/` copy is now
  just a pointer to it, so future API additions (e.g. from task 12) go in one place only.

## Resolved decisions (2026-07-18)

- **Task 12 back-side buttons — text label → icon + tooltip + `accessible_name`** — the
  Accessibility gap `widget-edit-mode.md` used to flag ("plain `St.Button` with a text label
  only, no explicit `accessible_name`") is closed: buttons now render as symbolic icons with an
  explicit `accessible_name` (screen reader) and a custom hover tooltip (`St` has no built-in
  tooltip widget, unlike Gtk's `tooltip-text` on the prefs side). Also fixes 4 text buttons
  wrapping/clipping in the back-side card at small widget sizes. No state-machine or callback
  changes. Details in `development/tasks/12-widget-edit-mode.md`'s 2026-07-18 implementation
  note. Still not verified on real GNOME Shell hardware — same caveat as every other item in
  this file; tooltip positioning in particular reads `get_preferred_height/width` before first
  allocation, worth an explicit check.
- **Task 05 — declarative `settings` schema, auto-generated prefs UI** — a widget can now list
  its settings as a plain array in `metadata.json` (`string`/`number`/`range`/`boolean`/
  `dropdown`/`color`) instead of hand-writing `prefs.js`; the Control Center builds the
  `Adw.PreferencesPage` automatically (`settingsSchemaUI.js`). `WidgetLoader.discover()`
  validates the schema and rejects the whole widget (same as a broken `metadata.json`) if it's
  malformed. A widget with both a schema and a hand-written `prefs.js` gets the hand-written one
  — author's explicit code always wins over auto-generation. File/folder/desktop-file/command/
  date/time/password/url/icon/font types are NOT yet supported (documented as out of scope in
  `development/tasks/05-prefs-control-center.md`) — still need `prefs.js` for those. Still
  inherits the existing cross-process limitation noted above (settings changed here don't
  reflect on the desktop in real time) — that's the next item on the list, not fixed by this
  change. Not yet verified on real GNOME Shell hardware.

## Next Milestone

> อัปเดต 2026-07-18: 3 รายการเดิม (Widget Edit Mode/Drag & Drop/Grid Engine) implement ไปแล้วตั้งแต่
> ก่อนหน้านี้ (ดู "Logic-complete" ด้านบน) — รายการนี้แก้เป็น backlog ที่เหลือจริงแทน

1. **Task 05 (ต่อ) — Cross-process Live Update** — settings ที่แก้จาก Prefs (ทั้ง `prefs.js` เดิม
   และ auto-generated schema page ใหม่) ยังไม่สะท้อนผลบนพื้นโต๊ะแบบ real-time, ต้องมี notification
   channel ข้าม process
2. **Workspace Visibility** — `development/architecture/specs/ui/workspace.md` ยังเป็นไฟล์เปล่า
   (มีแค่หัวข้อ) ต้องเขียนสเปคเต็มก่อน แล้วค่อยตั้งเลข task
3. **Task 13 (เพิ่ม) — Monitor Lock** — ยังไม่มีการป้องกันลาก widget ข้าม monitor ระหว่าง Edit Mode
4. **Task 14 (ขยาย) — Widget size constraints** — ตอนนี้ grid engine snap แค่ตำแหน่ง ไม่ได้บังคับขนาด
   widget ให้อยู่ใน preset ที่กำหนด
5. Layout persistence (เดิม)
6. Testing (เดิม — ดู task 10)

---
_Last updated: 2026-07-18 — Task 05: added declarative `settings` schema + auto-generated prefs
UI. Task 12: back-side buttons switched from text labels to icon + tooltip + `accessible_name`
(see "Resolved decisions (2026-07-18)" above). Refreshed "Next Milestone" — task 12/13/14 were
stale entries there (already implemented, see "Logic-complete" above). Previous update
2026-07-16: merged incoming task specs (Widget Edit Mode, Drag & Drop, Grid Engine + supporting
drafts) into `development/tasks/`; consolidated the drafts into
`development/architecture/specs/` instead of a separate `docs/spec/` folder; and cleared all
four known open items._
