# 10 — End-to-End Testing & Release

## Goal

รวบยอดทุก phase, เทส end-to-end บนสภาพแวดล้อมจริง, เตรียมแพ็กเกจสำหรับแจกจ่าย/ขึ้น
extensions.gnome.org (ถ้าต้องการ)

## Depends on

ทุก task ก่อนหน้า (00-09) ต้องเสร็จหรืออย่างน้อย Phase 1-3 เสร็จสมบูรณ์

## Files to touch

- `development/tests/` (สร้าง test checklist / smoke test script)
- `products/CHANGELOG.md` (สร้างใหม่)
- `products/extension/metadata.json` (bump version, ตรวจ shell-version ให้ถูกต้อง)

## Steps (แนะนำ)

1. รัน regression ผ่าน acceptance criteria ของทุก task 00-09 อีกครั้งรวดเดียว บันทึกผลใน
   `development/tests/e2e-checklist.md`
2. ทดสอบ scenario ที่ไม่มีใครทำแยกไว้ก่อนหน้า:
   - ติดตั้งบนเครื่องที่ไม่เคยรันโปรเจกต์นี้มาก่อนเลย (clean install) ตาม `README.md`
     อย่างเดียว ไม่ใช้ context อื่น
   - ลง widget 3-4 ตัวพร้อมกัน (ผสม bundled + user-installed) เปิด/ปิด/ลาก/แก้ settings สลับกัน
     ทดสอบว่าไม่มี state รั่วไหลข้าม widget
   - ปิด/เปิดเครื่อง (ไม่ใช่แค่ restart shell) → ทุกอย่างคืนสภาพถูกต้อง
