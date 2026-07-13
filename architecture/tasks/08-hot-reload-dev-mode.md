# 08 — Hot Reload / Dev Mode

## Goal

ให้นักพัฒนา widget (รวมถึง AI ที่ทำ task 06/09) แก้ `widget.js` แล้วเห็นผลโดยไม่ต้อง
restart gnome-shell ทั้งก้อนทุกครั้ง — ลด friction ของ dev loop อย่างมาก

## Depends on

`01-widget-loader-core.md`, `02-widget-layer-rendering.md`

## Files to touch

- `extension/lib/devWatcher.js` (สร้างใหม่)
- `extension/lib/widgetLoader.js` (แก้เพิ่ม `reloadWidget(widgetId)`)
- `extension/schemas/....gschema.xml` (เพิ่ม key `dev-mode: boolean`)

## Steps (แนะนำ)

1. เมื่อ `dev-mode` เปิดอยู่ (ตั้งผ่าน `gsettings set` หรือ toggle ซ่อนใน Control Center):
   ใช้ `Gio.File.monitor_directory()` เฝ้าดูโฟลเดอร์ widget ที่กำลัง dev อยู่
2. ไฟล์เปลี่ยน → debounce ~500ms แล้วเรียก `WidgetLoader.reloadWidget(widgetId)`:
   - `disable()` widget เดิม, ลบ actor เดิมออกจาก Widget Layer
   - dynamic import ใหม่ (ต้อง cache-bust เพราะ GJS module cache เดิมของไฟล์เดียวกัน —
     ใช้เทคนิค append query string `?t=timestamp` ใน import path หรือแนวทางอื่นที่ทดสอบแล้วได้ผลจริง)
   - โหลด instance ใหม่ วาง actor ใหม่ที่ตำแหน่งเดิม
3. Error ตอน reload (เช่น syntax error ใน widget.js ที่แก้ใหม่) → ห้ามทำให้ทั้ง shell ค้าง/crash
   ต้อง catch แล้วโชว์ widget เดิม (หรือ actor error-state) ค้างไว้พร้อม log ชัดเจน

## Acceptance criteria

- [ ] เปิด dev-mode, แก้สีพื้นหลังใน `widgets/clock/stylesheet.css` แล้วเซฟ → เห็นผลบนพื้นโต๊ะ
      ภายใน ~1 วินาที โดยไม่ต้อง restart shell
- [ ] แก้ `widget.js` ให้มี syntax error โดยตั้งใจ → ไม่ทำให้ gnome-shell ทั้งตัวค้าง/crash,
      มี error log ชัดเจนบอกว่า widget ไหนพังตรงไหน
- [ ] ปิด dev-mode → file watcher หยุดทำงาน ไม่กิน resource เปล่า ๆ ตอนใช้งานจริง (production)

## Out of scope

- Hot reload ของ `extension.js`/core เอง (ยังต้อง restart shell ตามปกติของ GNOME Shell
  extension ทั่วไป — นี่คือข้อจำกัดที่แก้ไม่ได้ในระดับ core)
