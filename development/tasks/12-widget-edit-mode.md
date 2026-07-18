# Task 12 — Widget Edit Mode

> **หมายเหตุการรวมไฟล์ (2026-07-16):** task นี้มาจาก spec package ที่ส่งเข้ามาใหม่ ต้นทางตั้งชื่อ
> `07-widget-edit-mode.md` แต่เลข 07 ถูกใช้แล้วโดย `07-multi-monitor-support.md` — เปลี่ยนเลขเป็น
> 12 เพื่อไม่ให้ทับกัน

## Goal

Implement Widget Edit Mode — สลับ widget ระหว่างโหมด Normal กับ Edit (มี flip animation,
back-side actions, state machine ของตัวเอง) ตามที่ร่างไว้ใน spec

## Spec reference

`development/architecture/specs/ui/widget-edit-mode.md` — ครอบ Normal/Edit modes, flip animation,
back side actions, state machine, interaction rules, accessibility

## Depends on

`02-widget-layer-rendering.md` (ต้องมี widget actor บนพื้นโต๊ะก่อนถึงจะมีอะไรให้ toggle โหมด),
`05-prefs-control-center.md` (ปุ่ม "Settings" เปิด Control Center เดิม — ไม่ได้สร้างหน้าจอใหม่),
`03-settings-store.md` (ปุ่ม "Reset" ใช้ `StorageService` ตัวเดิม)

## Files to touch

- `products/extension/lib/widgetEditMode.js` (สร้างใหม่) — state machine ต่อ widget, flip animation,
  back-side actor + ปุ่ม 4 อัน
- `products/extension/lib/storageService.js` (แก้ — เพิ่ม `resetWidgetSettings()` และ
  `removeWidgetLayoutEntry()` สำหรับปุ่ม "Reset")
- `products/extension/extension.js` (แก้ — instantiate `WidgetEditMode`, wire callback
  onSettings/onRemove/onUninstall, attach/detach ตาม lifecycle เดียวกับ `DragController`)
- `products/extension/stylesheet.css` (สร้างใหม่) — style ของ back-side card/ปุ่ม (host-level เท่านั้น
  ไม่ใช่ per-widget stylesheet)

## Steps

1. Right-click (`Clutter.BUTTON_SECONDARY`) บน widget actor → toggle ระหว่าง NORMAL/HOVER กับ EDIT
2. เข้า EDIT → flip actor 180° รอบจุดศูนย์กลางของตัวเอง (ตั้ง `pivot_point` ที่ (0.5, 0.5) ก่อน) และสลับ
   front/back ตอนกึ่งกลาง (90°) เพื่อไม่ให้เห็นด้านหน้ากลับด้านตอนครึ่งหลังของการ flip
3. ระหว่าง EDIT: front actor `reactive = false` (เนื้อหา widget เองกดไม่ได้), back actor (สร้างแบบ lazy
   ตอน flip ครั้งแรก) แสดงปุ่ม Settings/Reset/Remove/Uninstall (Uninstall โชว์เฉพาะ widget ที่ติดตั้งเอง
   ของผู้ใช้ ไม่ใช่ bundled)
4. ESC (เฉพาะตอน EDIT เท่านั้น — connect key handler แบบ lazy ตอนเข้า EDIT, disconnect ตอนออก) หรือ
   right-click ซ้ำ → กลับ NORMAL
5. Callback ของแต่ละปุ่มส่งกลับไปให้ `extension.js` เป็นคนจัดการจริง (เปิด Control Center / เขียน
   `disabled-widgets` GSettings / ลบไฟล์) — `WidgetEditMode` เองไม่ยุ่งกับ `SettingsService`/`WidgetLoader`
   โดยตรง

## Acceptance criteria

- [ ] Right-click widget → เห็น flip animation ไปด้านหลัง เห็นปุ่ม 4 อัน (หรือ 3 อันถ้าเป็น bundled widget)
- [ ] กด Settings → Control Center เปิดขึ้นมา
- [ ] กด Reset → widget กลับไปตำแหน่ง/ค่า default (ทดสอบด้วยการแก้ settings ก่อนแล้วกด Reset)
- [ ] กด Remove → widget หายจากพื้นโต๊ะทันที และ toggle ใน Control Center เปลี่ยนเป็นปิดด้วย (คนละ entry
      point เดียวกันของ task 05)
