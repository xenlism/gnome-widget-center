# Size Constraints (Task 14)

กำหนดขนาด Min/Max ของ Widget ผ่าน `sizeConstraintManager.js`
เพื่อป้องกัน Widget บางประเภทถูกย่อขยายจนเล็กหรือใหญ่เกินไป

## Where constraints live

Constraint ต่อ widget ประกาศใน `metadata.json` ของ widget นั้นเองผ่าน key
`size-constraints` (`{minW, minH, maxW, maxH}`) — เหมือน pattern ของ settings
schema (task 05): widget author ประกาศเอง ไม่ต้องแก้ host/extension source
ถ้า widget ไม่ประกาศ key นี้ `SizeConstraintManager` fallback ไปใช้ค่า default
เดียวกันสำหรับทุก widget (`minW:50, minH:50, maxW:1000, maxH:1000`)

## Timing (สำคัญ)

`applyConstraints()` ต้องถูกเรียก **หลัง** `WidgetLayer.addWidgetActor()` เท่านั้น
— ก่อนหน้านั้น actor ยังไม่เคย parent เข้า container/ยังไม่เคย allocate เลย
`actor.get_size()` จะได้ `(0, 0)` กลับมาแทบทุกครั้ง ถ้าเอาไป clamp ตรงๆ ก่อน
วางจะกลายเป็นบังคับ widget ทุกตัวให้เหลือขนาด min ทันทีโดยไม่ตั้งใจ
`sizeConstraintManager.js` เองก็ fallback ไปใช้
`get_preferred_width()`/`get_preferred_height()` (natural size) เมื่อ `get_size()`
คืน 0 มาเป็น defense-in-depth อีกชั้นนึง แต่ caller (`extension.js`) ก็ยังต้อง
เรียกหลังวางอยู่ดี

`applyConstraints()` เป็น no-op ถ้าขนาดปัจจุบัน/natural size อยู่ในขอบเขตอยู่แล้ว
— ไม่บังคับ `set_size()` เปล่าๆ ทับ layout ธรรมชาติของ widget ที่ไม่ได้เกินขอบเขต
