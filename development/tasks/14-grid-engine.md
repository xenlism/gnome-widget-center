# Task 14 — Grid Engine

> **หมายเหตุการรวมไฟล์ (2026-07-16):** task นี้มาจาก spec package ที่ส่งเข้ามาใหม่ ต้นทางตั้งชื่อ
> `12-grid-engine.md` เลข 12 ไม่ชนกับ task เดิม (เดิมมีถึง 11) แต่เปลี่ยนเป็น 14 เพื่อให้เรียง
> ตามลำดับ "Next Milestone" ที่ระบุใน status package ต้นทาง (Edit Mode → Drag & Drop →
> Grid Engine)

## Goal

Implement Grid Engine — 16px grid, snap, guides, collision detection, auto rearrangement,
layout engine APIs ตามที่ร่างไว้ใน spec

## Spec reference

`development/architecture/specs/ui/grid-engine.md` — 16px grid, snap, guides, collision detection,
auto rearrangement, layout engine APIs

## Depends on

`02-widget-layer-rendering.md` (ต้องมี widget layer ก่อนถึงจะมีอะไรให้จัด grid) — เป็น
dependency ของ `13-widget-drag-drop.md` ด้วย (drop flow อิง grid cell)

## Files to touch

- `products/extension/lib/gridEngine.js` (สร้างใหม่ — pure geometry module ไม่ import
  Clutter/St/Gio อะไรเลย เพื่อให้ unit test ได้โดยไม่ต้องมี GNOME Shell จริง)

## Steps

1. `snap()`/`snapPoint()` — ปัดพิกัดดิบไปที่เส้น grid ที่ใกล้ที่สุด (16px)
2. `rectsOverlap()`/`hasCollision()` — AABB overlap test ระหว่าง rect ของ widget ที่กำลังจะวางกับ
   widget อื่นบนจอเดียวกัน (รับ list ของ widget อื่นเป็น parameter ไม่ไปอ่าน WidgetLayer/StorageService
   เอง)
3. `findNearestFreeCell()` — snap จุดที่ต้องการก่อน แล้วถ้าชนหรือหลุดขอบจอ ให้วน spiral ออกไปทีละ ring
   (จำกัดที่ 24 ring ≈ 384px) จนกว่าจะเจอ cell ที่ว่างและอยู่ในขอบจอ ถ้าหาไม่เจอเลยภายในขอบเขตที่กำหนด
   (กรณี pathological: จอเต็มไปด้วย widget จนไม่มีที่ว่างเหลือ) ให้คืนค่าจุดเดิมที่ snap แล้วพร้อม
   `collided: true` แทนที่จะวนลูปไม่รู้จบ
4. `getAlignmentGuides()` — หาเส้น guide แนวตั้ง/แนวนอนอย่างละ 1 เส้น (ที่ใกล้ที่สุดภายใน threshold)
   จาก edge/center ของ widget อื่น — คำนวณไว้แต่ยังไม่ได้เอาไปวาดจริงใน task 13 (ดู Out of scope)

## Acceptance criteria

- [ ] `snap(17)` ได้ `16`, `snap(24)` ได้ `16` (เส้นแบ่งกลางพอดี ปัดลง), `snap(25)` ได้ `32`
- [ ] `hasCollision()` ตรวจจับ overlap ถูกต้องทั้งกรณีทับเต็ม/ทับบางส่วน/ไม่ทับเลย
- [ ] `findNearestFreeCell()` เมื่อจุดที่ต้องการว่างอยู่แล้ว → คืนค่าจุดนั้นตรงๆ ไม่ spiral ออกไปเลย
- [ ] `findNearestFreeCell()` เมื่อจุดที่ต้องการชนกับ widget อื่น → คืนค่า cell ที่ใกล้ที่สุดที่ว่างจริง
      (ไม่ใช่แค่ cell แรกที่เจอที่อาจไกลกว่า)
- [ ] `findNearestFreeCell()` กรณีจอเต็ม (ทดสอบด้วย mock widgets เต็มทุก cell ในรัศมี maxRings) →
      คืนค่าพร้อม `collided: true` แทนที่จะ hang

## Out of scope

- Alignment guides คำนวณไว้แล้วแต่ยังไม่มี UI แสดงเส้นจริงระหว่างลาก (task 13 ใช้แค่ placeholder
  ที่ผ่าน collision avoidance ไม่ได้วาด guide line เพิ่ม)
- Grid overlay แบบเส้นจางๆ คลุมทั้งพื้นโต๊ะระหว่างลาก — ไม่มี มีแค่ placeholder ที่ปลายทาง

## Notes from implementation

- ตั้งใจไม่ import Clutter/St/Gio เข้ามาในไฟล์นี้เลยแม้แต่ตัวเดียว เพื่อให้เป็น pure function ทดสอบได้
  โดยไม่ต้องมี GNOME Shell จริง (ต่างจากไฟล์อื่นๆ ในโปรเจกต์ที่ต้อง import gi:// เกือบทุกไฟล์)
- `_ringOffsets()` เดินเป็นลำดับ clockwise คงที่ (deterministic) เพื่อให้ผลลัพธ์ของ
  `findNearestFreeCell()` ทดสอบซ้ำได้ ไม่ใช่สุ่มทิศทางออกไปแต่ละครั้ง
- **ยังไม่ยืนยันบนเครื่องจริง/ยังไม่มี automated test file จริง** — `node --check` ผ่านเท่านั้น
  (syntax level) การทดสอบ acceptance criteria ข้างบนต้องเขียน test file แยกใน
  `development/architecture/tests/` ก่อนถึงจะติ๊กผ่านได้จริง