- [ ] กด Uninstall (widget ที่ติดตั้งเอง) → widget หายและโฟลเดอร์ถูกลบจากดิสก์จริง
- [ ] ESC หรือ right-click ซ้ำ → flip กลับด้านหน้า เนื้อหา widget กดได้ตามปกติอีกครั้ง
- [ ] ระหว่าง EDIT เนื้อหาด้านหน้าของ widget (เช่นปุ่ม play/pause ของ media-player) กดไม่ได้

## Out of scope

- ปุ่ม "Settings" ยังเปิดแค่หน้า list บนของ Control Center ไม่ deep-link ไปหน้า settings ของ widget
  ตัวนั้นโดยตรง (ต้องแก้ `prefs.js` เพิ่มถึงจะรับ hint ได้ — ไม่ได้ทำในรอบนี้)
- Uninstall ไม่มี confirmation dialog ก่อนลบไฟล์จริง — ถือว่าเป็นความเสี่ยงที่ยอมรับได้สำหรับ MVP
  แต่ควรเพิ่มก่อน release จริง
- High-contrast theme สำหรับ icon back-side ยังไม่ได้เช็ค (ดู "Notes from implementation" ด้านล่าง —
  ส่วน screen reader ปิดไปแล้ว)

## Notes from implementation

- `pivot_point` ต้องตั้งก่อนหมุน ไม่งั้น flip จะหมุนรอบมุมบนซ้ายแทนที่จะหมุนรอบจุดศูนย์กลางของ widget เอง
- back actor เป็น sibling ของ front actor (คนละตัวกัน วางซ้อนตำแหน่งเดียวกัน) ไม่ใช่ child — เพราะถ้าเป็น
  child มันจะหมุนตาม `rotation_angle_y` ของ front ไปด้วยและกลับด้านผิด
- **ยังไม่ยืนยันบนเครื่องจริง** เหมือน task ก่อนหน้าที่ไม่มี GNOME Shell จริงในสภาพแวดล้อมที่ implement —
  `node --check` ผ่านทุกไฟล์ที่แก้/สร้างใหม่ (syntax level เท่านั้น) ไม่ติ๊ก acceptance criteria จนกว่าจะ
  ทดสอบบนเครื่องที่มี GNOME Shell 45+ จริง

### 2026-07-18 — ปุ่ม back-side เปลี่ยนจาก text label เป็น icon + tooltip

- ปุ่มทั้ง 4 (Settings/Reset/Remove/Uninstall) เปลี่ยนจาก `St.Button({label})` เป็น
  `St.Button({child: St.Icon})` ด้วย symbolic icon (`preferences-system-symbolic`,
  `view-refresh-symbolic`, `window-close-symbolic`, `user-trash-symbolic`) — แก้ปัญหาที่ปุ่มข้อความ 4
  อันสตริงในการ์ดที่เล็กสุดแค่ 2 grid cell แล้ว wrap/ล้นได้
- เพิ่ม `accessible_name` ให้แต่ละปุ่มตรงๆ (ปิดช่องว่าง accessibility ที่ spec เคยระบุไว้ — เดิม "ปุ่มเป็น
  `St.Button` ธรรมดา ไม่มี custom `accessible_name`")
- เพิ่ม hover tooltip เอง (`_attachTooltip()` ใน `widgetEditMode.js`) เพราะ `St` ไม่มี tooltip widget
  ในตัวเหมือน Gtk's `tooltip-text` (ฝั่ง `prefs.js`) — โชว์ `St.Label` หลัง hover ค้าง 500ms
  (`TOOLTIP_SHOW_DELAY_MS`), ซ่อนตอน `leave-event`/`clicked`
- Tooltip cleanup ผูกกับ `entry.tooltipCleanups`, เรียกใน `detach()` ก่อน destroy back actor — ตาม
  pattern การ disconnect signal ที่ไฟล์นี้ใช้อยู่แล้วสำหรับ front actor
- ไม่กระทบ state machine, callback signature (`onSettings`/`onRemove`/`onUninstall`), หรือ
  acceptance criteria เดิมเลย — เปลี่ยนแค่สิ่งที่อยู่ *ข้างใน* ปุ่มแต่ละอัน
- **ยังไม่ยืนยันบนเครื่องจริง** เหมือนกับข้อข้างบน — โดยเฉพาะเรื่อง tooltip position
  (`get_preferred_height`/`get_preferred_width` ก่อน allocate ครั้งแรกอาจได้ 0 บนบางระบบ ต้องเช็คบน
  Shell จริง)
