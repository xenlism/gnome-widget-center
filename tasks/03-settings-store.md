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
  `docs/SETTINGS_SPEC.md` หัวข้อ "Host-side: WidgetSettings class") — **ทำแล้ว**:
  `load(widgetId, storageService)` คืน Proxy auto-save (debounce 300ms ผ่าน
  `GLib.timeout_add`/`source_remove`), `applyDefaults(proxy, defaults)` backfill key ที่ขาด
  ผ่าน proxy เดิม (ดู "two-phase load" ด้านล่างว่าทำไมแยกเป็น 2 เมธอด), `flush()`/`flushAll()`
  สำหรับเขียนทันทีตอน disable() (ดู Notes from implementation)
- `extension/lib/storageService.js` — **ทำแล้ว**: เพิ่ม `_sanitizeWidgetId()`,
  `getWidgetPosition()`, `updateWidgetPosition()` ไว้ตั้งแต่รอบก่อน + **แก้เพิ่ม
  (2026-07-14)**: `getWidgetSettings()`/`saveWidgetSettings()` เดิมเขียนไฟล์เป็น
  `widget-<id>.json` ที่ root ของ storage dir ตรงๆ ซึ่งขัดกับ path ที่
  `docs/SETTINGS_SPEC.md` กำหนด (`widgets/<id>.json`) — แก้ให้สร้างโฟลเดอร์ย่อย `widgets/`
  ใน `init()` แล้วอ่าน/เขียนที่ `widgets/<id>.json` ตรงสเปกแล้ว
- `extension/schemas/org.gnome.shell.extensions.widget-center.gschema.xml` — **ทำแล้ว**
  (compile ด้วย `glib-compile-schemas extension/schemas/` ให้ `gschemas.compiled` อยู่ใน
  โฟลเดอร์เดียวกัน — ห้ามลืม re-compile ทุกครั้งที่แก้ `.gschema.xml`)
- `extension/lib/settingsService.js` — **ทำแล้ว**: แก้ให้ใช้ `Extension.getSettings()`
  แทน `Gio.SettingsSchemaSource.get_default()` (ของเดิม throw เสมอเพราะมองหาแค่ schema
  ที่ติดตั้งระดับระบบ — ดู `docs/SETTINGS_SPEC.md` "Host settings เอง")
- `extension/lib/widgetLoader.js` — **ทำแล้ว (2026-07-14)**: constructor รับ
  `storageService` เพิ่ม, `loadAll()` เรียก `WidgetSettings.load()` ก่อนสร้าง instance แล้ว
  เรียก `WidgetSettings.applyDefaults()` หลังสร้าง instance เสร็จ (แก้ปัญหาลำดับ
  constructor-ต้องมี-settings-ก่อน แต่ defaults มาจาก instance — ดู header comment ใน
  `widgetSettings.js`), `unloadAll()` เรียก `WidgetSettings.flushAll()` ก่อน cleanup
- `extension/extension.js` — **ทำแล้ว (2026-07-14)**: ส่ง `this._storage` เข้า
  `new WidgetLoader(...)` แทนเดิมที่ไม่ส่งอะไรเลย (`WidgetAPI.settings` ถูกสร้างจริงใน
  `widgetLoader.js._buildApi()` ไม่ใช่ตรงนี้ — ที่นี่แค่ต้อง thread storageService ผ่านไป)

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

- [x] Widget ตัวอย่าง (`_template`) เรียก `api.settings.someKey = value` แล้วไฟล์
      `~/.config/gnome-widget-center/widgets/<id>.json` ถูกเขียนจริงภายใน ~300ms
- [x] ลบไฟล์ settings ทิ้งแล้วโหลด widget ใหม่ → ไฟล์ถูกสร้างใหม่จาก `getDefaultSettings()`
- [x] แก้ไฟล์ settings มือ (ลบ key บางตัวออก) แล้ว reload → key ที่หายไปถูก merge กลับมาจาก defaults
      โดยไม่ทับค่าที่ผู้ใช้ตั้งไว้ใน key อื่น
- [x] ลอง set `widgetId` ที่มี `../` ปนอยู่ (จำลอง path traversal) → ต้องถูก sanitize/reject
      ไม่เขียนไฟล์นอก `~/.config/gnome-widget-center/widgets/`
- [x] widget สองตัวตั้งค่ากันคนละไฟล์ ไม่ชนกัน (ทดสอบพร้อมกัน 2 instance)

(เช็คแล้วด้วย unit test จำลอง `GLib`/`StorageService` ใน Node — ครอบคลุมทั้ง 5 ข้อข้างต้น
รวมถึง debounce-collapse, `flush()`/`flushAll()` แต่**ยังไม่ได้รันบน GNOME Shell จริง**
เหมือนกับ task 01/02 — ดู note เดียวกันใน ROADMAP.md)

## Out of scope

- DBus, SQLite — ไม่ใช้ในโปรเจกต์นี้ (ดูหมายเหตุด้านบน)
- Binding UI (`Gio.Settings.bind()`-style) สำหรับหน้า prefs — อยู่ใน task 05
- Export/Import เป็น theme file รวมหลาย widget เข้าด้วยกัน — แยกเป็น task ใหม่
  `11-theme-backup-restore.md` เพราะ scope ต่างกัน (task นี้ทำแค่ต่อ widget เดียว)

## Notes from implementation

**สถานะ (2026-07-14): เสร็จ** — `widgetSettings.js` สร้างแล้ว เชื่อมกับ `widgetLoader.js`/
`extension.js` ครบ และแก้ path bug ใน `storageService.js` ที่ค้างจากรอบก่อนด้วย
(รายละเอียด "ยังไม่ได้ทำ" ท้ายไฟล์นี้ล้าสมัยแล้ว)

**เพิ่มเติมจากที่ spec ระบุไว้ตรงๆ (ตัดสินใจระหว่างimplement):**

1. **Two-phase load แทน `load(widgetId, defaults)` ตัวเดียวตามที่ spec เขียนไว้** — เจอปัญหา
   ลำดับจริง: `api.settings` ต้องมีอยู่ก่อน widget constructor รัน (`this._settings =
   api.settings` ตาม `docs/WIDGET_API.md` §3) แต่ defaults มาจาก
   `instance.getDefaultSettings()` ซึ่งต้องมี instance ก่อนถึงเรียกได้ — แก้เป็น
   `WidgetSettings.load(widgetId, storageService)` (ไม่รับ defaults, คืน proxy จากของที่มีอยู่
   ในไฟล์ก่อน) แล้วเรียก `WidgetSettings.applyDefaults(proxy, defaults)` แยกหลังสร้าง instance
   เสร็จ — เขียนผ่าน proxy ตัวเดิม (object identity ไม่เปลี่ยน) ให้ widget ที่ capture
   reference ไว้ตั้งแต่ constructor ยังใช้งานได้ปกติ
2. **เพิ่ม `flush()`/`flushAll()`** ที่ spec ไม่ได้ระบุไว้ตรงๆ — ป้องกันกรณี debounce 300ms
   ยังไม่ทันเขียนไฟล์ตอน `disable()` ถูกเรียก (ค่าที่เพิ่ง set จะหายไปเฉยๆ ถ้าไม่ flush)
   เรียกจาก `widgetLoader.js unloadAll()` ก่อนเริ่ม cleanup instance ใดๆ

---

*(เก็บ note เดิมของรอบก่อนไว้ด้านล่างเพื่อ context — ตอนนั้นแก้แค่ prerequisite bug 2 ตัว
ที่บล็อก task นี้ ยังไม่ได้เริ่มตัว `widgetSettings.js` เอง)*

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
