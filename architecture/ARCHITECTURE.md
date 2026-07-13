# Proposed Architecture Changes (SUPERSEDED)

**สถานะ: ถูกแทนที่แล้ว — ดู [`gnome-widget-center/docs/ARCHITECTURE.md`](gnome-widget-center/docs/ARCHITECTURE.md) เป็นตัวจริง**

ไฟล์นี้เป็นโน้ตแนวคิดร่างแรกก่อนตัดสินใจสถาปัตยกรรมจริง เก็บไว้เป็นบันทึกว่าทำไมถึงไม่เลือกทางนี้
เท่านั้น **ห้ามใช้เป็นสเปกในการเขียนโค้ด**

## ข้อเสนอเดิม และเหตุผลที่ถูกปฏิเสธ

| ข้อเสนอเดิม | เหตุผลที่ไม่เลือก | ใช้อะไรแทน |
|---|---|---|
| SQLite สำหรับ widget metadata/settings | ต้องมี central database ผูก schema กลาง ขัดกับเป้าหมาย "ติดตั้ง widget ใหม่โดยไม่แตะ core/ไม่ต้อง migrate schema" | JSON file ต่อ widget ใน `~/.config/gnome-widget-center/widgets/<id>.json` — ดู `docs/SETTINGS_SPEC.md` |
| Widget Store แบบ namespace-based (central registry) | ต้องมี service กลางคอยดูแล namespace/publish ซึ่งเกินขอบเขต MVP และผูกเป็น dependency ใหม่ที่ยังไม่มีแผนดูแลระยะยาว | ติดตั้งด้วยการ "วางโฟลเดอร์" ตรงๆ ตามสเปกใน `docs/WIDGET_API.md` (แจกจ่ายเองผ่านช่องทางไหนก็ได้ เช่น GitHub) |
| Backup/Restore ผ่านไฟล์ `.gwctheme` (JSON) | ยังไม่ตัดทิ้ง แค่ยังไม่อยู่ใน scope ของ Phase 0-4 ปัจจุบัน (ดู `tasks/ROADMAP.md`) — ถ้าจะทำ ควรเป็น task ใหม่ต่อจาก Phase 4 ไม่ใช่ core requirement ตอนนี้ | (ยังไม่มี ณ ตอนนี้) |
| Widget Center เป็น standalone GTK app แยก เปิดจาก Shell Extension | เพิ่มความซับซ้อนของ process boundary/IPC โดยไม่จำเป็น ในเมื่อ `extension/prefs.js` (GTK4/Libadwaita, รันเป็น process ของ prefs อยู่แล้วตามมาตรฐาน GNOME Shell extension) ทำหน้าที่เดียวกันได้ | `extension/prefs.js` เป็น Control Center ตามที่ระบุใน `docs/ARCHITECTURE.md` §2.4 |
| GSettings สำหรับ "system settings" | ใช้ได้เฉพาะส่วนของ **host เอง** เท่านั้น (widget ไหนเปิดอยู่ ฯลฯ) ไม่ใช่สำหรับ widget แต่ละตัว — เพราะ third-party widget ทุกตัวต้อง `glib-compile-schemas` ระดับระบบถ้าใช้ GSettings ซึ่งขัดกับเป้าหมาย "ติดตั้งเองไม่ต้องแตะ core" | GSettings เฉพาะ `extension/schemas/....gschema.xml` (ของ core) + JSON file settings สำหรับ widget แต่ละตัว — ดู `docs/SETTINGS_SPEC.md` §"Host settings เอง" |

## หมายเหตุ

ถ้าจะรื้อฟื้นแนวคิดไหนในตารางข้างต้น (เช่น Widget Store ในอนาคตหลัง Phase 4) ให้เปิด task ใหม่ใน
`tasks/` และอัปเดต `docs/ARCHITECTURE.md` ให้ตรงกันก่อนเริ่มเขียนโค้ด — อย่าแก้เฉพาะไฟล์นี้ไฟล์เดียว
เพื่อไม่ให้เกิดความขัดแย้งแบบเดิมอีก
