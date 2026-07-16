# 07 — Multi-Monitor Support

## Goal

รองรับหลายจอ: widget ต้องอยู่จอที่กำหนดไว้ถูกต้อง, ตอบสนองเมื่อถอด/เสียบจอใหม่หรือเปลี่ยน
ความละเอียด/scale โดยไม่ตำแหน่งเพี้ยนหรือ widget หายไปนอกจอ

## Depends on

`02-widget-layer-rendering.md`

*ทำขนานกับ `04-drag-reposition.md` ได้ แต่ต้อง sync coordinate system กัน — แนะนำให้ตกลง
กันก่อนว่าตำแหน่ง widget เก็บเป็น "สัมพัทธ์กับจอ" (monitor-relative) เสมอ ไม่ใช่ absolute
พิกัดรวมทุกจอ เพื่อกันปัญหาจอสลับลำดับ*

## Files to touch

- `products/extension/lib/widgetLayer.js` (แก้ให้มี container ต่อจอจริง ไม่ hardcode จอเดียว)
- `products/extension/lib/monitorWatcher.js` (สร้างใหม่ — wrap `Main.layoutManager.monitors-changed`)

## Steps (แนะนำ)

1. `MonitorWatcher` connect `Main.layoutManager.connect('monitors-changed', cb)`
2. เมื่อจอเปลี่ยน (เพิ่ม/ลด/สลับลำดับ):
   - widget ที่เคยอยู่จอที่หายไป → ย้ายไปจอหลัก (primary monitor) ชั่วคราว ไม่ทำให้ widget
     หายไปเฉย ๆ โดยไม่มีทางเรียกคืน
   - widget ที่ตำแหน่งเดิมเกินขอบจอใหม่ (เช่นจอเล็กลง) → clamp กลับเข้ามาในขอบจอ
3. ทดสอบกับ scale factor ต่างกัน (เช่นจอ HiDPI 200% + จอปกติ 100%) → ขนาด widget/ตำแหน่ง
   ต้องคำนวณด้วย `monitor.geometry-scale` ให้ถูกต้อง ไม่เบี้ยว

## Acceptance criteria

- [ ] ถอดจอรอง (จำลองด้วย `xrandr`/การตั้งค่าจอใน GNOME Settings) ขณะ widget อยู่จอนั้น
      → widget ย้ายมาจอหลักอัตโนมัติ ไม่หายไปเงียบ ๆ
- [ ] เสียบจอเดิมกลับ → widget ไม่ถูกบังคับย้ายกลับอัตโนมัติ (ผู้ใช้ลากคืนเองได้ผ่าน task 04)
      หรือถ้าจำตำแหน่งเดิมคืนได้ก็ทำได้ — เลือกพฤติกรรมแล้วบันทึกเหตุผลไว้
- [ ] ทดสอบ HiDPI + จอปกติพร้อมกัน → widget ไม่เบลอ/ไม่เพี้ยนขนาดผิดปกติ

## Out of scope

- UI ให้ผู้ใช้เลือก assign widget ไปจอไหนด้วยตัวเอง (ทำผ่านการลากด้วย task 04 ก็พอสำหรับ MVP)

## Notes from implementation

- `products/extension/lib/monitorWatcher.js`: thin wrapper รอบ
  `Main.layoutManager`'s `monitors-changed` signal ตามที่ระบุใน step 1 —
  `getMonitors()` normalize เป็น plain object list พร้อม `index/x/y/width/height/scale/isPrimary`,
  index ตรงกับ index ของ `Main.layoutManager.monitors` เอง (ไม่ remap) เพื่อให้ตรงกับที่
  WidgetLayer/StorageService/DragController ใช้อ้างอิงกันอยู่แล้ว `scale` อ่านจาก
  `monitor.geometryScale` พร้อม fallback เป็น `1` ถ้า property ไม่มี (เผื่อ setup ที่ไม่มี
  hardware scaling)
- `products/extension/lib/widgetLayer.js` (`reconcileMonitors()`): ตาม acceptance criteria ข้อ 1
  — widget ที่อยู่บนจอที่หายไปจะถูกย้ายไป primary monitor เสมอ (ไม่หายเงียบ ๆ) และตำแหน่งใหม่
  ถูก persist ผ่าน `StorageService.updateWidgetPosition()` ทันที ไม่รอ save รอบถัดไป —
  ป้องกันกรณี shell restart ก่อนผู้ใช้ลากกลับ ตำแหน่งเดิมจะหายไปด้วย
- **ตัดสินใจสำหรับ acceptance criteria ข้อ 2** (เสียบจอเดิมกลับ): เลือกพฤติกรรม "ไม่ auto-restore"
  — โค้ดจงใจไม่เก็บ mapping ว่า widget เคยอยู่จอไหนก่อนถูกย้าย เหตุผลตามที่ระบุใน docstring ของ
  `reconcileMonitors()`: กันปัญหาแย่งตำแหน่งกับผู้ใช้ที่อาจลาก widget ไปที่อื่นแล้วระหว่างนั้น
  ผู้ใช้ต้องลากคืนเองผ่าน task 04
- ตำแหน่ง widget เก็บเป็นพิกัด**สัมพัทธ์กับ container ของจอนั้น** (container วางที่ `monitor.x,
  monitor.y` แล้ว widget actor อยู่ใน local coordinate ของ container) ตรงตามที่ตกลงไว้ใน
  "Depends on" ด้านบน — ไม่ใช่ absolute พิกัดรวมทุกจอ
- `_clampToMonitor()` clamp เฉพาะจุด origin (x, y) ของ widget ไม่รู้ขนาดจริงของ widget actor
  (WidgetLayer ไม่ยุ่งกับ internals ของ widget) — เพียงพอสำหรับ acceptance criteria ("ไม่หายไป
  นอกจอ/ยังลากถึง") แต่ไม่ได้การันตีว่า widget ทั้งก้อนจะอยู่ในขอบจอ 100% ถ้า widget มีขนาดใหญ่
  กว่าจอมาก — ถือว่ายอมรับได้สำหรับ MVP ตาม scope เดิม
- `node --check` ผ่านทั้ง `monitorWatcher.js` และ `widgetLayer.js` (syntax level เท่านั้น)
- **ยังไม่ยืนยันบนเครื่องจริง** เหมือน task 01-04 ก่อนหน้า — ไม่มี GNOME Shell จริงในสภาพแวดล้อม
  ที่ implement/ตรวจสอบไฟล์นี้ ทั้ง 3 acceptance criteria (ถอด/เสียบจอผ่าน `xrandr`, HiDPI +
  จอปกติพร้อมกัน) ต้องทดสอบบนเครื่องที่มี GNOME Shell 45+ ก่อนติ๊กว่าผ่าน ไม่ติ๊ก checkbox ใน
  `development/tasks/ROADMAP.md` จนกว่าจะยืนยันแล้ว
