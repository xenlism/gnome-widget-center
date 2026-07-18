# 05 — Control Center (Prefs GUI)

## Goal

หน้าจอ GTK4/Libadwaita ที่:
1. แสดงรายชื่อ widget ทั้งหมดที่ discover เจอ (ทั้ง bundled และ user-installed)
2. เปิด/ปิดใช้งานแต่ละตัวได้ (toggle)
3. กด "Settings" ของ widget ใดตัวหนึ่ง → โหลด `prefs.js` ของ widget นั้นมาแสดงเป็นหน้าย่อย
4. โชว์ error ของ widget ที่โหลดไม่ผ่าน (เก็บไว้จาก task 01)

## Depends on

`01-widget-loader-core.md`, `03-settings-store.md`

## Files to touch

- `products/extension/prefs.js` (สร้าง/แก้ — entrypoint ของ prefs process)
- `products/extension/lib/prefsWidgetList.js` (สร้างใหม่ — logic แยกจาก UI marshalling)
- `products/extension/lib/settingsSchema.js` (สร้างใหม่ 2026-07-18 — validate + extract defaults
  ของ declarative `settings` schema, pure JS ใช้ได้ทั้งสอง process)
- `products/extension/lib/settingsSchemaUI.js` (สร้างใหม่ 2026-07-18 — build `Adw.PreferencesPage`
  จาก schema, prefs process เท่านั้น)
- `products/extension/lib/widgetLoader.js` (แก้ 2026-07-18 — validate schema ใน `discover()`,
  merge schema defaults เข้ากับ `getDefaultSettings()` ใน `loadOne()`/`reloadWidget()`)

## Steps (แนะนำ)

1. `prefs.js` ต้อง**ไม่ import St/Clutter/Meta/Shell เด็ดขาด** (คนละ process กับ `extension.js`
   ตามกฎ GNOME Shell — ดู `development/docs/WIDGET_API.md` §4)
2. เรียก `WidgetLoader.discover()` แบบ read-only (ไม่ต้อง `loadModule` ตัว `widget.js` เพราะนั่นใช้
   St ซึ่งใช้ใน prefs process ไม่ได้ — แค่ต้องการ metadata สำหรับ list)
3. แสดง list ด้วย `Adw.PreferencesGroup` + `Adw.SwitchRow` ต่อ widget หนึ่งแถว
4. กด "Settings" → dynamic import เฉพาะ `prefs.js` ของ widget นั้น (ไฟล์นี้ปลอดภัยที่จะ import
   ใน process ของ prefs เพราะ widget author เขียนแยกจาก `widget.js` อยู่แล้วตามสเปก)
   ส่ง `WidgetSettings` handle ของ widget นั้นเข้าไปให้ (จาก task 03) แล้ว embed
   `buildPrefsWidget()` ผลลัพธ์ลงใน stack/navigation view
5. Widget ที่ไม่มี `prefs.js` → ปุ่ม "Settings" ไม่โชว์ หรือ disabled
6. Widget ที่โหลดไม่ผ่าน (จาก error log ของ task 01) → โชว้แถวสีแดง/ไอคอนเตือน พร้อมข้อความ error

## Acceptance criteria

- [ ] เปิด Control Center เห็น widget ทุกตัวที่มีในทั้งสองโฟลเดอร์ (bundled + user)
- [ ] Toggle ปิด widget → widget หายจากพื้นโต๊ะทันที (เชื่อมกับ host settings จาก task 04)
      ไม่ต้อง restart shell
- [ ] กด Settings ของ widget ตัวอย่าง → เห็นหน้า prefs ของ widget นั้น, แก้ค่าแล้วสะท้อนผลบน
      พื้นโต๊ะแบบ real-time (หรืออย่างช้าคือหลัง toggle ปิดเปิดใหม่ — ระบุพฤติกรรมจริงไว้ใน
      Notes from implementation)
- [ ] Widget ที่จงใจทำให้ metadata.json พัง → โชว์ error ใน list ไม่ทำให้ Control Center ทั้งหน้าพัง
- [ ] Widget ที่ไม่มี `prefs.js` แต่มี `settings` schema ใน metadata.json → ปุ่ม Settings โผล่ และกดแล้ว
      เห็นหน้า Adw ที่สร้างอัตโนมัติ ตรงตาม field ที่ประกาศไว้ (string/number/range/boolean/dropdown/color)
- [ ] แก้ค่าในหน้า auto-generated settings → เขียนลง `widgets/<id>.json` เหมือน prefs.js ธรรมดา
      (เปิดใหม่ยังเห็นค่าที่แก้)
- [ ] Widget ที่มี `settings` schema ผิดโครงสร้าง (เช่น `range` ไม่มี `min`/`max`) → ไม่ถูกโหลด
      ทั้งตัว โผล่ในรายการ error พร้อมเหตุผลชัดเจน
- [ ] Widget ที่มีทั้ง `prefs.js` และ `settings` schema → เปิด `prefs.js` (ไม่ใช่หน้า auto-generated)

## Out of scope

- ไม่ต้องทำหน้า "install widget จาก URL/store ออนไลน์" ใน task นี้ (อาจเป็น task แยกในอนาคต
  ถ้าต้องการทำ "widget store" จริง ๆ — ปัจจุบันติดตั้งด้วยการ copy โฟลเดอร์เองพอ)
- Declarative `settings` schema (2026-07-18) รองรับแค่ 6 type แรก (`string`/`number`/`range`/
  `boolean`/`dropdown`/`color`) — `file`/`folder`/`desktop-file`/`command`/`date`/`time`/
  `password`/`url`/`icon`/`font` ยังไม่ทำ (ต้องมี picker dialog หรือ sanitization เพิ่มเติมที่ไม่ใช่
  งาน UI ธรรมดา) ต้องใช้ `prefs.js` เขียนเองไปก่อนถ้าต้องการ type เหล่านี้ — ดูรายละเอียดใน
  `development/docs/WIDGET_API.md` §2.1

