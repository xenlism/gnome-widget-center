# Task 11 — Theme Backup & Restore (Export/Import as JSON)

## Goal

ให้ผู้ใช้ export การตั้งค่าทั้งหมด (layout + settings ของทุก widget) ออกมาเป็นไฟล์ "theme"
เดียว แล้ว import กลับ/แชร์ให้คนอื่นได้ — ตามแนวคิด `.gwctheme` ที่เคยร่างไว้ใน `ARCHITECTURE.md`
(เวอร์ชัน superseded ที่ root ของ repo) แต่ยังไม่เคยลงมือทำ

## Depends on

`03-settings-store.md`, `04-drag-reposition.md` (ต้องมี `WidgetSettings` +
`StorageService.saveLayout()`/`loadLayout()` ให้ครบก่อน — task นี้แค่ "รวม/แยก" ไฟล์ JSON
ที่มีอยู่แล้ว ไม่สร้าง storage mechanism ใหม่)

## Context

ทุกอย่างที่ต้อง export เป็น JSON file อยู่แล้วในเครื่อง:

```
~/.config/gnome-widget-center/
├── layout.json               # รวม
└── widgets/
    ├── clock.json             # รวม
    └── ...                    # รวมทุกไฟล์ที่มีอยู่
```

**หมายเหตุ (2026-07-13):** host-level settings (เช่น รายชื่อ widget ที่ถูกปิด, dev-mode) ใช้
GSettings/dconf (ดู `development/docs/SETTINGS_SPEC.md` "Host settings เอง") **ไม่ใช่ JSON file** — จึง
**ไม่รวมอยู่ใน theme export** โดยธรรมชาติ (ไม่มีไฟล์ให้อ่านด้วยซ้ำ) ถือเป็น device-local เสมอ
ไม่ต้องเขียน logic แยกกันเพื่อ "ยกเว้น" มันแบบเวอร์ชันก่อนหน้าของไฟล์นี้ตั้งใจไว้

Theme file คือการรวมไฟล์เหล่านี้เป็น JSON ก้อนเดียว ไม่ใช่ format ใหม่ที่ต้อง parse ซับซ้อน —
**ไม่มี** DBus, **ไม่มี** SQLite, ไม่ต้อง spawn process แยก (ดูเหตุผลเดียวกับ task 03/04)

รูปแบบไฟล์ที่แนะนำ (`*.gwctheme`, เนื้อหาเป็น JSON ธรรมดา):

```json
{
  "_schemaVersion": 1,
  "exportedAt": "2026-07-13T12:00:00Z",
  "layout": { "...": "เนื้อหาเดียวกับ layout.json" },
  "widgets": {
    "clock": { "...": "เนื้อหาเดียวกับ widgets/clock.json" }
  }
}
```

## Files to touch

- `products/extension/lib/themeService.js` (สร้างใหม่ — `exportTheme(destPath)` / `importTheme(srcPath)`)
- `products/extension/prefs.js` (แก้เพิ่มปุ่ม "Export theme" / "Import theme" ใน Control Center —
  ถ้า task 05 ยังไม่เสร็จตอนเริ่ม task นี้ ให้ทำ `themeService.js` เป็น module เปล่าที่มี unit
  test ผ่านก่อน แล้วค่อยเชื่อม UI ทีหลัง)

## Steps (แนะนำ)

1. `exportTheme(destPath)`:
   - อ่าน `layout.json` + ทุกไฟล์ใน `widgets/*.json` ผ่าน `StorageService` ที่มีอยู่ (อย่าอ่าน
     ไฟล์ตรงๆ ซ้ำ ให้เรียกใช้ method เดิม)
   - รวมเป็น object เดียวตามฟอร์แมตด้านบน เขียนเป็นไฟล์ปลายทางที่ผู้ใช้เลือก (atomic write
     แบบเดียวกับที่ `StorageService.saveLayout()` ทำอยู่แล้ว)
2. `importTheme(srcPath)`:
   - validate `_schemaVersion` ก่อนเสมอ (reject ไฟล์ที่ schema ใหม่กว่าที่ host รองรับ พร้อม
     error message ชัดเจน — ห้าม silently corrupt data ที่มีอยู่)
   - sanitize widget id ทุกตัวก่อนเขียนทับ (ใช้ helper เดียวกับที่ทำใน task 03 กัน path traversal)
   - เขียนทับ `layout.json` + `widgets/*.json` ทีละไฟล์ผ่าน `StorageService`/`WidgetSettings`
     เดิม (ไม่ implement I/O ใหม่ซ้ำ)
   - หลัง import ต้องแจ้งให้ widget ที่กำลังรันอยู่ reload settings ของตัวเอง (หรือแนะนำผู้ใช้
     ให้ restart shell/toggle widget — ระบุพฤติกรรมจริงไว้ใน Notes from implementation)
3. Widget ตัวไหนอยู่ใน theme file แต่ไม่ได้ติดตั้งอยู่ในเครื่องผู้ใช้ปัจจุบัน → เก็บไฟล์ settings
   ไว้เฉยๆ (เผื่อติดตั้ง widget นั้นทีหลัง) ไม่ error, ไม่ลบทิ้ง

## Acceptance criteria

- [ ] Export แล้วได้ไฟล์เดียวที่เปิดอ่านเป็น JSON ปกติได้ (ไม่ใช่ binary/DB format)
- [ ] Import ไฟล์ที่ export มาเข้าเครื่องอื่น (หรือ config ว่างเปล่า) → widget ทุกตัวขึ้นตำแหน่ง/
      ค่าที่บันทึกไว้ตรงกับตอน export
- [ ] Import ไฟล์ที่ `_schemaVersion` สูงกว่าที่ host รู้จัก → reject พร้อม error ชัดเจน ไม่แตะ
      config ปัจจุบันเลย
- [ ] Import ไฟล์ที่มี widget id ปลอม/มี `../` ปน → ถูก sanitize/reject ไม่เขียนไฟล์นอก
      `~/.config/gnome-widget-center/`
- [ ] Export/Import ไม่แตะ host-level GSettings (`disabled-widgets`, `dev-mode`) เลย —
      เป็น device-local เสมอ ไม่ใช่ส่วนหนึ่งของ theme

## Out of scope

- Cloud sync / auto-backup ตามเวลา
- Partial import (เลือก import แค่บาง widget) — เวอร์ชันแรกทำ all-or-nothing ก่อน
- Widget store ออนไลน์สำหรับแชร์ theme (นอกขอบเขตโปรเจกต์นี้)

## Notes from implementation

_(เติมหลังทำเสร็จ)_
