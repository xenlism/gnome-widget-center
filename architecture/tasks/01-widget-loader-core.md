# 01 — Widget Loader (core discovery/loading system)

## Goal

สร้างระบบที่ scan โฟลเดอร์ widget สองที่ (bundled + user-installed), อ่าน `metadata.json`,
validate, แล้ว dynamic-import `widget.js` ของแต่ละตัว — โดยที่ core ไม่รู้จัก widget ตัวไหนล่วงหน้าเลย

## Depends on

`00-project-setup.md` (ต้องรู้วิธี insert actor ที่ถูกต้องแล้ว)

## Context

อ่าน `docs/WIDGET_API.md` ทั้งหมด — ไฟล์นี้คือสัญญาที่ `widgetLoader.js` ต้อง enforce

Path ที่ต้อง scan:
```
<extension-dir>/widgets/*/metadata.json
~/.local/share/gnome-widget-center/widgets/*/metadata.json
```

## Files to touch

- `extension/lib/widgetLoader.js` (สร้างใหม่)
- `extension/extension.js` (แก้ให้เรียกใช้ loader ตอน enable/disable)
- `widgets/_template/` (สร้าง widget เปล่า ๆ ไว้ทดสอบ loader — ยังไม่ต้องมี UI จริง)

## Steps (แนะนำ)

1. `widgetLoader.js` export ฟังก์ชัน/คลาส `WidgetLoader` ที่มี:
   - `discover()` → คืน array ของ `{ id, metadata, path }` หลัง validate metadata.json
     (เช็ค required fields, เช็ค `id` ไม่ชนกัน — ถ้าชนให้ log warning แล้ว skip ตัวหลัง)
   - `loadModule(widgetInfo)` → `import()` แบบ dynamic (ใช้ `file://` URI ของ `widget.js`)
     คืน default export class, ครอบด้วย try/catch — 1 widget พังห้ามทำให้ทั้ง extension พัง
   - `unloadAll()` → เรียก `disable()` ของทุก instance แล้วเคลียร์ reference ทั้งหมด
2. เก็บ error ของแต่ละ widget ที่โหลดไม่ผ่านไว้ใน array แยก (เอาไปโชว์ใน Control Center
   ใน task 05 ภายหลัง — ไม่ต้องทำ UI ตอนนี้ แค่เก็บ log ไว้พอ)
3. `extension.js` เรียก `WidgetLoader.discover()` + `loadModule()` ทีละตัวตอน `enable()`,
   เรียก `unloadAll()` ตอน `disable()`
4. `widgets/_template/` ให้มี `metadata.json` + `widget.js` ที่ implement ครบตาม WIDGET_API.md
   แต่ `buildActor()` คืนแค่ `St.Label({text: 'template widget'})` พอ — ใช้เทส pipeline เฉย ๆ

## Acceptance criteria

- [ ] วาง widget ใหม่ (copy จาก `_template`) ในโฟลเดอร์ user-installed แล้ว rescan โดย**ไม่แก้ไฟล์ใน
      `extension/` เลยสักบรรทัด** widget ใหม่ถูกโหลดขึ้นมา
- [ ] ลบ `metadata.json` ของ widget หนึ่งตัวทิ้ง (จำลอง broken widget) → extension ยัง enable
      ได้ปกติ widget อื่นไม่ได้รับผลกระทบ, มี log บอกว่า widget ไหนโหลดไม่ผ่านเพราะอะไร
   - [ ] widget สอง id ชื่อซ้ำกัน → ตัวที่สองถูก skip พร้อม log เตือน ไม่ crash
- [ ] `disable()` extension แล้ว widget ทุกตัวถูก unload สะอาด (เทียบกับ acceptance ของ task 00)

## Out of scope

- ยังไม่ต้องทำ Widget Layer จริง (task 02) — `buildActor()` ตอนนี้ยังไม่ต้อง add เข้า stage จริง
  ก็ได้ แค่เรียกได้โดยไม่ throw ก็พอสำหรับ task นี้
