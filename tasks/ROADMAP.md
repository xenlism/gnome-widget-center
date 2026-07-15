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

## Notes (2026-07-13)

`03-settings-store.md` และ `04-drag-reposition.md` เคยถูกแก้ให้อ้าง DBus + SQLite service
แยกโปรเซส ("Widget Center Service") ซึ่งขัดกับ `docs/ARCHITECTURE.md`/`docs/SETTINGS_SPEC.md`
โดยตรงและไม่เคยมีสเปกรองรับ — แก้กลับมาเป็น JSON in-process ตามเอกสารเดิมแล้ว (ดูหมายเหตุใน
ไฟล์ task ทั้งสอง) ฟีเจอร์ export/import เป็น theme ที่ตั้งใจไว้เดิม ถูกแยกออกเป็น
`11-theme-backup-restore.md` แทน เพราะ scope ต่างจาก per-widget settings store

`06-example-widget-clock.md` ถูกเปลี่ยนชื่อเป็น `06-widget-sdk-example.md` และขยาย scope
เป็น example pack 2 widget (clock + media-player ผ่าน MPRIS) เพื่อโชว์ว่า `WidgetAPI` รองรับ
widget ที่คุยกับ external system DBus service ได้โดยไม่ต้องแก้ core — ดู §8 ใหม่ใน
`docs/WIDGET_API.md`

**แก้ code-level bug 3 จุดที่จะบล็อก task 03/04 ก่อนเริ่มได้จริง (รายละเอียดใน Notes from
implementation ของ task 02/03 แต่ละไฟล์):**
1. `settingsService.js` เดิม throw เสมอตอน `init()` เพราะมองหา schema ที่ติดตั้งระดับระบบ —
   แก้เป็นใช้ `Extension.getSettings()` + เพิ่ม `extension/schemas/*.gschema.xml` ที่ compile
   ไว้ในตัว extension เอง
2. `WidgetLayer` (task 02) ไม่เคยรับ actor จริงจาก widget เลย, `extension.js` ไม่เคยแนบ layer
   เข้า `background_group` — widget ที่โหลดสำเร็จไม่เคยโผล่บนพื้นโต๊ะจริง แก้ให้ครบ data flow
   ตาม `docs/ARCHITECTURE.md` §4 แล้ว (ยังไม่ยืนยันบนเครื่องจริง)
3. `docs/SETTINGS_SPEC.md` ขัดกันเองเรื่อง `host.json` vs GSettings — เลือกทาง GSettings
   เท่านั้นสำหรับ host-level settings, `host.json` ไม่มีอยู่จริง (task 11 แก้ตามแล้ว)

## Notes (2026-07-14)

`03-settings-store.md` และ `04-drag-reposition.md` — เขียนโค้ดครบตาม spec แล้ว
(`extension/lib/widgetSettings.js`, `extension/lib/dragController.js` ใหม่ทั้งคู่ + เชื่อมเข้า
`widgetLoader.js`/`extension.js`), acceptance criteria ผ่านหมดในระดับ logic:

- Task 03: มี unit test จริง (mock `GLib`/`StorageService` ใน Node เพราะไม่ต้องพึ่ง Clutter)
  ครอบ debounce-collapse, default-merge, path ตรงสเปก, สอง widget ไม่ชนกัน — รันผ่านหมด
- Task 04: ตรวจแค่อ่านโค้ด + syntax-check เพราะพึ่ง `Clutter`/`global.stage` ซึ่ง mock ยากกว่า —
  **ยังไม่ยืนยันบนเครื่องจริง** เหมือนกับ task 01/02 (ดู bug ที่แก้ไปแล้วของสองอันนั้นด้านบน)

เจอ + แก้บั๊กเดิมไปด้วยระหว่างทำ: `storageService.js` เขียนไฟล์ widget settings เป็น
`widget-<id>.json` ที่ root ของ storage dir ตรงๆ ซึ่งขัดกับ path ที่ `docs/SETTINGS_SPEC.md`
กำหนด (`widgets/<id>.json`) — แก้ให้สร้างโฟลเดอร์ย่อย `widgets/` แล้วตรงสเปกแล้ว

## Parallelizable tasks (ทำพร้อมกันได้ถ้ามี AI/เวลาหลายชุด)

- หลัง 01 เสร็จ: 03 (settings store) กับ 06 (widget ตัวอย่าง แบบ actor เปล่า ๆ ก่อน) ทำขนานได้
- หลัง 02 เสร็จ: 04 (drag) กับ 07 (multi-monitor) ทำขนานได้ เพราะแตะคนละไฟล์ในกลุ่ม
  `widgetLayer.js` vs `dragController.js` (แต่ต้อง sync กันเรื่อง coordinate system)
- 09 (docs/template) ทำขนานกับเกือบทุก phase ได้ เพราะเป็นเอกสาร ไม่ใช่โค้ด core

## Notes (2026-07-15)

`09-packaging-third-party-docs.md` เสร็จแล้ว (ติ๊กแล้วด้านบน) — `docs/PUBLISHING_A_WIDGET.md`
ใหม่, `widgets/_template/` (ทั้ง 2 ชุด — ดูหมายเหตุ duplicate ด้านล่าง) มี TODO ครบ

`10-testing-release.md` — เขียน `tests/e2e-checklist.md` (รวบ acceptance criteria 00-09 พร้อม
สถานะจริงต่อข้อ) และ `CHANGELOG.md` แล้ว, bump `extension/metadata.json` version 0→1 และลบ
ข้อความ "dev build - task 00" ที่ค้างมาตั้งแต่ต้น **แต่ยังไม่ติ๊ก checkbox ด้านบน** เพราะ
acceptance criteria หลัก (clean install, 1 ชั่วโมงไม่มี warning ใน journalctl) ต้องยืนยันบน
เครื่องที่มี GNOME Shell จริงก่อน — ดูรายละเอียดใน "Notes from implementation" ของ
`tasks/10-testing-release.md` เอง

**พบช่องว่างเอกสารระหว่างทำ 10 ที่ควรตามแก้ในรอบถัดไป (ไม่ได้แก้ในงานนี้เพราะนอก scope):**
1. `07-multi-monitor-support.md` และ `08-hot-reload-dev-mode.md` ไม่มี section "Notes from
   implementation" เลย ทั้งที่โค้ด (`monitorWatcher.js`, `devWatcher.js`) มีอยู่จริงและ wire
   เข้า `extension.js` แล้ว — ควรเปิด session ใหม่เติม Notes ให้ทั้งสอง task ก่อน tick checkbox
2. top-level `widgets/` กับ `extension/widgets/` มีเนื้อหาซ้ำกันทุก byte (`_template`, `clock`,
   `media-player`) แต่ host (`extension/extension.js`) โหลด bundled widget จาก
   `extension/widgets/` เท่านั้น — ต้องตัดสินใจว่าจะ sync สองโฟลเดอร์นี้ด้วย build step
   (`tools/`) หรือลบโฟลเดอร์ top-level ทิ้ง ก่อน package สำหรับแจกจริง
