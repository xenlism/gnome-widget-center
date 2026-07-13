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

- `extension/prefs.js` (สร้าง/แก้ — entrypoint ของ prefs process)
- `extension/lib/prefsWidgetList.js` (สร้างใหม่ — logic แยกจาก UI marshalling)

## Steps (แนะนำ)

1. `prefs.js` ต้อง**ไม่ import St/Clutter/Meta/Shell เด็ดขาด** (คนละ process กับ `extension.js`
   ตามกฎ GNOME Shell — ดู `docs/WIDGET_API.md` §4)
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
