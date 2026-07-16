# SETTINGS_SPEC.md

## เป้าหมาย

แต่ละ widget ต้องมี settings ของตัวเอง แยกขาดจากกัน โดย**ไม่ต้อง**:
- compile GSettings schema ติดตั้งระดับระบบ (`/usr/share/glib-2.0/schemas`)
- แก้ไฟล์ schema ของ core

## รูปแบบไฟล์

```
~/.config/gnome-widget-center/
├── layout.json                    # ตำแหน่ง x/y/monitor ของ widget ทุกตัว (host-owned)
└── widgets/
    ├── clock.json
    ├── my-widget.json
    └── ...
```

**หมายเหตุ (แก้ไข 2026-07-13):** เวอร์ชันก่อนหน้าของไฟล์นี้วาด diagram มี `host.json`
แต่ข้อความท่อนล่างกลับบอกว่า host settings "ใช้ GSettings ปกติได้" — สองท่อนขัดกันเอง และ
ไม่เคยมีโค้ดไหนสร้างไฟล์ `host.json` จริง เลือกทางเดียวชัดเจนแล้ว: **host-level settings
(เช่น รายชื่อ widget ที่ถูกปิด, dev-mode) ใช้ GSettings เท่านั้น** compile ไว้ใน
`products/extension/schemas/` ของ core เอง (ดู "Host settings เอง" ด้านล่าง) — ไม่มีไฟล์ `host.json`
ตำแหน่ง (layout) ยังเป็น JSON (`layout.json`) เหมือนเดิม เพราะเป็นข้อมูลที่ต้องอ่านบ่อย/เขียน
ระหว่างลาก (task 04) ซึ่ง JSON file ธรรมดาเหมาะกว่า GSettings/dconf สำหรับ pattern นี้

ตัวอย่าง `widgets/clock.json`:

```json
{
  "_schemaVersion": 1,
  "format24h": true,
  "showSeconds": false,
  "fontSize": 32
}
```

## Host-side: `WidgetSettings` class (`products/extension/lib/widgetSettings.js`)

รับผิดชอบ:

1. `load(widgetId, defaults)` — อ่านไฟล์ ถ้าไม่มีให้สร้างจาก `defaults`
   (มาจาก `widget.getDefaultSettings()`), merge key ที่ขาดหายจาก defaults เข้าไป
   (กันกรณี widget เวอร์ชันใหม่เพิ่ม key ใหม่)
2. คืน object แบบ **proxy**ที่ auto-save ลงไฟล์ทุกครั้งที่มีการ set ค่า (debounce ~300ms กันเขียนถี่เกิน)
3. `_schemaVersion` ให้ widget author ใช้ทำ migration เองได้ถ้าโครงสร้าง settings เปลี่ยนแบบ breaking
4. Path ต้องถูก sanitize จาก `widgetId` เสมอ (กัน path traversal เช่น `../../etc`)

## ทำไมไม่ใช้ GSettings สำหรับ widget

| | GSettings (schema ต้อง compile ระบบ) | JSON file (แนวทางที่เลือก) |
|---|---|---|
| ติดตั้งเพิ่มโดยไม่แตะ core | ❌ ต้อง `glib-compile-schemas` ใหม่ทุกครั้งที่เพิ่ม widget | ✅ วางไฟล์แล้วใช้ได้เลย |
| สิทธิ์ที่ต้องใช้ | อาจต้อง root ถ้าติดตั้งระดับระบบ | ไม่ต้อง (เขียนใน `~/.config`) |
| Type safety / schema validation | มีในตัว | ต้องทำเอง (เพิ่ม validate เบื้องต้นใน `widgetSettings.js`) |
| Binding UI (Gtk) อัตโนมัติ | มี `Gio.Settings.bind()` | ต้องเขียน getter/setter binding เอง (เพิ่มใน task 05) |

สรุป: ยอมแลก convenience ของ `Gio.Settings.bind()` เพื่อแลกกับ "เพิ่ม widget ได้โดยไม่ต้อง
ติดตั้งอะไรเพิ่มระดับระบบ" ซึ่งเป็นเงื่อนไขบังคับของโปรเจกต์นี้

## Host settings เอง ใช้ GSettings — compile ไว้ใน extension เอง ไม่ใช่ระบบ

เพราะเป็นส่วนของ core ที่เรา build/compile เองตอน install extension อยู่แล้ว ไม่ผูกกับ
third-party widget — schema เดียว `products/extension/schemas/org.gnome.shell.extensions.widget-center.gschema.xml`

**สำคัญ:** compile ด้วย `glib-compile-schemas extension/schemas/` แล้วให้
`gschemas.compiled` อยู่**ในโฟลเดอร์ extension เอง** (ไม่ใช่
`/usr/share/glib-2.0/schemas` ของระบบ) แล้วโหลดผ่าน `Extension.getSettings(schemaId)`
(built-in ของ GNOME Shell 45+ extension base class) ซึ่ง resolve schema จากโฟลเดอร์ของ
extension เองโดยตรง — **ห้าม** ใช้ `Gio.SettingsSchemaSource.get_default()` เพราะ method
นั้นมองหาแค่ schema ที่ติดตั้งระดับระบบเท่านั้น จะหา schema ของเราไม่เจอเสมอ (ดู
`products/extension/lib/settingsService.js` สำหรับตัวอย่างที่ถูกต้อง)