- ยังไม่ต้องทำ settings (task 03) — ส่ง `api.settings` เป็น plain object ว่าง ๆ ไปก่อนได้

## Notes from implementation

**สถานะ: โค้ดเขียนเสร็จ + ผ่าน logic test ด้วย mock, ยังไม่ได้รันบน GNOME Shell จริง**

เหมือน task 00: ไม่มี GNOME Shell session จริงให้รันในสภาพแวดล้อมที่เขียนโค้ดนี้ ครั้งนี้เลย
เขียน test harness แยก จำลอง `Gio`/`GLib`/`St` ด้วย Node.js module loader hook (ไม่ได้แก้
`widgetLoader.js` เพื่อให้ test ผ่านเลย — import ไฟล์จริงตรง ๆ) แล้วสร้าง fixture โฟลเดอร์ widget
จำลอง 3 เคสตาม acceptance criteria:

1. widget ปกติ 1 ตัว (`template-widget`, id `template-widget`)
2. widget id ซ้ำ (`template-widget-copy`, ประกาศ id `template-widget` เหมือนกัน)
3. widget ที่ไม่มี `metadata.json` เลย (`broken-widget`)

**ผ่านทั้งหมด:**
- `discover()` เจอ widget ที่ถูกต้อง 1 ตัวเท่านั้น
- widget ซ้ำ id ถูก skip พร้อม error `duplicate widget id, already loaded from ...`
- widget ที่ไม่มี metadata ถูก skip พร้อม error `invalid metadata.json: metadata.json not found`
- `loadAll()` dynamic-import + instantiate + `buildActor()` widget ที่ถูกต้องสำเร็จ
- `unloadAll()` เคลียร์ instance ครบ และเรียกซ้ำ (empty) ได้โดยไม่ error

**ยังไม่ยืนยัน (ต้องทดสอบบนเครื่องจริงเหมือน task 00):**
- Acceptance criteria ข้อแรก ("วาง widget ใหม่ใน user-installed แล้ว rescan โดยไม่แก้ไฟล์
  `extension/`") — logic รองรับอยู่แล้ว (path `~/.local/share/gnome-widget-center/widgets/`
  ถูก scan ทุกครั้งที่ `enable()`) แต่ยังไม่เคยรันจริงผ่าน `gnome-extensions` บน Wayland
- พฤติกรรมตอน `disable()` ถูกเรียกกลางคันระหว่าง `loadAll()` ยังทำงาน (การจัดการ race ด้วย
  flag `cancelled` ใน `extension.js`) — เขียนตามหลักการมาตรฐานของ GNOME extension async
  enable/disable แต่ยังไม่เคย trigger สถานการณ์นี้จริงบนเครื่อง (ต้องลอง toggle
  enable/disable รัว ๆ ใน Extensions app ใกล้ ๆ กันดู)

**ต้องทำต่อ (คนที่มีเครื่อง GNOME 50 จริง):**
1. คัดลอก `extension/*` ทับของเดิมที่ `~/.local/share/gnome-shell/extensions/gnome-widget-center@local.dev/`
2. คัดลอกโฟลเดอร์ `widgets/_template/` ไปเป็น
   `~/.local/share/gnome-widget-center/widgets/my-test-widget/` (จำลอง user-installed widget)
   แล้วแก้ `id` ใน `metadata.json` ให้ไม่ชนกับตัวที่ bundle มาด้วย `extension/widgets/` (ถ้ามี)
3. Reload shell แล้วเช็ค `journalctl --user -f -o cat /usr/bin/gnome-shell` ว่ามีบรรทัด
   `[widget-loader] loaded "my-test-widget" from ...`
4. ลองลบ `metadata.json` ของ widget หนึ่งตัวทิ้ง reload ใหม่ → widget อื่นต้องยังโหลดได้ปกติ
   พร้อม log บอกว่าตัวไหนพังเพราะอะไร
5. เติมผลจริงตรงนี้ แล้ว tick `- [x]` ที่ `tasks/ROADMAP.md`
