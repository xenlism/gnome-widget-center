# Task 03 — Settings Store

## Goal

ให้แต่ละ widget มี settings ของตัวเอง อ่าน/เขียนแยกจากกันเด็ดขาด โดย host จัดการไฟล์ให้ทั้งหมด
(widget ไม่ยุ่งกับ filesystem เอง) ตามที่ตัดสินใจไว้ใน `docs/ARCHITECTURE.md` §2.3 และ
`docs/SETTINGS_SPEC.md`

**หมายเหตุ (แก้ไข 2026-07-13):** เวอร์ชันก่อนหน้าของไฟล์นี้เขียนผิดพลาดว่าให้ใช้ DBus +
SQLite service แยกโปรเซส ซึ่ง**ขัดกับ `docs/ARCHITECTURE.md`/`docs/SETTINGS_SPEC.md` โดยตรง**
(ดูเหตุผลเต็มใน `docs/SETTINGS_SPEC.md` หัวข้อ "ทำไมไม่ใช้ GSettings สำหรับ widget" — หลักการ
เดียวกันใช้ปฏิเสธ SQLite service กลางด้วย เพราะย้อนกลับไปมีปัญหา "third-party widget ติดตั้งเพิ่ม
โดยไม่แตะ core ไม่ได้" แบบเดียวกัน) แก้กลับมาให้ตรงกับสถาปัตยกรรมจริงแล้ว

## Depends on

`01-widget-loader-core.md`

## Context

อ่าน `docs/SETTINGS_SPEC.md` ทั้งไฟล์ก่อนเริ่ม — เป็นสเปกเดียวที่ต้องอ้างอิงสำหรับ task นี้

สรุปสั้น:
- ไฟล์ settings ต่อ widget: `~/.config/gnome-widget-center/widgets/<widget-id>.json`
- Host-level settings (widget ไหน enable อยู่ ฯลฯ): `~/.config/gnome-widget-center/host.json`
  หรือ GSettings ของ core เองก็ได้ (`extension/schemas/....gschema.xml`) — เป็นของ core ไม่ใช่
  third-party จึง compile schema ได้โดยไม่ขัดหลักการ
- **ไม่มี** DBus service, **ไม่มี** SQLite — อ่าน/เขียนไฟล์ตรงในตัว extension เอง ผ่าน `Gio`/`GLib`

โค้ดฐานที่มีอยู่แล้วจาก task ก่อนหน้า (ให้ต่อยอด ไม่ใช่เขียนใหม่ทั้งหมด):
- `extension/lib/storageService.js` — มี `getWidgetSettings`/`saveWidgetSettings` แบบ synchronous
  อยู่แล้ว แต่ยังไม่มี default-merge, ไม่มี debounce, ไม่มี proxy auto-save, ไม่มี path sanitize
- `extension/lib/settingsService.js` — จัดการเฉพาะ GSettings ของ host เอง (ของเดิมถูกต้องแล้ว
  ตามหลักการ ไม่ต้องแก้ในทีนี้ นอกจากเชื่อมกับ `widgetSettings.js` ใหม่)

## Files to touch

- `extension/lib/widgetSettings.js` (สร้างใหม่ — ตาม class `WidgetSettings` ที่ระบุใน
  `docs/SETTINGS_SPEC.md` หัวข้อ "Host-side: WidgetSettings class") — **ยังไม่ได้ทำ**
- `extension/lib/storageService.js` — **ทำแล้ว**: เพิ่ม `_sanitizeWidgetId()`,
  `getWidgetPosition()`, `updateWidgetPosition()`, ใช้ sanitize ใน
  `getWidgetSettings()`/`saveWidgetSettings()` ครบแล้ว (ดู Notes from implementation)
- `extension/schemas/org.gnome.shell.extensions.widget-center.gschema.xml` — **ทำแล้ว**
  (compile ด้วย `glib-compile-schemas extension/schemas/` ให้ `gschemas.compiled` อยู่ใน
  โฟลเดอร์เดียวกัน — ห้ามลืม re-compile ทุกครั้งที่แก้ `.gschema.xml`)
- `extension/lib/settingsService.js` — **ทำแล้ว**: แก้ให้ใช้ `Extension.getSettings()`
  แทน `Gio.SettingsSchemaSource.get_default()` (ของเดิม throw เสมอเพราะมองหาแค่ schema
  ที่ติดตั้งระดับระบบ — ดู `docs/SETTINGS_SPEC.md` "Host settings เอง")
- `extension/extension.js` (แก้จุดที่สร้าง `WidgetAPI` ให้ส่ง `settings` จาก
  `WidgetSettings.load()` แทนของเดิม — **ยังไม่ได้ทำ**, รอ `widgetSettings.js`)

## Steps (แนะนำ)

1. `WidgetSettings.load(widgetId, defaults)`:
   - sanitize `widgetId` ก่อนสร้าง path เสมอ (กัน path traversal เช่น `../../etc`)
   - อ่านไฟล์ ถ้าไม่มีให้สร้างจาก `defaults` (จาก `widget.getDefaultSettings()`)
   - merge key ที่ขาดหายจาก `defaults` เข้าไปใน object ที่อ่านได้ (กันกรณี widget เวอร์ชันใหม่
     เพิ่ม key ใหม่ทีหลัง)
2. คืนค่าเป็น object แบบ Proxy ที่ auto-save ลงไฟล์ทุกครั้งที่มีการ set ค่า — debounce ~300ms
   (ใช้ `GLib.timeout_add` แล้ว cancel/reset ทุกครั้งที่มีการ set ใหม่ระหว่างรอ)
3. `_schemaVersion` เก็บไว้ในไฟล์เสมอ ให้ widget author ใช้ทำ migration เองได้ถ้าโครงสร้าง
   settings เปลี่ยนแบบ breaking (host แค่เก็บ/คืนค่า ไม่ validate เนื้อหาข้างใน)
4. เชื่อมกับ `extension.js`: ตอนโหลด widget แต่ละตัว เรียก
   `WidgetSettings.load(widget.id, instance.getDefaultSettings())` แล้วส่งผลลัพธ์เป็น
   `api.settings` เข้า constructor ของ widget (อ้างอิง data flow ใน `docs/ARCHITECTURE.md` §4)

## Acceptance criteria

- [ ] Widget ตัวอย่าง (`_template`) เรียก `api.settings.someKey = value` แล้วไฟล์
      `~/.config/gnome-widget-center/widgets/<id>.json` ถูกเขียนจริงภายใน ~300ms
- [ ] ลบไฟล์ settings ทิ้งแล้วโหลด widget ใหม่ → ไฟล์ถูกสร้างใหม่จาก `getDefaultSettings()`
- [ ] แก้ไฟล์ settings มือ (ลบ key บางตัวออก) แล้ว reload → key ที่หายไปถูก merge กลับมาจาก defaults
      โดยไม่ทับค่าที่ผู้ใช้ตั้งไว้ใน key อื่น
- [ ] ลอง set `widgetId` ที่มี `../` ปนอยู่ (จำลอง path traversal) → ต้องถูก sanitize/reject
      ไม่เขียนไฟล์นอก `~/.config/gnome-widget-center/widgets/`
- [ ] widget สองตัวตั้งค่ากันคนละไฟล์ ไม่ชนกัน (ทดสอบพร้อมกัน 2 instance)

## Out of scope

- DBus, SQLite — ไม่ใช้ในโปรเจกต์นี้ (ดูหมายเหตุด้านบน)
- Binding UI (`Gio.Settings.bind()`-style) สำหรับหน้า prefs — อยู่ใน task 05
- Export/Import เป็น theme file รวมหลาย widget เข้าด้วยกัน — แยกเป็น task ใหม่
  `11-theme-backup-restore.md` เพราะ scope ต่างกัน (task นี้ทำแค่ต่อ widget เดียว)

## Notes from implementation

**สถานะ (2026-07-13): แก้ prerequisite bug 2 ตัวที่จะบล็อก task นี้ทั้งหมด — `widgetSettings.js`
เอง (งานหลักของ task) ยังไม่ได้เริ่ม**

1. **`settingsService.js` เดิม throw เสมอตอน `init()`** — เรียก
   `Gio.SettingsSchemaSource.get_default().lookup()` ซึ่งมองหาแค่ schema ที่ compile ติดตั้ง
   ระดับระบบ (`/usr/share/glib-2.0/schemas`) แต่ในโปรเจกต์ไม่เคยมีการติดตั้งระดับระบบเลย (และ
   ไม่ควรมีตามเป้าหมายโปรเจกต์) — ไม่เคยมีไฟล์ `.gschema.xml`/`extension/schemas/` อยู่ด้วยซ้ำ
   แก้โดย: (a) สร้าง `extension/schemas/org.gnome.shell.extensions.widget-center.gschema.xml`
   + compile เป็น `gschemas.compiled` ไว้ในโฟลเดอร์เดียวกัน (b) แก้ `settingsService.js` ให้รับ
   `Extension` instance (`this` จาก `enable()`) แล้วเรียก `extensionObject.getSettings(schemaId)`
   แทน — เมธอดนี้ resolve schema จากโฟลเดอร์ของ extension เองโดยตรง ไม่แตะ system schema dir
2. **`storageService.js` ไม่มี path sanitize เลย** — `getWidgetSettings(instanceId)` เดิม
   เอา `instanceId` ไปต่อ path ตรงๆ แก้โดยเพิ่ม `_sanitizeWidgetId()` (whitelist
   `[a-zA-Z0-9._-]`, reject ค่าว่าง/`.`/`..`) ใช้ครบทั้ง `getWidgetSettings`,
   `saveWidgetSettings`, และ method ใหม่ `getWidgetPosition`/`updateWidgetPosition` (เพิ่มเผื่อ
   task 04 ใช้ read-modify-write ตำแหน่งเดียวโดยไม่ชนตำแหน่ง widget อื่น)

**ยังไม่ได้ทำ (งานหลักของ task นี้):**
- `extension/lib/widgetSettings.js` — class `WidgetSettings` ตาม `SETTINGS_SPEC.md` (load +
  default-merge + Proxy auto-save debounce)
- เชื่อม `extension.js` ให้ส่ง `WidgetSettings.load()` เป็น `api.settings` แทน stub
  `{}` ปัจจุบันใน `widgetLoader.js._buildStubApi()`
