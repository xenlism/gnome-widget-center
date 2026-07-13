# 09 — Third-Party Widget Template & Packaging Docs

## Goal

ทำให้คนนอกโปรเจกต์ (ไม่เคยเห็น codebase นี้มาก่อน) สร้าง+แจกจ่าย widget ของตัวเองได้ภายใน
เวลาไม่กี่นาที โดยอ่านแค่เอกสารกับ template ที่เตรียมไว้

## Depends on

`06-widget-sdk-example.md` (ใช้เป็นตัวอย่างอ้างอิงในเอกสาร — ทั้ง `clock` และ `media-player`)

*งานนี้เป็นเอกสาร/template เป็นหลัก ทำขนานกับเกือบทุก phase ได้*

## Files to touch

- `widgets/_template/` (ปรับปรุงจาก task 01 ให้สมบูรณ์ พร้อม comment อธิบายทุกจุด)
- `docs/PUBLISHING_A_WIDGET.md` (สร้างใหม่)
- `README.md` (แก้ตรงส่วนลิงก์ไปเอกสารใหม่)

## Steps (แนะนำ)

1. `widgets/_template/` ต้อง copy-paste แล้วใช้งานได้ทันที (ไม่ error) โดยแค่เปลี่ยน `id`/`name`
   ใน metadata.json — ใส่ comment `// TODO:` ในจุดที่ควรแก้
2. `docs/PUBLISHING_A_WIDGET.md` ครอบคลุม:
   - Quick start: copy template → แก้ 3 ไฟล์ → เห็นผลบนพื้นโต๊ะ (ใน 4 ขั้นตอน)
   - วิธีแจกจ่าย: zip โฟลเดอร์ / แชร์ผ่าน git repo แยก / วิธีให้ผู้ใช้ปลายทางติดตั้ง
     (copy ไป `~/.local/share/gnome-widget-center/widgets/`)
   - Checklist ก่อนแจก (ลิงก์กลับไป `docs/WIDGET_API.md` §7)
   - แนวทาง versioning (`api-version` ต้องตรงกับที่ host รองรับ)
3. ตรวจสอบว่าทุกลิงก์ข้ามเอกสาร (ARCHITECTURE ↔ WIDGET_API ↔ SETTINGS_SPEC ↔ PUBLISHING)
   ยังถูกต้องหลังเพิ่มไฟล์ใหม่

## Acceptance criteria

- [ ] ให้คนที่ไม่เคยเห็นโปรเจกต์นี้มาก่อน อ่านแค่ `docs/PUBLISHING_A_WIDGET.md` +
      `docs/WIDGET_API.md` แล้วสร้าง widget ใหม่ที่ใช้งานได้จริงโดยไม่ต้องถามคำถามเพิ่ม
      (ทดสอบจริงหรือให้ AI อีกตัวลองทำตามเอกสารแบบไม่มี context อื่นเลย)
- [ ] `widgets/_template/` รันได้ทันทีหลัง copy โดยไม่มี error ใน log

## Out of scope

- Widget store/marketplace ออนไลน์ (นอกขอบเขตของโปรเจกต์นี้ในตอนนี้)
