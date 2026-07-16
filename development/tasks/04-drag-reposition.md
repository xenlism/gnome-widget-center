# Task 04 — Drag & Reposition

## Goal

ให้ผู้ใช้ลาก widget เปลี่ยนตำแหน่งบนพื้นโต๊ะได้ด้วย Super+drag แล้วตำแหน่งใหม่ถูกบันทึกถาวร
ผ่าน layer เดียวกับที่ task 02 สร้างไว้

**หมายเหตุ (แก้ไข 2026-07-13):** เวอร์ชันก่อนหน้าของไฟล์นี้เขียนผิดพลาดว่า on-drop ต้องยิง
DBus ไปหา "Widget Center Service" แล้วเขียน SQLite — component นั้นไม่มีอยู่จริงในโปรเจกต์
และขัดกับ `development/docs/ARCHITECTURE.md` (ไม่มี process แยก, ไม่มี IPC — extension เขียนไฟล์เองตรงๆ)
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

Coordinate system: สัมพัทธ์กับจอ (monitor-relative) ตามที่ `development/docs/WIDGET_API.md` §5
(`api.position`) ระบุไว้ — งานนี้ยังไม่ต้องทำ multi-monitor เต็มรูปแบบ (อยู่ task 07) แต่ต้อง
เก็บ `monitorIndex` ไว้ในข้อมูลตำแหน่งตั้งแต่แรกเพื่อไม่ต้อง migrate ทีหลัง

## Files to touch

- `products/extension/lib/dragController.js` (สร้างใหม่) — **ทำแล้ว (2026-07-14)**: `attach(widgetId,
  actor, monitorIndex)` ผูก `button-press-event` บน actor (เช็ค `Clutter.BUTTON_PRIMARY` +
  `Clutter.ModifierType.MOD4_MASK`), แล้ว grab ต่อที่ `global.stage` สำหรับ `motion-event`/
  `button-release-event` ระหว่างลาก (ดู "Notes from implementation" ว่าทำไมต้อง grab ที่
  stage ไม่ใช่ actor เอง) — motion เรียก `WidgetLayer.setWidgetPosition()` ทุกเฟรม, release
  เรียก `StorageService.updateWidgetPosition()` ครั้งเดียว
- `products/extension/extension.js` (แก้ให้สร้าง `DragController` ตอน `enable()`, destroy ตอน `disable()`
  — เชื่อมกับ `this._layer`/`this._storage` ที่มีอยู่แล้ว) — **ทำแล้ว**: สร้าง
  `this._drag = new DragController(this._layer, this._storage)` ต่อจาก `this._layer.init()`,
  เรียก `this._drag.attach(entry.id, entry.actor, monitorIndex)` ทุกตัวหลัง
  `addWidgetActor()`, และ `this._drag.destroy()` ใน `disable()` **ก่อน** loop ที่ detach
  actor ออกจาก layer (ต้อง disconnect signal ก่อน actor ถูกทำลาย)

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

- [x] Super+drag widget ไปตำแหน่งใหม่ → ปล่อยเมาส์แล้วตำแหน่งถูกบันทึกใน
      `~/.config/gnome-widget-center/layout.json` ทันที (เช็คไฟล์ตรงๆ ได้)
- [x] Reload shell (หรือ toggle enable/disable) → widget กลับมาอยู่ตำแหน่งที่ลากไว้ล่าสุด
- [x] ลาก widget ระหว่างลากไม่มีการเขียนไฟล์ถี่ (เช็คจำนวนครั้งที่ `updateWidgetPosition()`
      ถูกเรียกต่อการลากหนึ่งรอบ — ต้องเท่ากับ 1 ไม่ใช่ต่อเฟรม)
- [x] ลาก widget ตัวหนึ่งไม่กระทบตำแหน่งของ widget ตัวอื่นในไฟล์เดียวกัน
- [x] `disable()` แล้วลาก (จำลองด้วยการเรียก handler ตรงๆ) ต้องไม่ throw/ไม่มี dangling signal

(ตรวจ logic ด้วยการอ่านโค้ดและ syntax-check เท่านั้น — **ยังไม่ได้รันบน GNOME Shell/Clutter
จริง** เพราะ container นี้ไม่มี GNOME Shell ให้รัน ต่างจาก `widgetSettings.js` ที่ mock
`GLib`/`StorageService` แล้วรัน unit test จริงได้ใน Node เนื่องจากไม่ต้องพึ่ง `Clutter`/
`global.stage`/scene graph จริง — ควรทดสอบมือบนเครื่องจริงก่อน merge)

## Out of scope

- Multi-monitor เต็มรูปแบบ, จอถอด/เสียบใหม่ระหว่างลาก (task 07)
- Snap-to-grid, resize (task 05/07 หรือ task ใหม่ถ้าต้องการ)
- Undo/redo ตำแหน่ง

## Notes from implementation

**สถานะ (2026-07-14): เสร็จ**

- Drag grab ทำที่ `global.stage` (ไม่ใช่ตัว actor เอง) สำหรับ `motion-event`/
  `button-release-event` ระหว่างลาก เพราะ actor จะหยุดรับ `motion-event` ทันทีที่ pointer
  ออกนอกขอบเขตของมัน (เกิดขึ้นตลอดระหว่างลากจริง) — นี่คือ pattern มาตรฐานของ GNOME Shell
  extension ทั่วไปสำหรับ drag ไม่ได้เขียนไว้ใน spec ตรงๆ (spec พูดถึงแค่ "Clutter drag action
  หรือ button-press/motion/release signal") แต่จำเป็นเพื่อให้ลากได้จริงแบบไม่มีจุดสะดุด
  `attach()` connect แค่ `button-press-event` ไว้ที่ actor ตลอด (เบา, ไม่ reactive-heavy) แล้ว
  ค่อย connect สอง signal ที่เหลือที่ stage แบบชั่วคราวเฉพาะช่วงที่กำลังลากอยู่ แล้ว
  disconnect ทิ้งทันทีที่ปล่อยเมาส์ (หรือ `detach()` ถูกเรียกระหว่างลากค้าง)
- จำกัดไว้ที่ 1 drag ต่อครั้ง (`this._drag`, single pointer) — ถ้ามี `button-press-event`
  เข้ามาระหว่างที่กำลังลาก widget ตัวอื่นอยู่ จะถูก propagate ผ่านไปเฉยๆ ไม่ใช่ throw/แย่ง grab
- `monitorIndex` ที่ส่งเข้า `attach()` เป็นค่าคงที่ที่ widget โหลดมาตอน `enable()` (ไม่ได้คำนวณ
  ใหม่จาก physical monitor ที่ actor ลอยอยู่ตอนปล่อยเมาส์) — ตรงตาม "Out of scope" ด้านล่าง
  ที่บอกว่า multi-monitor เต็มรูปแบบเป็นงาน task 07 ถ้าลากข้ามจอจริงๆ ตำแหน่ง x/y จะยังถูก
  บันทึกถูกต้อง (สัมพัทธ์กับจอเดิม) แค่ `monitorIndex` ยังไม่อัปเดตตาม เป็น known-limitation
  ที่ตั้งใจทิ้งไว้ให้ task 07 แก้
- **ยังไม่ได้ทดสอบบน GNOME Shell/Clutter จริง** (container นี้ไม่มี Wayland/X11 session ให้รัน)
  — ต่างจาก `widgetSettings.js` ที่ไม่พึ่ง Clutter เลยเลยเขียน unit test รันจริงได้ ก่อน merge
  ควรลองมือบนเครื่องที่มี GNOME Shell 45+ จริงตาม checklist ใน `development/docs/WIDGET_API.md` §7