3. ตรวจสอบตาม [GNOME Shell Extension Review Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
   ถ้าตั้งใจจะส่งขึ้น extensions.gnome.org (ห้าม import Gtk ใน extension.js, ห้าม spawn
   subprocess ใน constructor, session-modes ต้องประกาศถูกต้อง ฯลฯ)
4. เขียน `products/CHANGELOG.md` สรุปทุก feature ตาม phase

## Acceptance criteria

- [x] `development/tests/e2e-checklist.md` ครบทุกข้อจาก acceptance criteria ของ task 00-09 — **แต่ยังไม่
      "ผ่านทั้งหมด" ในความหมายที่ต้องยืนยันบนเครื่องจริง** ดูสถานะรายข้อใน
      `development/tests/e2e-checklist.md` เอง (ผ่านยืนยันจริงเฉพาะ task 00 และ 03; ที่เหลือเป็น
      ⚠️ เขียนโค้ดแล้วแต่ยังไม่ยืนยัน หรือ ❓ ไม่มีบันทึกผลเลย)
- [ ] Clean install ตาม README ได้จริงโดยไม่ต้องถามอะไรเพิ่ม — **ยังไม่ทดสอบ** ต้องใช้เครื่องที่มี
      GNOME Shell จริง
- [ ] ไม่มี warning/error ใน `journalctl` ระหว่างการใช้งานปกติ 1 ชั่วโมง — **ยังไม่ทดสอบ**
- [x] (ถ้าต้องการเผยแพร่) ผ่าน checklist ของ GNOME Shell Extension review guidelines — ตรวจ
      เท่าที่อ่านโค้ดได้แล้ว (ดู section ท้าย `development/tests/e2e-checklist.md`) 3 ข้อหลักผ่าน แต่ยังมีข้อ
      ที่ทำเครื่องหมาย ❓ ไว้ ต้องตรวจเพิ่มก่อน submit จริง

## Out of scope

- Feature ใหม่ที่ไม่อยู่ใน scope ของ task 00-09 (ให้เปิด roadmap รอบใหม่แยกต่างหาก)

## Notes from implementation

- `development/tests/e2e-checklist.md` (ใหม่): รวบ acceptance criteria ทุกข้อจาก task 00-09 พร้อมสถานะ
  ตรงตามจริง (✅ ยืนยันแล้ว / ⚠️ เขียนโค้ดแล้วไม่ยืนยัน / ❓ ไม่มีบันทึกผลเลย) แทนที่จะทึกทักว่า
  "ผ่านหมด" เพราะโค้ดเขียนครบ — พบว่ามีแค่ task 00 (ยืนยันบนเครื่องจริงโดยผู้ใช้) และ task 03
  (unit test จริงใน Node) ที่ verified จริง ๆ ส่วนที่เหลือ (01,02,04,05,06) เขียนโค้ดครบ+
  syntax-check ผ่านแต่ยังไม่รันบน GNOME Shell จริง และพบว่า **task 07/08 ไม่มี "Notes from
  implementation" เลยทั้งที่โค้ด (`monitorWatcher.js`, `devWatcher.js`) มีอยู่จริงและ wire เข้า
  `extension.js` แล้ว** — รายงานเป็นช่องว่างเอกสารที่ควรเติมใน session ของ task 07/08 เอง
  ไม่ได้แก้ไฟล์ task 07/08 ในงานนี้เพราะไม่ใช่ "Files to touch" ของ task 10
- `products/CHANGELOG.md` (ใหม่): สรุปตาม phase ตามที่ระบุ รวมส่วน "Known gaps" (stylesheet.css ยังไม่
  auto-load, top-level `widgets/` vs `products/extension/widgets/` ซ้ำกัน, task 07/08 ขาด Notes,
  known limitation ของ real-time settings sync ใน Control Center) เพื่อไม่ให้ changelog
  อ่านดูสมบูรณ์เกินสถานะจริง
- `products/extension/metadata.json`: ลบข้อความ "(dev build - task 00)"/"Feasibility test build..."
  ที่ค้างมาตั้งแต่ task 00 ออก (ล้าสมัยไปแล้วตั้งแต่ task 01 เริ่ม) เปลี่ยน description ให้สะท้อน
  ฟีเจอร์จริงปัจจุบัน + ระบุสถานะ "code-complete, unverified on hardware" ตรง ๆ ในตัว
  description เอง (แทนที่จะเงียบแล้วให้คนอ่านต้องไปเปิด ROADMAP.md เอง) bump `version` จาก `0`
  เป็น `1` — **ไม่ได้แก้ `shell-version`** ("50") เพราะเป็นเวอร์ชันเดียวที่ยืนยันจริงจาก task 00
  แม้ `development/docs/WIDGET_API.md` §6 จะระบุขั้นต่ำ "GNOME Shell 45+" ไว้ — ไม่มีหลักฐานว่าทดสอบบน 45-49
  จริง จึงไม่กล้าประกาศรองรับกว้างกว่าที่ verified แล้ว (รายงานไว้เป็นความคลาดเคลื่อนเล็กน้อย
  ระหว่างเอกสารสองที่ ไม่ได้แก้ `WIDGET_API.md` เพราะไม่ใช่ไฟล์ใน scope ของ task นี้)
- ไม่ได้เขียน `development/tests/` เป็น automated smoke-test script (เช่น shell script ที่รัน
  `gnome-extensions enable/disable` อัตโนมัติ) เพราะไม่มี GNOME Shell ในสภาพแวดล้อมนี้ให้เขียน/
  ทดสอบสคริปต์นั้นเอง — `development/tests/e2e-checklist.md` จึงเป็น manual checklist ล้วน ไม่ใช่สคริปต์
  ตามที่ "Files to touch" ระบุไว้แบบกว้าง ๆ ("tests/ — สร้าง test checklist / smoke test
  script") เลือกทำแค่ checklist ก่อน ถ้าต้องการ smoke-test script จริงต้องทำในเครื่องที่มี
  GNOME Shell
- **ยังไม่ตัดสินใจ tick checkbox `10-testing-release.md` ใน `development/tasks/ROADMAP.md`** เพราะ
  acceptance criteria ข้อ "Clean install"/"1 ชั่วโมงไม่มี warning" ยังไม่ผ่านจริง — ต้องรันบน
  เครื่องจริงก่อน
