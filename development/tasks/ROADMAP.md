# ROADMAP.md — สถานะงานทั้งหมด (source of truth)

อัปเดตทุกครั้งที่ทำ task เสร็จ — นี่คือไฟล์ที่ต้องแนบให้ AI ตัวใหม่ดูก่อนเริ่มงานเสมอ

## Phase 0 — Validate ความเป็นไปได้ (ต้องทำก่อนอย่างอื่นทั้งหมด)

- [x] `00-project-setup.md` — ตั้ง repo skeleton + validate feasibility บน GNOME 50/Wayland จริง

## Phase 1 — Core host extension (ทำเรียงตามลำดับ)

- [ ] `01-widget-loader-core.md` — ระบบ discover/load widget จากโฟลเดอร์
- [ ] `02-widget-layer-rendering.md` — ชั้นแสดงผล (Widget Layer) บนพื้นโต๊ะ
- [ ] `03-settings-store.md` — JSON settings store ต่อ widget
- [ ] `04-drag-reposition.md` — ลาก widget เปลี่ยนตำแหน่งได้ (Super+drag)

*(checkbox 4 อันนี้ยังไม่ติ๊กแม้โค้ดจะเขียนครบและ acceptance criteria ผ่านหมดในระดับ logic
แล้ว — ไม่มี GNOME Shell จริงให้รันในสภาพแวดล้อมที่ implement อยู่ ดู "Notes (2026-07-14)"
ด้านล่างสำหรับสถานะละเอียดต่อ task ก่อนติ๊กจริงต้องทดสอบบนเครื่องที่มี GNOME Shell 45+ ก่อน)*

## Phase 2 — UX / Control Center

- [ ] `05-prefs-control-center.md` — GUI จัดการ widget (list/enable/disable/settings)
- [ ] `07-multi-monitor-support.md` — รองรับหลายจอ/เปลี่ยนความละเอียด

*(ทำขนานกับ Phase 1 ท้าย ๆ ได้ ถ้า loader/layer นิ่งพอแล้ว)*

## Phase 3 — Developer experience

- [ ] `06-widget-sdk-example.md` — widget SDK example pack (นาฬิกา + media-player ผ่าน MPRIS)
      ใช้ทดสอบทุก task ก่อนหน้า
- [ ] `08-hot-reload-dev-mode.md` — โหมด dev ให้แก้ widget แล้วเห็นผลไม่ต้อง restart shell ทั้งก้อน
- [x] `09-packaging-third-party-docs.md` — ทำ `widgets/_template/` + คู่มือแจก widget แยกจากโปรเจกต์

## Phase 4 — Release

- [ ] `10-testing-release.md` — เทส end-to-end, เขียน CHANGELOG, เตรียมขึ้น extensions.gnome.org

## Phase 5 — Post-release feature

- [ ] `11-theme-backup-restore.md` — Export/Import settings ทั้งหมดเป็นไฟล์ theme เดียว (JSON)

## Phase 6 — Edit mode / Drag & Drop / Grid (จาก spec package ใหม่, 2026-07-16)

- [ ] `12-widget-edit-mode.md` — Normal/Edit mode toggle, flip animation, back-side actions
      (spec draft: `development/architecture/specs/ui/widget-edit-mode.md`)
- [ ] `13-widget-drag-drop.md` — drag lifecycle, placeholder, preview, drop flow, persistence
      hooks (spec draft: `development/architecture/specs/ui/drag-drop.md`) — **ต้อง reconcile กับ
      `04-drag-reposition.md` ก่อนเริ่ม** ว่า behavior จะรวมกันหรือแยกกันยังไง
- [ ] `14-grid-engine.md` — 16px grid, snap, guides, collision detection, auto rearrangement
      (spec draft: `development/architecture/specs/ui/grid-engine.md`)

*(ลำดับ 12→13→14 มาจาก "Next Milestone" ที่ระบุใน status ของ spec package ต้นทาง ทั้งสาม task
ยังเป็นแค่ spec Draft ไม่มี Steps/Acceptance criteria ละเอียด — ต้องขยาย spec ก่อนเริ่ม
implement จริง)*

