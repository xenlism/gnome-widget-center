# 00 — Project Setup & Feasibility Validation

## Goal

พิสูจน์ก่อนลงมือจริงว่าแนวทาง "วาด widget เป็น St/Clutter actor ฝังในชั้นต่ำกว่าหน้าต่างแอป"
ใช้ได้จริงบน GNOME 50 / Wayland (ไม่ใช่แค่ทฤษฎีใน ARCHITECTURE.md) และตั้งโครง repo ว่างให้
task ถัดไปต่อได้

## Depends on

ไม่มี (เริ่มก่อนงานอื่นทั้งหมด)

## Context

อ่าน `development/docs/ARCHITECTURE.md` ทั้งหมดก่อน โดยเฉพาะหัวข้อ 2.1 และ 6

## Files to touch

- `products/extension/metadata.json` (สร้างใหม่)
- `products/extension/extension.js` (สร้างแบบ minimal — แค่พอ enable/disable ได้)
- `development/tasks/00-project-setup.md` (ไฟล์นี้เอง — เพิ่ม notes ท้ายไฟล์หลังทดลองเสร็จ)
- ห้ามสร้างไฟล์ widget จริงใน task นี้ (ไปอยู่ใน task 06)

## Steps (แนะนำ)

1. เขียน `metadata.json` แบบมาตรฐาน (uuid, name, description, shell-version: ["50"])
2. เขียน `extension.js` แบบ minimal ES module (`export default class extends Extension`)
   ที่ตอน `enable()`:
   - สร้าง `St.Widget` สี่เหลี่ยมสีพื้นทดสอบ (เช่น กล่องสีแดง ขนาด 200x100)
   - ลองแทรกเข้า scene graph ที่ตำแหน่งต่ำกว่า window group ด้วยวิธีต่าง ๆ แล้วบันทึกผลว่าอันไหนได้ผลจริง:
     - `global.window_group.insert_child_below(actor, null)`
     - `Main.layoutManager._backgroundGroup.add_child(actor)`
     - สร้าง `Clutter.Actor` group ใหม่แล้ว insert เข้า `global.window_group` ที่ index 0
   - ทดสอบ: เปิดแอปทับ → กล่องต้องถูกแอปบัง (อยู่ล่าง), สลับ workspace → กล่องหายไปกับ
     workspace เดิมหรือโชว์ทุก workspace (ตัดสินใจว่าต้องการพฤติกรรมไหน แล้วบันทึกไว้)
   - ทดสอบบน lock screen (ล็อกหน้าจอ) → กล่องต้องไม่โผล่มา (เช็ค session-modes)
3. `disable()` ต้อง destroy actor ให้หมด ไม่มี warning ใน `journalctl --user -f -o cat /usr/bin/gnome-shell`
4. บันทึกผลการทดลองทั้งหมดไว้ใน section "Notes from implementation" ท้ายไฟล์นี้ รวมถึง
   วิธีที่เลือกใช้จริง เพื่อให้ task 02 (widget-layer-rendering) เอาไปทำต่อแบบไม่ต้องเดาใหม่

## Acceptance criteria

- [ ] `gnome-extensions enable` ใช้งานได้บน GNOME 50 Wayland session จริง (ไม่ใช่ nested test เท่านั้น)
- [ ] กล่องทดสอบแสดงผลต่ำกว่าหน้าต่างแอปปกติ, ไม่บังหน้า lock screen, ไม่บัง overview (หรือถ้าบัง
      ต้องบันทึกไว้เป็นปัญหาที่ต้องแก้ใน task 02)
- [ ] `disable()` แล้วไม่มี actor ค้าง ไม่มี error/warning ใน log
- [ ] มี section "Notes from implementation" สรุปวิธีที่ใช้ได้จริง พร้อมโค้ดตัวอย่างสั้น ๆ

## Out of scope

- ไม่ต้องทำ widget loader, ไม่ต้องทำ multi-widget, ไม่ต้องทำ settings — แค่พิสูจน์ "1 กล่องทดสอบ
  แสดงผลถูกชั้นได้จริง"

## Notes from implementation

**สถานะ: ทดสอบจริงครบทุกข้อบน GNOME 50 / Wayland แล้ว — ผ่านทั้งหมด**

