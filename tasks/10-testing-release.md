# 10 — End-to-End Testing & Release

## Goal

รวบยอดทุก phase, เทส end-to-end บนสภาพแวดล้อมจริง, เตรียมแพ็กเกจสำหรับแจกจ่าย/ขึ้น
extensions.gnome.org (ถ้าต้องการ)

## Depends on

ทุก task ก่อนหน้า (00-09) ต้องเสร็จหรืออย่างน้อย Phase 1-3 เสร็จสมบูรณ์

## Files to touch

- `tests/` (สร้าง test checklist / smoke test script)
- `CHANGELOG.md` (สร้างใหม่)
- `extension/metadata.json` (bump version, ตรวจ shell-version ให้ถูกต้อง)

## Steps (แนะนำ)

1. รัน regression ผ่าน acceptance criteria ของทุก task 00-09 อีกครั้งรวดเดียว บันทึกผลใน
   `tests/e2e-checklist.md`
2. ทดสอบ scenario ที่ไม่มีใครทำแยกไว้ก่อนหน้า:
   - ติดตั้งบนเครื่องที่ไม่เคยรันโปรเจกต์นี้มาก่อนเลย (clean install) ตาม `README.md`
     อย่างเดียว ไม่ใช้ context อื่น
   - ลง widget 3-4 ตัวพร้อมกัน (ผสม bundled + user-installed) เปิด/ปิด/ลาก/แก้ settings สลับกัน
     ทดสอบว่าไม่มี state รั่วไหลข้าม widget
   - ปิด/เปิดเครื่อง (ไม่ใช่แค่ restart shell) → ทุกอย่างคืนสภาพถูกต้อง
3. ตรวจสอบตาม [GNOME Shell Extension Review Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
   ถ้าตั้งใจจะส่งขึ้น extensions.gnome.org (ห้าม import Gtk ใน extension.js, ห้าม spawn
   subprocess ใน constructor, session-modes ต้องประกาศถูกต้อง ฯลฯ)
4. เขียน `CHANGELOG.md` สรุปทุก feature ตาม phase

## Acceptance criteria

- [ ] `tests/e2e-checklist.md` ครบทุกข้อจาก acceptance criteria ของ task 00-09 และผ่านทั้งหมด
- [ ] Clean install ตาม README ได้จริงโดยไม่ต้องถามอะไรเพิ่ม
- [ ] ไม่มี warning/error ใน `journalctl` ระหว่างการใช้งานปกติ 1 ชั่วโมง
- [ ] (ถ้าต้องการเผยแพร่) ผ่าน checklist ของ GNOME Shell Extension review guidelines

## Out of scope

- Feature ใหม่ที่ไม่อยู่ใน scope ของ task 00-09 (ให้เปิด roadmap รอบใหม่แยกต่างหาก)