## Notes (2026-07-13)

`03-settings-store.md` และ `04-drag-reposition.md` เคยถูกแก้ให้อ้าง DBus + SQLite service
แยกโปรเซส ("Widget Center Service") ซึ่งขัดกับ `development/docs/ARCHITECTURE.md`/`development/docs/SETTINGS_SPEC.md`
โดยตรงและไม่เคยมีสเปกรองรับ — แก้กลับมาเป็น JSON in-process ตามเอกสารเดิมแล้ว (ดูหมายเหตุใน
ไฟล์ task ทั้งสอง) ฟีเจอร์ export/import เป็น theme ที่ตั้งใจไว้เดิม ถูกแยกออกเป็น
`11-theme-backup-restore.md` แทน เพราะ scope ต่างจาก per-widget settings store

`06-example-widget-clock.md` ถูกเปลี่ยนชื่อเป็น `06-widget-sdk-example.md` และขยาย scope
เป็น example pack 2 widget (clock + media-player ผ่าน MPRIS) เพื่อโชว์ว่า `WidgetAPI` รองรับ
widget ที่คุยกับ external system DBus service ได้โดยไม่ต้องแก้ core — ดู §8 ใหม่ใน
`development/docs/WIDGET_API.md`

**แก้ code-level bug 3 จุดที่จะบล็อก task 03/04 ก่อนเริ่มได้จริง (รายละเอียดใน Notes from
implementation ของ task 02/03 แต่ละไฟล์):**
1. `settingsService.js` เดิม throw เสมอตอน `init()` เพราะมองหา schema ที่ติดตั้งระดับระบบ —
   แก้เป็นใช้ `Extension.getSettings()` + เพิ่ม `products/extension/schemas/*.gschema.xml` ที่ compile
   ไว้ในตัว extension เอง
2. `WidgetLayer` (task 02) ไม่เคยรับ actor จริงจาก widget เลย, `extension.js` ไม่เคยแนบ layer
   เข้า `background_group` — widget ที่โหลดสำเร็จไม่เคยโผล่บนพื้นโต๊ะจริง แก้ให้ครบ data flow
   ตาม `development/docs/ARCHITECTURE.md` §4 แล้ว (ยังไม่ยืนยันบนเครื่องจริง)
3. `development/docs/SETTINGS_SPEC.md` ขัดกันเองเรื่อง `host.json` vs GSettings — เลือกทาง GSettings
   เท่านั้นสำหรับ host-level settings, `host.json` ไม่มีอยู่จริง (task 11 แก้ตามแล้ว)

## Notes (2026-07-14)

`03-settings-store.md` และ `04-drag-reposition.md` — เขียนโค้ดครบตาม spec แล้ว
(`products/extension/lib/widgetSettings.js`, `products/extension/lib/dragController.js` ใหม่ทั้งคู่ + เชื่อมเข้า
`widgetLoader.js`/`extension.js`), acceptance criteria ผ่านหมดในระดับ logic:

- Task 03: มี unit test จริง (mock `GLib`/`StorageService` ใน Node เพราะไม่ต้องพึ่ง Clutter)
  ครอบ debounce-collapse, default-merge, path ตรงสเปก, สอง widget ไม่ชนกัน — รันผ่านหมด
- Task 04: ตรวจแค่อ่านโค้ด + syntax-check เพราะพึ่ง `Clutter`/`global.stage` ซึ่ง mock ยากกว่า —
  **ยังไม่ยืนยันบนเครื่องจริง** เหมือนกับ task 01/02 (ดู bug ที่แก้ไปแล้วของสองอันนั้นด้านบน)

เจอ + แก้บั๊กเดิมไปด้วยระหว่างทำ: `storageService.js` เขียนไฟล์ widget settings เป็น
`widget-<id>.json` ที่ root ของ storage dir ตรงๆ ซึ่งขัดกับ path ที่ `development/docs/SETTINGS_SPEC.md`
กำหนด (`widgets/<id>.json`) — แก้ให้สร้างโฟลเดอร์ย่อย `widgets/` แล้วตรงสเปกแล้ว

