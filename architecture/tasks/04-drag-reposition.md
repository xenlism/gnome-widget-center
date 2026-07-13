# Task 04 — Drag & Reposition

## Goal

ให้ผู้ใช้ลาก widget เปลี่ยนตำแหน่งบนพื้นโต๊ะได้ด้วย Super+drag แล้วตำแหน่งใหม่ถูกบันทึกถาวร
ผ่าน layer เดียวกับที่ task 02 สร้างไว้

**หมายเหตุ (แก้ไข 2026-07-13):** เวอร์ชันก่อนหน้าของไฟล์นี้เขียนผิดพลาดว่า on-drop ต้องยิง
DBus ไปหา "Widget Center Service" แล้วเขียน SQLite — component นั้นไม่มีอยู่จริงในโปรเจกต์
และขัดกับ `docs/ARCHITECTURE.md` (ไม่มี process แยก, ไม่มี IPC — extension เขียนไฟล์เองตรงๆ)
แก้กลับมาให้ตรงกับสถาปัตยกรรมจริงแล้ว: **extension บันทึกตำแหน่งเองผ่าน `StorageService`
ที่มีอยู่แล้วจาก task 03 ไม่มีตัวกลางใดๆ**

## Depends on

`02-widget-layer-rendering.md`, `03-settings-store.md` (ใช้ `StorageService.saveLayout()`
ที่มีอยู่แล้ว)

## Context

Layout ทั้งหมด (ตำแหน่ง x/y/monitor ต่อ widget) ถือเป็น **host-level data** ไม่ใช่ settings
ของ widget แต่ละตัว — เก็บรวมกันในไฟล์เดียว `~/.config/gnome-widget-center/layout.json`
ตามที่ `StorageService.loadLayout()`/`saveLayout()` (จาก task 03) ทำไว้แล้ว **ไม่ต้องสร้างไฟล์
หรือ storage mechanism ใหม่ในtask นี้**

Coordinate system: สัมพัทธ์กับจอ (monitor-relative) ตามที่ `docs/WIDGET_API.md` §5
(`api.position`) ระบุไว้ — งานนี้ยังไม่ต้องทำ multi-monitor เต็มรูปแบบ (อยู่ task 07) แต่ต้อง
เก็บ `monitorIndex` ไว้ในข้อมูลตำแหน่งตั้งแต่แรกเพื่อไม่ต้อง migrate ทีหลัง

## Files to touch

- `extension/lib/dragController.js` (สร้างใหม่)
- `extension/extension.js` (แก้ให้สร้าง `DragController` ตอน `enable()`, destroy ตอน `disable()`
  — เชื่อมกับ `this._layer`/`this._storage` ที่มีอยู่แล้ว)

**หมายเหตุ (2026-07-13):** `WidgetLayer` (task 02) และ `StorageService` (task 03) ตอนนี้มี
method ที่ task นี้ต้องใช้ตรงพร้อมแล้ว ไม่ต้องเพิ่มเอง:
- `WidgetLayer.setWidgetPosition(widgetId, x, y)` — ขยับ actor แบบ real-time ระหว่างลาก
  (ในเมมโมรีเท่านั้น ไม่เขียนไฟล์)
- `StorageService.updateWidgetPosition(widgetId, x, y, monitorIndex)` — read-modify-write
  ตำแหน่งของ widget เดียว ไม่กระทบ widget ตัวอื่นในไฟล์เดียวกัน (มี sanitize
  `widgetId` ในตัวอยู่แล้ว) เรียกตัวนี้ตอน drop เท่านั้น ไม่ใช่ `saveLayout()` ตรงๆ
  (`saveLayout()` เขียนทับทั้งอาเรย์ ใช้ตอนต้องการ replace ทั้งชุดเท่านั้น เช่นตอน import
  theme ใน task 11)

## Steps (แนะนำ)

1. `DragController` ผูก drag ต่อ widget actor ผ่าน `Clutter` drag action หรือ
   button-press/motion/release signal (Super+drag ตามที่ Goal ระบุ — เช็ค modifier key
   ด้วย `Clutter.ModifierType.MOD4_MASK`)
2. ระหว่างลาก: อัปเดตตำแหน่ง actor แบบ real-time ในหน่วยความจำเท่านั้น (`actor.set_position()`)
   **ไม่เขียนไฟล์ทุกเฟรม**
3. ตอนปล่อยเมาส์ (drop): คำนวณตำแหน่งสุดท้าย (monitor-relative) แล้วเรียก
   `StorageService.updateWidgetPosition(widgetId, x, y, monitorIndex)` ครั้งเดียว — sync เข้า
   `WidgetLayer` ด้วย `setWidgetPosition()` (ทำไปแล้วระหว่างลากในขั้นตอนที่ 2 อยู่แล้ว ไม่ต้อง
   เรียกซ้ำตรงนี้ก็ได้ถ้า state ตรงกันอยู่แล้ว)
4. โหลดตำแหน่งกลับตอน `enable()`: `WidgetLayer.addWidgetActor(widgetId, actor, savedPosition)`
   อ่านจาก `StorageService.loadLayout()` (ทำอยู่แล้วบางส่วนจาก task 02 — เช็คว่ายังใช้ path
   เดียวกันอยู่)
5. Cleanup: `disable()` ต้อง disconnect signal ของ drag ทั้งหมด ไม่มี actor ค้าง (เทียบ acceptance
   ของ task 00/02)

## Acceptance criteria

- [ ] Super+drag widget ไปตำแหน่งใหม่ → ปล่อยเมาส์แล้วตำแหน่งถูกบันทึกใน
      `~/.config/gnome-widget-center/layout.json` ทันที (เช็คไฟล์ตรงๆ ได้)
- [ ] Reload shell (หรือ toggle enable/disable) → widget กลับมาอยู่ตำแหน่งที่ลากไว้ล่าสุด
- [ ] ลาก widget ระหว่างลากไม่มีการเขียนไฟล์ถี่ (เช็คจำนวนครั้งที่ `updateWidgetPosition()`
      ถูกเรียกต่อการลากหนึ่งรอบ — ต้องเท่ากับ 1 ไม่ใช่ต่อเฟรม)
- [ ] ลาก widget ตัวหนึ่งไม่กระทบตำแหน่งของ widget ตัวอื่นในไฟล์เดียวกัน
- [ ] `disable()` แล้วลาก (จำลองด้วยการเรียก handler ตรงๆ) ต้องไม่ throw/ไม่มี dangling signal

## Out of scope

- Multi-monitor เต็มรูปแบบ, จอถอด/เสียบใหม่ระหว่างลาก (task 07)
- Snap-to-grid, resize (task 05/07 หรือ task ใหม่ถ้าต้องการ)
- Undo/redo ตำแหน่ง

## Notes from implementation

_(เติมหลังทำเสร็จ)_
