# Task 13 — Widget Drag & Drop

> **หมายเหตุการรวมไฟล์ (2026-07-16):** task นี้มาจาก spec package ที่ส่งเข้ามาใหม่ ต้นทางตั้งชื่อ
> `08-widget-drag-drop.md` แต่เลข 08 ถูกใช้แล้วโดย `08-hot-reload-dev-mode.md` — เปลี่ยนเลขเป็น 13
> เนื้อหาต้นฉบับเป็นแค่ one-liner (`Implemented target: Drag & Drop.`)
>
> **ต่างจาก `04-drag-reposition.md` อย่างไร — ตัดสินใจแล้ว (2026-07-16):** ทั้งสอง task ไม่ได้
> ทับ scope กัน แต่เป็นคนละ interaction mode ที่ใช้ persistence layer เดียวกัน:
> - **Task 04 (มีอยู่แล้ว, ใช้งานได้จริงวันนี้)** — Super+drag แบบ free-form บนพื้นโต๊ะปกติ
>   (Normal mode) ไม่มี grid, ไม่มี snap
> - **Task 13 (นี้)** — drag ที่เกิดขึ้นเฉพาะตอนอยู่ใน **Edit Mode** (task 12) เท่านั้น มี
>   placeholder/preview ระหว่างลาก และ snap เข้า 16px grid ผ่าน Grid Engine (task 14) เมื่อปล่อย
>
> พูดอีกแบบ: task 04 ยังทำงานเหมือนเดิมไม่ต้องแก้ — DragController ปัจจุบันของมันคือ trigger
> "Super+drag ตอนอยู่ Normal mode" ส่วน task 13 คือ drag flow ใหม่ที่ทำงาน "ตอนอยู่ Edit mode"
> เท่านั้น (เข้า Edit mode ยังไงเป็นเรื่องของ task 12) ทั้งสองยังใช้
> `StorageService.updateWidgetPosition(widgetId, x, y, monitorIndex)` ตัวเดิมจาก task 03 เป็น
> persistence layer เดียวกัน (monitor-relative coordinate เหมือนกันทุกจุด) — task 13 แค่เพิ่ม
> ชั้น snap-to-grid ก่อนจะเรียก method เดิมนี้ ไม่ต้องสร้าง storage ใหม่
>
> ถ้าในอนาคตอยากรวมสองโหมดเป็นอันเดียว (เช่น Super+drag ก็ snap เข้า grid ด้วยเลย) ให้เปิด
> task ใหม่แยกต่างหาก — ไม่ใช่ scope ของ task 13 นี้

## Goal

Implement Drag & Drop — วาง drag lifecycle, placeholder, preview, drop flow, persistence
hooks ตามที่ร่างไว้ใน spec

## Spec reference

`development/architecture/specs/ui/drag-drop.md` (status: Draft) — Defines drag lifecycle, placeholder, preview,
drop flow, persistence hooks

## Depends on

`14-grid-engine.md` (drop flow ต้องอิง grid cell/snap จาก grid engine), `12-widget-edit-mode.md`
(drag นี้ทำงานเฉพาะตอนอยู่ Edit mode — ดูหมายเหตุด้านบน), `03-settings-store.md`
(persistence hooks ใช้ `StorageService.updateWidgetPosition()` ตัวเดิมกับ task 04)

## Files to touch

_(ยังไม่ระบุ — คาดว่าเกี่ยวกับ `products/extension/lib/dragController.js` ที่มีอยู่แล้วจาก task 04
ต้องตัดสินใจว่าจะขยายไฟล์เดิมหรือแยกไฟล์ใหม่)_

## Steps

_(รอ spec `development/architecture/specs/ui/drag-drop.md` ขยายจาก Draft ให้ครบก่อนเริ่ม implement)_

## Acceptance criteria

- [ ] _(รอกำหนดจาก spec ฉบับเต็ม)_

## Out of scope

_(ยังไม่ระบุ)_

## Notes from implementation

_(เติมหลังทำเสร็จ)_
