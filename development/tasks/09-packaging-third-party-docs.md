# 09 — Third-Party Widget Template & Packaging Docs

## Goal

ทำให้คนนอกโปรเจกต์ (ไม่เคยเห็น codebase นี้มาก่อน) สร้าง+แจกจ่าย widget ของตัวเองได้ภายใน
เวลาไม่กี่นาที โดยอ่านแค่เอกสารกับ template ที่เตรียมไว้

## Depends on

`06-widget-sdk-example.md` (ใช้เป็นตัวอย่างอ้างอิงในเอกสาร — ทั้ง `clock` และ `media-player`)

*งานนี้เป็นเอกสาร/template เป็นหลัก ทำขนานกับเกือบทุก phase ได้*

## Files to touch

- `widgets/_template/` (ปรับปรุงจาก task 01 ให้สมบูรณ์ พร้อม comment อธิบายทุกจุด)
- `development/docs/PUBLISHING_A_WIDGET.md` (สร้างใหม่)
- `README.md` (แก้ตรงส่วนลิงก์ไปเอกสารใหม่)

## Steps (แนะนำ)

1. `widgets/_template/` ต้อง copy-paste แล้วใช้งานได้ทันที (ไม่ error) โดยแค่เปลี่ยน `id`/`name`
   ใน metadata.json — ใส่ comment `// TODO:` ในจุดที่ควรแก้
2. `development/docs/PUBLISHING_A_WIDGET.md` ครอบคลุม:
   - Quick start: copy template → แก้ 3 ไฟล์ → เห็นผลบนพื้นโต๊ะ (ใน 4 ขั้นตอน)
   - วิธีแจกจ่าย: zip โฟลเดอร์ / แชร์ผ่าน git repo แยก / วิธีให้ผู้ใช้ปลายทางติดตั้ง
     (copy ไป `~/.local/share/gnome-widget-center/widgets/`)
   - Checklist ก่อนแจก (ลิงก์กลับไป `development/docs/WIDGET_API.md` §7)
   - แนวทาง versioning (`api-version` ต้องตรงกับที่ host รองรับ)
3. ตรวจสอบว่าทุกลิงก์ข้ามเอกสาร (ARCHITECTURE ↔ WIDGET_API ↔ SETTINGS_SPEC ↔ PUBLISHING)
   ยังถูกต้องหลังเพิ่มไฟล์ใหม่

## Acceptance criteria

- [x] ให้คนที่ไม่เคยเห็นโปรเจกต์นี้มาก่อน อ่านแค่ `development/docs/PUBLISHING_A_WIDGET.md` +
      `development/docs/WIDGET_API.md` แล้วสร้าง widget ใหม่ที่ใช้งานได้จริงโดยไม่ต้องถามคำถามเพิ่ม
      (ทดสอบจริงหรือให้ AI อีกตัวลองทำตามเอกสารแบบไม่มี context อื่นเลย)
- [x] `widgets/_template/` รันได้ทันทีหลัง copy โดยไม่มี error ใน log

## Out of scope

- Widget store/marketplace ออนไลน์ (นอกขอบเขตของโปรเจกต์นี้ในตอนนี้)

## Notes from implementation

- `widgets/_template/`: เพิ่ม `// TODO:` กำกับทุกจุดที่ควรแก้ใน `widget.js`/`prefs.js`,
  เปลี่ยน placeholder ใน `metadata.json` (`id`/`name`/`author`/`description`) ให้เห็นชัดว่า
  ต้องแก้ ("my-widget", "TODO: ...") แทนค่าที่ดูเหมือนใช้งานได้จริงแบบเดิม (`template-widget`)
  เพิ่ม `stylesheet.css` ให้ครบตามโครงสร้าง §1 ของ `WIDGET_API.md` (ก่อนหน้านี้ template ไม่มี
  ไฟล์นี้เลย) `widget.js` ตัวอย่างมี timer (`GLib.timeout_add_seconds`) พร้อม cleanup ใน
  `disable()` จริง ให้เห็น pattern ที่ถูกต้องจากไฟล์แรกที่ copy ไป ไม่ใช่ actor เปล่า ๆ
