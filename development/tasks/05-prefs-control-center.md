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

## Out of scope

- ไม่ต้องทำหน้า "install widget จาก URL/store ออนไลน์" ใน task นี้ (อาจเป็น task แยกในอนาคต
  ถ้าต้องการทำ "widget store" จริง ๆ — ปัจจุบันติดตั้งด้วยการ copy โฟลเดอร์เองพอ)

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
