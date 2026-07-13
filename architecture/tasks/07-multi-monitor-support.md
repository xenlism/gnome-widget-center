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

- `extension/lib/widgetLayer.js` (แก้ให้มี container ต่อจอจริง ไม่ hardcode จอเดียว)
- `extension/lib/monitorWatcher.js` (สร้างใหม่ — wrap `Main.layoutManager.monitors-changed`)

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
