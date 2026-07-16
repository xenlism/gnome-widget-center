# GNOME Widget Center

ระบบ "Desktop Widget Center" สำหรับ GNOME Shell (เป้าหมาย: GNOME 50 / Wayland เป็นหลัก
แต่ให้ยังพอรันบน X11 ได้ถ้าเป็นไปได้) ที่ให้:

1. ผู้ใช้เพิ่ม/ลบ widget บนพื้นโต๊ะ (คล้าย Conky / Rainmeter / xenlism-showtime) ได้
   โดย**ไม่ต้องแก้โค้ดหลัก (core)** ของโปรเจกต์
2. นักพัฒนาภายนอกสร้าง widget ของตัวเอง แจกจ่ายเป็นโฟลเดอร์ปลั๊กอิน แล้วผู้ใช้ติดตั้งเพิ่มได้เอง
3. แต่ละ widget มี **settings แยกจากกันเด็ดขาด** (อ่าน/เขียนไฟล์ของตัวเอง ไม่ชนกัน
   และไม่ต้องไปคอมไพล์ GSettings schema ระดับระบบ)

โปรเจกต์นี้ถูกออกแบบมาให้ **แบ่งงานเป็นชิ้นเล็ก ๆ (tasks/) เพื่อป้อนให้ AI ทำทีละ session/ทีละวันได้**
โดยแต่ละไฟล์ใน `development/tasks/` เป็น context ที่สมบูรณ์ในตัวเอง — ไม่ต้องย้อนอ่านทั้งประวัติแชท

## ทำไมไม่ใช้วิธีของ xenlism/showtime เดิม

xenlism/showtime สร้าง GTK4 window แยกต่างหาก แล้วใช้ trick ของ X11
(window type hint / always-below / sticky / skip-taskbar) หลอกให้หน้าต่างดูเหมือนฝังอยู่บนพื้นโต๊ะ —
วิธีนี้พึ่งพา X11 window manager protocol โดยตรง ซึ่ง**ใช้ไม่ได้แน่นอนบน Wayland**
(mutter ใน Wayland session ไม่ยอมให้ client ภายนอกจัดชั้นหน้าต่างแบบนั้น)

ดูเหตุผลและทางแก้แบบละเอียดใน [`development/docs/ARCHITECTURE.md`](development/docs/ARCHITECTURE.md)

## โครงสร้างโปรเจกต์

```
gnome-widget-center/
├── development/
│   ├── docs/              # เอกสารสถาปัตยกรรม + สเปกสำหรับนักพัฒนา widget
│   ├── tasks/              # งานย่อยแบบ self-contained ป้อนให้ AI ทำทีละงาน
│   └── tests/
└── products/
    └── extension/         # ตัว "host" — GNOME Shell extension หลัก (core, แก้ยาก แก้น้อยที่สุด)
        └── widgets/       # widget ที่มากับโปรเจกต์ (bundled) + template สำหรับ dev ภายนอก
```

*(หมายเหตุ (2026-07-16): เคยมีแนวคิด `products/widgets/` แยกต่างหากจาก `extension/`, ตัดสินใจ
เลิกใช้แล้ว — ไม่มีโค้ดจุดไหนโหลดจาก path นั้นจริง `products/extension/widgets/` คือที่เดียว
ที่ `extension.js` อ่าน bundled widget ดู `development/tasks/ROADMAP.md`'s "Decision
(2026-07-16)")*

## ลำดับการอ่านเอกสาร (สำหรับคนหรือ AI ที่เพิ่งเข้ามาทำงานนี้)

1. `development/docs/ARCHITECTURE.md` — ภาพรวมสถาปัตยกรรมและเหตุผลของการตัดสินใจสำคัญ
2. `development/docs/WIDGET_API.md` — สัญญา (contract) ที่ widget ทุกตัวต้องทำตาม
3. `development/docs/SETTINGS_SPEC.md` — รูปแบบไฟล์ settings ต่อ widget
4. `development/tasks/00-project-setup.md` เป็นต้นไป — งานที่ต้องทำเรียงตามลำดับ

## วิธีใช้ tasks/ กับ AI หลายตัว/หลายวัน

ดูรายละเอียดขั้นตอนใน [`development/docs/CONTRIBUTING.md`](development/docs/CONTRIBUTING.md) — สรุปสั้น ๆ:

- แต่ละ task = 1 conversation/1 session กับ AI ตัวไหนก็ได้
- ให้ AI อ่านเฉพาะ: `development/docs/ARCHITECTURE.md` + `development/docs/WIDGET_API.md` (ถ้าเกี่ยว) + ไฟล์ task นั้น ๆ
- เสร็จ task ไหน ให้ติ๊ก `- [x]` ใน `development/tasks/ROADMAP.md` แล้ว commit
- ห้ามให้ AI แก้ไฟล์นอกเหนือ "Files to touch" ที่ระบุใน task โดยไม่จำเป็น (กัน scope creep/conflict)