## Notes from implementation

- Toggle ปิด/เปิด widget สะท้อนผลบนพื้นโต๊ะ**ทันทีจริง** ไม่ต้อง restart shell — implement ผ่าน
  `SettingsService.onChanged('disabled-widgets', ...)` ใน `extension.js` (แก้เพิ่มนอกเหนือจาก
  `Files to touch` เดิม เพราะ acceptance criteria ข้อนี้ทำไม่ได้เลยถ้าไม่แตะ host — prefs.js
  ปรับ GSettings key เดียวกับที่ `extension.js` ฟัง, ทั้งสอง process อ่าน/เขียน dconf ตัวเดียวกัน
  จึงไม่ต้องมี IPC เพิ่มเอง) `WidgetLoader` เพิ่ม `loadOne()`/`unloadOne()` (แยกจาก body เดิมของ
  `loadAll()`/`unloadAll()`) ให้ `extension.js`'s `_applyDisabledWidgets()` เรียกได้ทีละ widget
  โดยไม่กระทบตัวอื่น
- ค่า settings ที่แก้จากหน้า "Settings" ของ widget (กด Settings ใน Control Center) **ไม่**
  สะท้อนผลบนพื้นโต๊ะแบบ real-time — เขียนลง `widgets/<id>.json` ผ่าน `WidgetSettings`/
  `StorageService` เหมือนกัน แต่ instance ที่รันอยู่ใน Shell process มี settings proxy เป็น
  in-memory ของตัวเอง คนละ process กับ prefs จึงไม่รู้ว่าไฟล์เปลี่ยน ต้อง toggle ปิด/เปิด widget
  นั้น (หรือ restart shell) ถึงจะเห็นค่าใหม่ — ตรงตามทางเลือก "ช้า" ที่ acceptance criteria
  อนุญาตไว้ การทำ real-time ข้าม process ต้องมี notification channel เพิ่ม (เช่น file watcher ใน
  `widget.js` เอง) ซึ่งเกินขอบเขต task นี้
- ใช้ `Adw.PreferencesWindow.present_subpage()` สำหรับหน้า Settings ของแต่ละ widget (ยังใช้ได้ใน
  libadwaita ที่มากับ GNOME 45+ แม้จะมี `Adw.NavigationView` เป็นทางเลือกใหม่กว่า) เลือกอันนี้
  เพราะเรียบง่ายกว่าและ `development/docs/WIDGET_API.md`/prompt ของ task ไม่ได้ระบุ pattern เฉพาะ
- Error ของ widget ที่ metadata.json พัง มาจาก `WidgetLoader.discover()`/`.errors` โดยตรง (ของเดิม
  จาก task 01) — `prefsWidgetList.js` แค่ pass through ไม่ได้ทำ validation ซ้ำ

### 2026-07-18 — Declarative `settings` schema (auto-generated prefs UI)

- เพิ่ม `settingsSchema.js` (pure JS, import ได้ทั้ง Shell/Prefs process — `validateSettingsSchema()`
  + `getSchemaDefaults()`) กับ `settingsSchemaUI.js` (Prefs process เท่านั้น, import Adw/Gtk/Gdk —
  `buildSettingsPage()` แปล schema เป็น `Adw.PreferencesPage`)
- `WidgetLoader.discover()` เรียก `validateSettingsSchema()` ต่อจาก duplicate-id check — widget ที่มี
  schema พังถูก reject ทั้งตัวเหมือน metadata.json พัง ไม่ใช่แค่ตัด field ที่ผิดทิ้ง (กันหน้า prefs
  auto-gen ครึ่งๆ กลางๆ)
- `loadOne()`/`reloadWidget()` merge `getSchemaDefaults(metadata.settings)` เข้ากับผลลัพธ์ของ
  `instance.getDefaultSettings()` — schema เป็น base, `getDefaultSettings()` ทับได้ถ้า key ซ้ำ (เผื่อ
  widget อยากมี default บาง key ที่ซับซ้อนกว่าที่ schema ประกาศตรงๆ ได้)
- `prefs.js`'s `_openWidgetPrefs()` แยกเป็น 2 path: มี `prefs.js` → path เดิมทุกอย่าง (แค่ย้ายไป
  `_openHandWrittenPrefs()`), ไม่มีแต่มี `settings` schema → `buildSettingsPage()` แล้ว
  `present_subpage()` เหมือนกัน — ฝั่งเรียกไม่ต้องรู้ว่ามาจากไหน
- Auto-generated rows เขียนผ่าน settings proxy ตัวเดียวกับที่ `prefs.js` ธรรมดาใช้ (`WidgetSettings.load()`)
  — ติด limitation cross-process เดียวกับที่โน้ตไว้ด้านบนทุกประการ (ไม่ real-time ข้าม process จนกว่าจะ
  toggle ปิด/เปิดหรือ restart shell) — task ถัดไปที่วางแผนไว้จะแก้เรื่องนี้โดยเฉพาะ
- **ยังไม่ยืนยันบนเครื่องจริง** เหมือน task อื่นทั้งหมดในไฟล์นี้ — `node --check` ผ่านทุกไฟล์
  ที่แก้/สร้างใหม่ (syntax level เท่านั้น) โดยเฉพาะ `Adw.ComboRow`/`Gtk.ColorDialogButton` ที่ยังไม่ได้
  ลองรันจริงว่า API ตรงกับเวอร์ชัน GNOME Shell 45+ ที่ target ไว้หรือไม่