## Parallelizable tasks (ทำพร้อมกันได้ถ้ามี AI/เวลาหลายชุด)

- หลัง 01 เสร็จ: 03 (settings store) กับ 06 (widget ตัวอย่าง แบบ actor เปล่า ๆ ก่อน) ทำขนานได้
- หลัง 02 เสร็จ: 04 (drag) กับ 07 (multi-monitor) ทำขนานได้ เพราะแตะคนละไฟล์ในกลุ่ม
  `widgetLayer.js` vs `dragController.js` (แต่ต้อง sync กันเรื่อง coordinate system)
- 09 (docs/template) ทำขนานกับเกือบทุก phase ได้ เพราะเป็นเอกสาร ไม่ใช่โค้ด core

## Notes (2026-07-15)

`09-packaging-third-party-docs.md` เสร็จแล้ว (ติ๊กแล้วด้านบน) — `development/docs/PUBLISHING_A_WIDGET.md`
ใหม่, `widgets/_template/` (ทั้ง 2 ชุด — ดูหมายเหตุ duplicate ด้านล่าง) มี TODO ครบ

`10-testing-release.md` — เขียน `development/tests/e2e-checklist.md` (รวบ acceptance criteria 00-09 พร้อม
สถานะจริงต่อข้อ) และ `products/CHANGELOG.md` แล้ว, bump `products/extension/metadata.json` version 0→1 และลบ
ข้อความ "dev build - task 00" ที่ค้างมาตั้งแต่ต้น **แต่ยังไม่ติ๊ก checkbox ด้านบน** เพราะ
acceptance criteria หลัก (clean install, 1 ชั่วโมงไม่มี warning ใน journalctl) ต้องยืนยันบน
เครื่องที่มี GNOME Shell จริงก่อน — ดูรายละเอียดใน "Notes from implementation" ของ
`development/tasks/10-testing-release.md` เอง

**พบช่องว่างเอกสารระหว่างทำ 10 ที่ควรตามแก้ในรอบถัดไป (ไม่ได้แก้ในงานนี้เพราะนอก scope):**
1. ~~`07-multi-monitor-support.md` และ `08-hot-reload-dev-mode.md` ไม่มี section "Notes from
   implementation" เลย~~ **แก้แล้ว (2026-07-16)** — ดู Notes ท้ายไฟล์ทั้งสอง task
2. ~~top-level `widgets/` กับ `products/extension/widgets/` มีเนื้อหาซ้ำกันทุก byte~~
   **ตัดสินใจแล้ว (2026-07-16)** — ดูหัวข้อ "Decision (2026-07-16)" ด้านล่าง

## Decision (2026-07-16) — top-level `widgets/` ตัดออก

`products/extension/widgets/` เป็น source-of-truth เดียวสำหรับ bundled widget (`clock`,
`media-player`, `_template`) ต่อจากนี้ เหตุผล: host (`products/extension/extension.js`,
`bundledWidgetsPath = GLib.build_filenamev([this.path, 'widgets'])`) โหลดจาก path นี้เท่านั้น
มาตั้งแต่แรก ไม่เคยมีโค้ดจุดไหนอ้างถึง top-level `widgets/` เลยจริง ๆ — การ sync สองโฟลเดอร์ผ่าน
build step ใน `development/tools/` จะเพิ่ม moving part โดยไม่มีประโยชน์เชิงหน้าที่

Top-level `widgets/` (ที่เคย track อยู่ใน git history ก่อนหน้านี้) ถือเป็นเลิกใช้ — ไม่ต้องสร้าง
กลับมาอีก เอกสารที่เคยอ้าง `widgets/...` แบบ bare path (task 01, task 06,
`development/docs/PUBLISHING_A_WIDGET.md`) แก้ให้ชี้ `products/extension/widgets/...` ตรง ๆ
แล้ว

## Notes (2026-07-18) — Cross-process Live Update

