# 02 — Widget Layer Rendering

## Goal

สร้าง "Widget Layer" จริง — actor group ที่ widget ทุกตัวถูกวางอยู่ในนั้น จัดการ z-order,
การโชว์/ซ่อนตาม overview/lock-screen/workspace ให้ถูกต้องตามที่ validate ไว้ใน task 00

## Depends on

`00-project-setup.md`, `01-widget-loader-core.md`

## Files to touch

- `extension/lib/widgetLayer.js` (สร้างใหม่)
- `extension/extension.js` (แก้ให้สร้าง/ทำลาย WidgetLayer และเชื่อมกับ loader)

## Steps (แนะนำ)

1. `WidgetLayer` class รับผิดชอบ:
   - สร้าง `Clutter.Actor` container 1 อันต่อจอ (multi-monitor เต็มรูปแบบอยู่ task 07
     แต่โครงต้องรองรับหลาย container ตั้งแต่แรก อย่า hardcode จอเดียว)
   - `addWidgetActor(widgetId, actor, position)` — วาง actor ที่ตำแหน่งที่กำหนด (x, y สัมพัทธ์กับจอ)
   - `removeWidgetActor(widgetId)`
   - ใช้วิธี insert ที่ validate ไว้แล้วจาก task 00 (อ่านจาก Notes from implementation ของ task นั้น)
2. Connect signal ที่จำเป็น (อ้างอิงผลทดสอบ task 00):
   - `Main.overview` showing/hiding → ซ่อน/โชว์ widget layer ตามที่ตัดสินใจไว้
   - session-mode เปลี่ยนเป็น `unlock-dialog`/`lock-screen` → ต้องซ่อน widget layer เสมอ
     (ตาม security guideline ของ GNOME Shell extension review)
   - `global.display.connect('window-created', ...)` ไม่ต้อง — Widget Layer ไม่ต้องสนใจหน้าต่างแอป
     โดยตรง เพราะ z-order จัดการด้วยตำแหน่งใน scene graph อยู่แล้ว
3. เชื่อม `extension.js`: หลัง `WidgetLoader` โหลด widget module และเรียก `buildActor()` แล้ว
   → ส่ง actor เข้า `WidgetLayer.addWidgetActor()`

## Acceptance criteria

- [ ] Widget ตัวอย่าง (`_template`) แสดงบนพื้นโต๊ะจริง อยู่ต่ำกว่าหน้าต่างแอปทุกตัว
- [ ] ล็อกหน้าจอ → widget หายไปทันที, ปลดล็อก → widget กลับมา
- [ ] เปิด Activities/overview → พฤติกรรมตรงกับที่ตัดสินใจไว้ใน task 00 (ระบุผลไว้ใน Notes)
- [ ] `disable()` extension แล้ว widget layer ถูก destroy หมด ไม่มี actor ค้างใน scene graph
      (เช็คด้วย Looking Glass: `Main.layoutManager.uiGroup` ไม่มี actor แปลกปลอมค้าง)

## Out of scope

- Drag เปลี่ยนตำแหน่งด้วยเมาส์ (task 04)
- Multi-monitor เต็มรูปแบบ เช่น จอถอด/เสียบใหม่ระหว่างใช้งาน (task 07) — แค่ไม่ hardcode
  จอเดียวจนแก้ยากทีหลังก็พอ

## Notes from implementation

**สถานะ (2026-07-13): แก้ integration gap — โค้ดยังไม่เคยรันบน GNOME Shell จริงเลย**

พบว่าโค้ดเวอร์ชันก่อนหน้าของ `widgetLayer.js`/`extension.js` "เสร็จ" แค่ในแง่ว่ามีไฟล์อยู่
แต่ไม่เคยทำงานตาม data flow ที่ `docs/ARCHITECTURE.md` §4 กำหนดไว้จริง:

- `WidgetLayer` ไม่มี `addWidgetActor()`/`removeWidgetActor()` เลย — สร้าง `St.BoxLayout`
  เปล่าๆ เองจาก `layout.json` ตรงๆ (อ่าน `customProperties.themeColor` มาทาสี) ไม่เคยรับ
  actor จริงจาก `instance.buildActor()` ของ widget เลยสักตัว
- `extension.js` ไม่เคยสร้าง `WidgetLayer` และไม่เคยแนบ container เข้า
  `Main.layoutManager._backgroundGroup` — widget ที่โหลดสำเร็จจาก `WidgetLoader` จึงไม่เคย
  ถูกวาดบนพื้นโต๊ะจริงเลย (actor ถูกสร้างแล้วทิ้งไว้เฉยๆ)

แก้แล้ว: `WidgetLayer` มี `addWidgetActor(id, actor, position)` /
`removeWidgetActor(id)` / `setWidgetPosition(id, x, y)` (ให้ task 04 ใช้ระหว่างลาก) /
`getSavedPosition(id, fallback)` (อ่านจาก `StorageService.getWidgetPosition()`) ตามสัญญาที่ตั้ง
ไว้ตั้งแต่ต้น `init()` แนบ container เข้า `background_group` ตามวิธีที่ validate ไว้จาก task 00
`extension.js` เชื่อม `WidgetLoader` → `WidgetLayer` ให้ actor จริงของแต่ละ widget ถูกวาง
ตามตำแหน่งที่บันทึกไว้ (หรือ `default-position` จาก metadata.json ถ้ายังไม่เคยบันทึก)

**ยังไม่ยืนยันบนเครื่องจริง** (เหมือน task 00/01) — acceptance criteria ด้านบนต้องทดสอบซ้ำบน
GNOME Shell 50/Wayland จริงก่อน tick `- [x]`
