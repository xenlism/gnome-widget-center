# Task 14 — Grid Engine

> **หมายเหตุการรวมไฟล์ (2026-07-16):** task นี้มาจาก spec package ที่ส่งเข้ามาใหม่ ต้นทางตั้งชื่อ
> `12-grid-engine.md` เลข 12 ไม่ชนกับ task เดิม (เดิมมีถึง 11) แต่เปลี่ยนเป็น 14 เพื่อให้เรียง
> ตามลำดับ "Next Milestone" ที่ระบุใน status package ต้นทาง (Edit Mode → Drag & Drop →
> Grid Engine) เนื้อหาต้นฉบับเป็นแค่ one-liner (`Implemented target: Grid Engine.`)

## Goal

Implement Grid Engine — 16px grid, snap, guides, collision detection, auto rearrangement,
layout engine APIs ตามที่ร่างไว้ใน spec

## Spec reference

`development/architecture/specs/ui/grid-engine.md` (status: Draft) — 16px grid, snap, guides, collision detection,
auto rearrangement, layout engine APIs

## Depends on

`02-widget-layer-rendering.md` (ต้องมี widget layer ก่อนถึงจะมีอะไรให้จัด grid) — เป็น
dependency ของ `13-widget-drag-drop.md` ด้วย (drop flow อิง grid cell)

## Files to touch

_(ยังไม่ระบุ — คาดว่าต้องมีโมดูลใหม่ เช่น `products/extension/lib/gridEngine.js`)_

## Steps

_(รอ spec `development/architecture/specs/ui/grid-engine.md` ขยายจาก Draft ให้ครบก่อนเริ่ม implement)_

## Acceptance criteria

- [ ] _(รอกำหนดจาก spec ฉบับเต็ม)_

## Out of scope

_(ยังไม่ระบุ)_

## Notes from implementation

_(เติมหลังทำเสร็จ)_
