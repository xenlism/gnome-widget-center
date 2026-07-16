# Task 12 — Widget Edit Mode

> **หมายเหตุการรวมไฟล์ (2026-07-16):** task นี้มาจาก spec package ที่ส่งเข้ามาใหม่ ต้นทางตั้งชื่อ
> `07-widget-edit-mode.md` แต่เลข 07 ถูกใช้แล้วโดย `07-multi-monitor-support.md` — เปลี่ยนเลขเป็น
> 12 เพื่อไม่ให้ทับกัน เนื้อหาต้นฉบับเป็นแค่ one-liner (`Implemented target: Widget Edit Mode.`)
> รายละเอียดเต็มต้องอ้างอิง spec draft ด้านล่าง ยังไม่ได้เขียน Steps/Acceptance criteria แบบ
> ละเอียดเหมือน task อื่น เพราะ spec เองยังเป็น Draft

## Goal

Implement Widget Edit Mode — สลับ widget ระหว่างโหมด Normal กับ Edit (มี flip animation,
back-side actions, state machine ของตัวเอง) ตามที่ร่างไว้ใน spec

## Spec reference

`development/architecture/specs/ui/widget-edit-mode.md` (status: Draft) — ครอบ Normal/Edit modes, flip animation,
back side actions, state machine, interaction rules, accessibility, APIs

## Depends on

`02-widget-layer-rendering.md` (ต้องมี widget actor บนพื้นโต๊ะก่อนถึงจะมีอะไรให้ toggle โหมด),
น่าจะเกี่ยวกับ `05-prefs-control-center.md` ด้วยถ้า back-side actions เชื่อมกับ settings ต่อ widget

## Files to touch

_(ยังไม่ระบุ — ต้องขยาย spec ให้ครบก่อนถึงจะ map เป็นไฟล์โค้ดจริงได้ เช่น
`products/extension/lib/widgetLayer.js` น่าจะต้องแก้เพื่อรองรับ state ใหม่)_

## Steps

_(รอ spec `development/architecture/specs/ui/widget-edit-mode.md` ขยายจาก Draft ให้มี state machine/interaction rules
ละเอียดพอก่อนเริ่ม implement)_

## Acceptance criteria

- [ ] _(รอกำหนดจาก spec ฉบับเต็ม)_

## Out of scope

_(ยังไม่ระบุ)_

## Notes from implementation

_(เติมหลังทำเสร็จ)_
