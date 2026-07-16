# 08 — Hot Reload / Dev Mode

## Goal

ให้นักพัฒนา widget (รวมถึง AI ที่ทำ task 06/09) แก้ `widget.js` แล้วเห็นผลโดยไม่ต้อง
restart gnome-shell ทั้งก้อนทุกครั้ง — ลด friction ของ dev loop อย่างมาก

## Depends on

`01-widget-loader-core.md`, `02-widget-layer-rendering.md`

## Files to touch

- `products/extension/lib/devWatcher.js` (สร้างใหม่)
- `products/extension/lib/widgetLoader.js` (แก้เพิ่ม `reloadWidget(widgetId)`)
- `products/extension/schemas/....gschema.xml` (เพิ่ม key `dev-mode: boolean`)

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

## Notes from implementation

- `products/extension/lib/devWatcher.js`: watch **ต่อ widget** (ไม่ใช่ global watcher เดียว)
  ผ่าน `Gio.File.monitor_directory()` แบบ non-recursive ต่อโฟลเดอร์ — ตรงตาม flat folder
  layout ของ `WIDGET_API.md` §1 debounce 500ms ตามที่ระบุใน step 2 ทำแยกต่อ widget
  (`Map<widgetId, {monitor, signalId, timeoutId}>`) กัน widget A save รัว ๆ ไปสั่ง reload
  widget B โดยไม่ตั้งใจ
- `stop()` ยกเลิก `GLib.timeout_add` ที่ค้างอยู่ + `monitor.cancel()` ทุกตัวจริง ตรงตาม
  acceptance criteria ข้อ 3 ("ปิด dev-mode → ไม่กิน resource เปล่า ๆ")
- `products/extension/lib/widgetLoader.js` (`reloadWidget()`): cache-bust ด้วย query string
  `?t=${Date.now()}` ต่อท้าย import path ตามที่ Steps แนะนำไว้พอดี — ลำดับการสลับ instance
  จงใจทำ **new ก่อน old ค่อยถูกทำลาย**: import/construct/build actor ของตัวใหม่ให้สำเร็จก่อน
  ค่อย `disable()` ตัวเก่า+ทำลาย actor เดิม ถ้า import ตัวใหม่ throw (เช่น syntax error) จะ log
  error แล้ว `return null` โดยตัวเก่ายังรันอยู่ไม่ถูกแตะเลย —ตรงตาม acceptance criteria ข้อ 2
  ("syntax error → ไม่ทำให้ shell ค้าง, widget เดิมยังอยู่, มี error log ชัดเจน")
- gschema เพิ่ม key `dev-mode` (boolean) ใน
  `products/extension/schemas/org.gnome.shell.extensions.widget-center.gschema.xml` แล้วจริง —
  `extension.js` ผูก `DevWatcher` เข้ากับ `onChanged('dev-mode', ...)` และเช็คค่าตอน enable()
  ด้วย (เผื่อ dev-mode เปิดค้างจากรอบก่อนหน้า)
- **ช่องว่างที่พบ:** step 1 เสนอ "ตั้งผ่าน `gsettings set` **หรือ** toggle ซ่อนใน Control Center"
  — ตอนนี้มีแค่ทางแรก `products/extension/prefs.js` ยังไม่มี toggle ให้ dev-mode เลย (คาดว่าเพราะ
  task 05 — prefs control center — ยังเป็นแค่ Planned) ไม่ใช่ bug เพราะ Steps ใช้คำว่า "หรือ"
  ไว้แล้ว แต่ถ้า task 05 เริ่มทำควรเพิ่ม toggle นี้เข้าไปด้วย
- `node --check` ผ่านทั้ง `devWatcher.js`, `widgetLoader.js`, `extension.js` (syntax level เท่านั้น)
- **ยังไม่ยืนยันบนเครื่องจริง** เหมือน task 01-04, 07 — ทั้ง 3 acceptance criteria (เห็นผลใน ~1
  วินาทีจริง, syntax error ไม่ทำ shell ค้างจริงบนเครื่องจริง, resource ไม่รั่วตอนปิด) ต้อง
  ทดสอบบน GNOME Shell 45+ จริงก่อนติ๊กว่าผ่าน ไม่ติ๊ก checkbox ใน `development/tasks/ROADMAP.md`
  จนกว่าจะยืนยันแล้ว