ปิดช่องว่างที่ `products/extension/prefs.js` (task 05) เคยเขียนไว้เป็น "known limitation":
settings ที่แก้จากหน้า prefs ของ widget (auto-generated จาก schema หรือ hand-written) เขียน
ลง `widgets/<id>.json` จาก process ของ prefs (GTK4, แยกจาก Shell) แต่ widget instance ที่รันอยู่
ใน process ของ Shell ไม่เคยรู้ว่าไฟล์เปลี่ยน — ต้องปิด/เปิด widget ใหม่หรือ restart shell ถึงจะเห็นค่าใหม่

**สิ่งที่เพิ่ม/แก้:**
- `products/extension/lib/settingsWatcher.js` (ใหม่) — `SettingsWatcher` ใช้ `Gio.FileMonitor`
  เฝ้าไฟล์ settings ของแต่ละ widget ที่โหลดอยู่ทีละไฟล์ debounce 150ms กัน event รัวจาก
  atomic-write เดียวยิงซ้ำ (คู่กับ debounce ฝั่งเขียน 300ms ใน `widgetSettings.js` เดิม)
- `products/extension/lib/widgetSettings.js` — เพิ่ม `reloadFromDisk(widgetId, storageService)`
  (merge ค่าที่เปลี่ยนเข้า target object ของ proxy เดิมตรง ๆ ไม่ผ่าน `set` trap กันเขียนวนลูปกลับ)
  และ `release(widgetId)` (เคลียร์ registry ตอน unload กัน callback ค้าง)
- `products/extension/lib/widgetLoader.js` — `WidgetLoader` สร้าง `SettingsWatcher` ของตัวเอง
  ต่อ storageService หนึ่งตัว, เริ่มเฝ้าไฟล์ทันทีที่ widget โหลดเสร็จใน `loadOne()`, เลิกเฝ้า +
  release ใน `_unloadOneInternal()`, และ callback หา entry สดจาก `_instances` ทุกครั้งที่ยิง (ไม่
  closure entry เดิมไว้) เพื่อให้ทำงานถูกแม้ผ่าน hot-reload (task 08) มาแล้ว
- `development/docs/WIDGET_API.md` — เพิ่ม hook เสริม (optional) `onSettingsChanged(settings)` ให้
  widget author เรียกใช้เวลาต้องการทำอะไรมากกว่าแค่อ่าน `this._settings` สดในรอบถัดไป (เช่น
  restart timer ที่ตั้ง interval ไว้ตอน `enable()`)
- `products/extension/widgets/clock/widget.js` — ใส่ `onSettingsChanged()` จริงเป็นตัวอย่าง (แก้
  บั๊กเดิมไปด้วย: สลับ `showSeconds` ผ่าน prefs ก่อนหน้านี้ค่าอื่น ๆ อัปเดตสด แต่ cadence ของ timer
  เองไม่เปลี่ยนจนกว่าจะ reload)

**ยังไม่ยืนยันบนเครื่องจริง** — เหมือน task 01/02/04/07: โค้ดนี้พึ่ง `Gio.FileMonitor` ซึ่ง
mock ยากในสภาพแวดล้อมที่ implement อยู่ (ไม่มี dbus/inotify จริง) ตรวจแค่อ่านโค้ด + syntax-check
(`node --check`) + verify algorithm การ merge (`reloadFromDisk`) แยกเป็น pure-function ด้วยเคส
เขียน/echo/ลบ/เพิ่ม key ผ่าน Node ตรงๆ แล้ว (ไม่ผ่าน `gi://` imports) — logic ถูกต้องตามเคส แต่
พฤติกรรมจริงของ `Gio.FileMonitor` ข้าม process (timing, event coalescing) ต้องทดสอบบนเครื่องที่มี
GNOME Shell จริงก่อนติ๊กว่าเสร็จสมบูรณ์

**Scope ที่ตั้งใจไม่ทำรอบนี้:** ไม่ได้เพิ่ม watcher ฝั่ง `prefs.js` เอง (prefs process ไม่จำเป็นต้อง
รู้ว่า widget process เขียนไฟล์เปลี่ยน เพราะ prefs.js เปิด/ปิด window ทุกครั้งที่ผู้ใช้กด Settings
อยู่แล้ว ไม่มี state ค้างข้าม session ให้ต้อง sync กลับ)