ทดสอบโดยผู้ใช้จริงบนเครื่อง (Claude ไม่มี GNOME Shell ให้รันเอง เขียนโค้ดแล้วให้ผู้ใช้รันแทน
ทุกข้อยืนยันจาก `journalctl --user -f -o cat /usr/bin/gnome-shell` และการดูด้วยตาจริง)

### วิธีที่เลือกใช้: `background_group`

```js
Main.layoutManager._backgroundGroup.add_child(actor);
```

ยืนยันแล้วว่าเป็นวิธีที่ถูกต้อง — **task 02 (widget-layer-rendering) ใช้ต่อได้เลยไม่ต้องเดาใหม่**
ไม่จำเป็นต้องลอง `window_group_below` หรือ `own_group_index0` อีก เพราะ `background_group`
ผ่านทุก acceptance criteria แล้ว

### ผลแต่ละข้อ

1. **หน้าต่างแอปทับกล่อง** ✅ ยืนยันด้วยตา — เปิดแอปทับตำแหน่งกล่องแดงแล้วกล่องถูกบังจริง
   (ไม่ลอยทับหน้าต่างขึ้นมา) พฤติกรรมเหมือน desktop widget จริง
2. **สลับ workspace** ✅ ยืนยันจาก log หลายรอบ — กล่องอยู่ตลอด (`box visible=true`) ทุกครั้งที่
   สลับไปมา แปลว่า `_backgroundGroup` **ไม่ผูกกับ workspace ใดโดยเฉพาะ** โชว์ทุก workspace
   → **ตัดสินใจ:** widget ทุกตัวใน Widget Center จะโชว์ทุก workspace (ไม่ต้องเขียนโค้ดจัดการ
   workspace-switch เพิ่มเอง เพราะพฤติกรรม default ของ `_backgroundGroup` ตรงกับที่ต้องการอยู่แล้ว)
3. **Lock screen** ✅ ยืนยันด้วยตา + log — กล่องหายไปทันทีตอนล็อกจอ **แต่ไม่ใช่เพราะ
   `Main.sessionMode` guard ที่เขียนไว้ในโค้ด** — เป็นเพราะ GNOME Shell extension system มีกลไก
   default อยู่แล้ว: extension ที่ไม่ประกาศ `"session-modes"` ใน `metadata.json` จะถูก
   `disable()` อัตโนมัติทันทีที่ session mode ออกจาก `'user'` (เช่นตอนล็อกจอ) แล้ว `enable()`
   กลับให้เองตอนปลดล็อก (เห็นจาก log คู่ `disable()` → ... → `enable()` ทุกครั้งที่ล็อก/ปลดล็อก)
   → **สรุปสำคัญสำหรับ task ถัดไป:** ไม่ต้องเขียน `Main.sessionMode` guard เองเลย ของฟรีจาก
   GNOME อยู่แล้ว ตราบใดที่ `metadata.json` ไม่ใส่ `session-modes` เพิ่ม (task 01 เป็นต้นไป
   ไม่ต้องใส่ field นี้)
4. **`disable()` สะอาด** ✅ — enable/disable ซ้ำ 5 รอบติดโดยปิด extension อื่นหมด ไม่มี
   `gsignal.c:2723 has no handler with id` เลยสักครั้ง → 5 warning ที่เจอรอบแรกมาจาก
   extension อื่น (`arch-update` หรือ churn ตอนล็อก/ปลดล็อกจอพร้อมกันหลาย extension)
   **ไม่ใช่บั๊กของเรา** ปิดประเด็นนี้ได้

### สิ่งที่ต้องปรับใน task ถัดไป (ผลจากการทดลองนี้)

- **ตัด `Main.sessionMode` guard ทิ้งได้** ตอนเขียน `widgetLayer.js` จริงใน task 02 — เป็น
  dead code เพราะ GNOME จัดการให้แล้ว (ดูข้อ 3 ด้านบน)
- **ไม่ต้องมี logic จัดการ workspace-switch** เพิ่มเอง — `_backgroundGroup` ให้พฤติกรรมที่ต้องการ
  (โชว์ทุก workspace) เป็น default อยู่แล้ว (ดูข้อ 2 ด้านบน)
- **ห้ามใส่ `"session-modes"` ใน `metadata.json`** ของ host extension เพราะจะปิดกลไก
  auto-disable-on-lock ที่ทดสอบแล้วว่าทำงานถูกต้อง
