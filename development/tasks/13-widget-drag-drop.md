# Task 13 — Widget Drag & Drop

> **หมายเหตุการรวมไฟล์ (2026-07-16):** task นี้มาจาก spec package ที่ส่งเข้ามาใหม่ ต้นทางตั้งชื่อ
> `08-widget-drag-drop.md` แต่เลข 08 ถูกใช้แล้วโดย `08-hot-reload-dev-mode.md` — เปลี่ยนเลขเป็น 13
>
> **ต่างจาก `04-drag-reposition.md` อย่างไร — ตัดสินใจแล้ว (2026-07-16):** ทั้งสอง task ไม่ได้
> ทับ scope กัน แต่เป็นคนละ interaction mode ที่ใช้ persistence layer เดียวกัน:
> - **Task 04 (มีอยู่แล้ว, ใช้งานได้จริงวันนี้)** — Super+drag แบบ free-form บนพื้นโต๊ะปกติ
>   (Normal mode) ไม่มี grid, ไม่มี snap
> - **Task 13 (นี้)** — drag ที่เกิดขึ้นเฉพาะตอนอยู่ใน **Edit Mode** (task 12) เท่านั้น มี
>   placeholder/preview ระหว่างลาก และ snap เข้า 16px grid ผ่าน Grid Engine (task 14) เมื่อปล่อย
>
> ทั้งสองยังใช้ `StorageService.updateWidgetPosition(widgetId, x, y, monitorIndex)` ตัวเดิมจาก
> task 03 เป็น persistence layer เดียวกัน (monitor-relative coordinate เหมือนกันทุกจุด)

## Goal

Implement Drag & Drop — วาง drag lifecycle, placeholder, preview, drop flow, persistence
hooks ตามที่ร่างไว้ใน spec

## Spec reference

`development/architecture/specs/ui/drag-drop.md` — Defines drag lifecycle, placeholder, preview,
drop flow, persistence hooks

## Depends on

`14-grid-engine.md` (drop flow ต้องอิง grid cell/snap จาก grid engine), `12-widget-edit-mode.md`
(drag นี้ทำงานเฉพาะตอนอยู่ Edit mode — ดูหมายเหตุด้านบน), `03-settings-store.md`
(persistence hooks ใช้ `StorageService.updateWidgetPosition()` ตัวเดิมกับ task 04)

## Files to touch

- `products/extension/lib/editModeDragController.js` (สร้างใหม่ — คนละไฟล์กับ
  `dragController.js` ของ task 04 ตามที่ตัดสินใจไว้ด้านบน ไม่ขยายไฟล์เดิมเพราะเป็นคนละ trigger/gate
  condition กันโดยสิ้นเชิง)
- `products/extension/extension.js` (แก้ — instantiate `EditModeDragController`, ผูก
  `setOthersProvider()` เข้ากับรายชื่อ widget อื่นบนจอเดียวกัน, attach/detach ตาม lifecycle เดียวกับ
  `DragController`)

## Steps

1. Left-click press บน widget actor → เช็ค `WidgetEditMode.isEditing(widgetId)` ก่อนเสมอ — ถ้าไม่ได้
   อยู่ Edit Mode ปล่อย event ผ่านไปเฉยๆ (ไม่ใช่ drag ของ task นี้)
2. เริ่ม drag → สร้าง placeholder actor (ทึบ, dashed border) วางตำแหน่งเดิมของ widget, เรียก
   `WidgetEditMode.enterDragging()`
3. ระหว่างลาก (`motion-event` บน `global.stage` เหมือน task 04) — widget actor เองขยับตามเมาส์ตรงๆ
   ไม่ snap (คือ "Preview"), ส่วน placeholder หาตำแหน่งจริงที่จะ snap ไปผ่าน
   `GridEngine.findNearestFreeCell()` ทุก frame (คือ "Placeholder")
4. ปล่อยเมาส์ → หาตำแหน่ง snap สุดท้ายอีกครั้งจากตำแหน่งปัจจุบัน, ease widget ไปตำแหน่งนั้น,
   เขียนบันทึกครั้งเดียวผ่าน `StorageService.updateWidgetPosition()`, ทำลาย placeholder,
   `WidgetEditMode.exitDragging()` (กลับไปที่ EDIT ไม่ใช่ NORMAL)

## Acceptance criteria

- [ ] ลากได้เฉพาะตอน widget อยู่ Edit Mode เท่านั้น — ลองลากตอน Normal mode (ไม่ได้ right-click ก่อน)
      ต้องไม่มีอะไรเกิดขึ้น (ปล่อยให้ task 04's Super+drag ทำงานตามปกติแทนถ้ากด Super ค้าง)
- [ ] เห็น placeholder แสดงตำแหน่งจริงที่จะ snap ไปพร้อม preview ตามเมาส์แบบ real-time
- [ ] ลากไปทับ widget อื่น → placeholder เปลี่ยนสี (แดง) และ snap ไปตำแหน่งว่างที่ใกล้ที่สุดแทนตอนปล่อย
- [ ] ปล่อยเมาส์แล้วปิด/เปิด extension ใหม่ (หรือ restart shell) → ตำแหน่งที่ snap ไปยังอยู่เดิม (พิสูจน์ว่า
      `updateWidgetPosition()` ถูกเรียกจริงตอนปล่อยเมาส์)
- [ ] ระหว่างลาก ไม่มีการเขียนดิสก์เลยจนกว่าจะปล่อยเมาส์ (single write เหมือน task 04)

## Out of scope

- ลากข้ามจอ (จากจอหนึ่งไปอีกจอระหว่าง drag) — ไม่รองรับ ดู `drag-drop.md` spec
- ยกเลิก drag กลางคันด้วย ESC — ยังไม่รองรับ (ESC ตอน DRAGGING เป็น no-op ตาม state machine ของ task 12)

## Notes from implementation

- Preview กับ Placeholder เป็นคนละ concept ตาม spec เดิม: preview = ตัว widget เองขยับตามเมาส์ตรงๆ,
  placeholder = ghost rect แยกต่างหากที่โชว์ปลายทางจริงหลัง snap+collision avoidance
- Collision detection ต้องการรายชื่อ widget อื่นบนจอเดียวกันแบบ real-time (ไม่ใช่ snapshot ตอน attach) —
  แก้ด้วยการผูก provider function (`setOthersProvider()`) แทนที่จะส่ง list ตายตัวเข้ามาตอน constructor
- **ยังไม่ยืนยันบนเครื่องจริง** — `node --check` ผ่านเท่านั้น เหมือน task อื่นๆ ก่อนหน้าที่ไม่มี GNOME
  Shell จริงในสภาพแวดล้อมที่ implement ไฟล์นี้