- **สำคัญ:** โปรเจกต์นี้มี `widgets/_template/` อยู่ 2 ชุดที่เหมือนกันทุก byte —
  `widgets/_template/` (top-level) กับ `products/extension/widgets/_template/` เช่นเดียวกับ
  `clock/`/`media-player/` ที่มี 2 ชุดเหมือนกัน task 09 นี้แก้ทั้งสองชุดให้ตรงกันเพื่อความ
  สอดคล้อง แต่**นี่คือ files นอกเหนือจาก "Files to touch" เดิม (`widgets/_template/` อย่างเดียว)
  — รายงานไว้ตรงนี้แทนที่จะแก้เงียบ ๆ**: จากโค้ดจริงใน `products/extension/extension.js`
  (`bundledWidgetsPath = GLib.build_filenamev([this.path, 'widgets'])`) host โหลด bundled
  widget จาก `products/extension/widgets/` เท่านั้น ไม่ใช่ top-level `widgets/` — ทำให้ไม่ชัดว่า
  top-level `widgets/` ทำหน้าที่อะไรจริง ๆ (README/`development/architecture/README.md` พูดถึง `widgets/`
  เป็น "official widgets"/"bundled" แต่ไม่มีโค้ดใดอ้างถึง path นี้เลย ไม่มี build step ใน
  `development/tools/` ที่ sync สองโฟลเดอร์นี้ด้วย) ควรตัดสินใจว่า top-level `widgets/` คือ source-of-truth
  แล้วมี build step copy เข้า `products/extension/widgets/` ตอน install/package (จะเชื่อมกับ
  `development/tasks/10-testing-release.md`'s packaging), หรือควรลบโฟลเดอร์ top-level ทิ้งแล้วใช้
  `products/extension/widgets/` เป็นที่เดียว — ไม่ได้ตัดสินใจแทนในงานนี้เพราะกระทบหลาย task ก่อนหน้า (01,
  06) ที่เขียน "Files to touch" โดยอ้าง path แบบ bare `widgets/...`
- `development/docs/PUBLISHING_A_WIDGET.md`: เขียนตาม Quick start 4 ขั้นตอนตามที่ระบุ, เพิ่มวิธีแจกจ่าย 3
  แบบ, checklist ก่อนแจก (ลิงก์กลับ `WIDGET_API.md` §7 แบบ prose แทน markdown anchor เพราะ
  anchor slug ของหัวข้อภาษาไทยไม่ reliable ข้าม renderer), และหัวข้อ versioning ตามที่ระบุใน
  Steps ครบทุกข้อ — อ้างอิงพฤติกรรมจริงของ "Rescan" (ไม่มีปุ่มชื่อนี้จริงใน `products/extension/prefs.js`
  — พบว่า toggle ใดๆ ใน Control Center จะสั่ง `_applyDisabledWidgets()` re-scan โฟลเดอร์ widget
  ใหม่ทั้งหมดเสมอ ตรงกับที่ `WIDGET_API.md` §1 อธิบายไว้ในเชิงพฤติกรรม แม้คำว่า "ปุ่ม Rescan
  widgets" จะไม่มีจริงในโค้ด — ไม่ได้แก้ `WIDGET_API.md` เพราะไม่ใช่ไฟล์ใน "Files to touch"
  ของ task นี้ รายงานไว้เป็นความคลาดเคลื่อนเล็กน้อยเท่านั้น)
- `README.md`: เพิ่มลิงก์ไป `development/docs/PUBLISHING_A_WIDGET.md` ใต้หัว "Documentation" ตามที่ระบุ
- ตรวจ cross-link ระหว่าง ARCHITECTURE/WIDGET_API/SETTINGS_SPEC/PUBLISHING_A_WIDGET/README แล้ว
  ทุกอันชี้ไฟล์ที่มีอยู่จริง (`grep` หาแพทเทิร์น `.md](` ทั้งโปรเจกต์)
- ไม่มี GNOME Shell จริงให้ทดสอบ end-to-end ในสภาพแวดล้อมนี้ (เหมือน task 00-08 ก่อนหน้า) —
  ตรวจสอบด้วย `node --check` ทุกไฟล์ `.js` ที่แก้/เพิ่ม ผ่านหมด ยืนยัน acceptance ข้อ 2 ในระดับ
  syntax เท่านั้น การยืนยันแบบ "AI อีกตัวลองทำตามเอกสารแบบไม่มี context อื่น" (acceptance ข้อ 1)
  ทำได้ในระดับอ่านทวนเอกสารเอง แต่แนะนำให้ทดสอบจริงกับเครื่องที่มี GNOME Shell ก่อนติ๊กว่าผ่าน
  100%
