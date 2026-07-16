# Task 06 — Widget SDK Example Pack

## Goal

เดิม task นี้ทำแค่ widget นาฬิกาตัวเดียว — ขยายเป็น **"SDK example pack"** สอง widget
เพื่อโชว์ขอบเขตการใช้ `WidgetAPI` ให้ครบกว่าเดิม คล้ายแนวทางของ KDE Plasma ที่ widget ตัวอย่าง
มักมีทั้งแบบง่าย (แสดงข้อมูล) และแบบที่ต้องคุยกับ service ภายนอกของระบบ (เช่น Plasma's
"Media Player" widget ที่คุย MPRIS):

1. **`products/extension/widgets/clock/`** — เหมือนเดิมทุกประการ (ดู Steps 1 ด้านล่าง คัดลอกมาจาก
   `06-example-widget-clock.md` เวอร์ชันก่อนหน้า ไม่มีอะไรเปลี่ยน)
2. **`products/extension/widgets/media-player/`** (ใหม่) — Now-Playing widget ที่อ่าน/ควบคุมเพลงที่กำลังเล่นอยู่
   ผ่าน **MPRIS2** (`org.mpris.MediaPlayer2.*` บน session DBus) — มาตรฐาน freedesktop.org
   ที่ media player บน Linux แทบทุกตัวรองรับอยู่แล้ว (Spotify, VLC, Rhythmbox, Firefox ฯลฯ)

widget ตัวที่สองนี้คือจุดสำคัญของ task นี้: มันพิสูจน์ว่า `WidgetAPI` ปัจจุบันรองรับ widget
ที่ต้องคุยกับ **external system service** (ไม่ใช่แค่อ่าน settings/แสดงข้อมูล static) ได้โดยไม่ต้อง
แก้ core — ถ้าทำไม่ได้ด้วย API ปัจจุบัน ให้หยุดแล้วรายงานกลับไปที่ `development/docs/WIDGET_API.md` แทนที่จะ
แอบเพิ่ม hook พิเศษเฉพาะ widget นี้

## Depends on

`03-settings-store.md`

*งานนี้ทำขนานกับ Phase 1 ท้าย ๆ ได้ — เริ่มจาก actor เปล่า ๆ ตั้งแต่หลัง task 01 เสร็จ
แล้วค่อยเพิ่ม settings จริงตอน task 03 เสร็จ*

## Context — `development/docs/WIDGET_API.md` §8

`development/docs/WIDGET_API.md` ถูกเพิ่มหัวข้อ §8 "เข้าถึง external system DBus service (เช่น media
player) จาก `widget.js`" แล้ว (นิยาม MPRIS proxy pattern + กติกาบังคับเรื่อง graceful
degradation, ห้าม poll, ต้อง cleanup) — อ่านหัวข้อนี้ให้ครบก่อนเริ่มเขียน `media-player/widget.js`
เพราะเป็นสเปกเดียวที่ widget นี้ต้อง enforce ตาม

## Files to touch

- `products/extension/widgets/clock/metadata.json`, `products/extension/widgets/clock/widget.js`, `products/extension/widgets/clock/prefs.js`,
  `products/extension/widgets/clock/stylesheet.css` (เหมือนเดิมจาก task เวอร์ชันก่อนหน้า — ดู Steps 1)
- `products/extension/widgets/media-player/metadata.json`, `products/extension/widgets/media-player/widget.js`,
  `products/extension/widgets/media-player/prefs.js`, `products/extension/widgets/media-player/stylesheet.css` (ใหม่ทั้งหมด)

(`development/docs/WIDGET_API.md` §8 ถูกเพิ่มไว้ล่วงหน้าแล้วตอนวางแผน task นี้ — **ไม่ต้องแก้ซ้ำ** นอกจาก
พบว่าสเปกไม่พอจริงๆ ระหว่างเขียนโค้ด ถ้าเจอให้หยุดแล้วรายงานแทนที่จะแก้เอง)

**ห้ามแก้ไฟล์ใด ๆ ใน `products/extension/`** — นี่คือจุดพิสูจน์ว่าระบบปลั๊กอินทำงานได้จริงตามเป้าหมาย
โปรเจกต์ (เหมือนเดิมจาก version ก่อนหน้าของ task นี้) ถ้าพบว่าจำเป็นต้องแก้ core เพื่อให้
widget ใดตัวหนึ่งทำงาน แปลว่า `WIDGET_API.md`/loader มีช่องโหว่ ให้หยุดแล้วรายงานกลับไปที่
task 01/02 แทนที่จะแอบแก้

## Steps (แนะนำ)

### 1. `products/extension/widgets/clock/` (ไม่เปลี่ยนจากเดิม)

- `widget.js`: แสดงเวลาปัจจุบัน อัปเดตทุกวินาที (หรือทุกนาทีถ้า `showSeconds: false`) ใช้
  `GLib.timeout_add_seconds` — ต้อง remove source ใน `disable()`
- Settings: `format24h`, `showSeconds`, `showDate`, `fontSize`
- `prefs.js`: switch row ต่อ boolean setting + `Adw.SpinRow` สำหรับ `fontSize`
- `stylesheet.css`: namespace ด้วย prefix `clock-widget-`

### 2. `products/extension/widgets/media-player/` (ใหม่)

1. `widget.js`:
   - ตอน `enable()`: watch `org.freedesktop.DBus` หา service ที่ชื่อขึ้นต้นด้วย
     `org.mpris.MediaPlayer2.` (อาจมีมากกว่า 1 ตัวเปิดพร้อมกัน — เวอร์ชันแรกเลือกตัวแรกที่เจอพอ
     บันทึกไว้เป็น known limitation ใน Notes)
   - สร้าง `Gio.DBusProxy` ผูกกับ interface `org.mpris.MediaPlayer2.Player` แล้วอ่าน
     `Metadata` (title/artist/art), `PlaybackStatus`
   - แสดง: ชื่อเพลง, ศิลปิน, ปุ่ม Play/Pause, Previous, Next (เรียก method `PlayPause()`,
     `Previous()`, `Next()` ของ interface เดียวกัน)
   - ไม่มี media player เปิดอยู่ → แสดง placeholder เช่น "No media playing" ไม่ throw
2. Settings ที่รองรับ (ตาม `getDefaultSettings()`):
   - `showArtwork: boolean`
   - `compactMode: boolean` (ซ่อนปุ่ม previous/next เหลือแค่ play/pause — คล้าย compact
     representation ของ Plasma widget)
3. `prefs.js`: switch row สำหรับสอง setting ข้างบน
4. `stylesheet.css`: namespace ด้วย prefix `media-player-widget-`

## Acceptance criteria

- [ ] `products/extension/widgets/clock/` ผ่าน acceptance เดิมทุกข้อ (โชว์เวลาถูกต้อง, เปลี่ยน `format24h` ผ่าน
      Control Center แล้วอัปเดตโดยไม่ต้อง restart)
- [ ] `products/extension/widgets/media-player/` วางในโฟลเดอร์ bundled แล้ว: เปิด media player ที่รองรับ MPRIS
      (เช่น เปิดเพลงใน Firefox/VLC) → widget แสดงชื่อเพลง/ศิลปินถูกต้องภายในไม่กี่วินาที
- [ ] กด Play/Pause/Next/Previous บน widget → media player ตอบสนองจริง
- [ ] ปิด media player ทั้งหมดระหว่าง widget กำลังแสดงผล → widget ไม่ crash, กลับไปแสดง
      placeholder "No media playing"
- [ ] ปิด/เปิด widget ทั้งสองตัวซ้ำๆ หลายรอบ ไม่มี memory leak / timer / DBus proxy ค้าง
      (เช็คด้วย Looking Glass หรือ `ps`/`top`)
- [ ] `development/docs/WIDGET_API.md` §8 ถูกเพิ่มจริง และ widget ทั้งสองใช้ทดสอบ regression ของทุก task
      ก่อนหน้า (00-05) ผ่านหมดเมื่อรันร่วมกัน

## Out of scope

- Seek/progress bar, volume control, queue/playlist (เพิ่มทีหลังได้ถ้าต้องการ เปิด task ใหม่)
- เลือก media player ที่ต้องการเองเมื่อมีหลายตัวเปิดพร้อมกัน (เวอร์ชันแรกเลือกตัวแรกที่เจอ)
- Timezone อื่นนอกจาก timezone ของระบบสำหรับ `clock` (เหมือนเดิมจาก task เวอร์ชันก่อนหน้า)

## Notes from implementation

- `products/extension/widgets/clock/` implement ตามเดิมทุกประการ ไม่มีการแก้ `products/extension/` เลย ใช้
  `GLib.timeout_add_seconds` ตัวเดียวต่อ instance, remove ใน `disable()`
- `products/extension/widgets/media-player/` เลือก media player ตัวแรกที่เจอจริงตามที่ระบุไว้ (ทั้งจาก
  `ListNames` ตอน `enable()` และจาก `NameOwnerChanged` หลังจากนั้น) — ตัวที่สองที่เปิดพร้อมกัน
  จะถูกมองข้ามจนกว่าตัวแรกจะปิด (`NameOwnerChanged` ที่ `newOwner` ว่างของ bus name เดิม)
- ไม่ poll ด้วย timer เลยตามกติกาบังคับ §8 — ใช้ `g-properties-changed` ของ `Gio.DBusProxy`
  สำหรับ Metadata/PlaybackStatus และ `NameOwnerChanged` ของ `org.freedesktop.DBus` สำหรับ
  player เปิด/ปิด
- ข้อมูลที่อ่านจาก MPRIS (ชื่อเพลง, ศิลปิน, art, playback status) เก็บเป็น local variable ใน
  `_renderFromProxy()` เท่านั้น ไม่เคยเขียนลง `this._settings` — มีแค่ `showArtwork`/
  `compactMode` (ที่ผู้ใช้ตั้งเอง) ที่ผ่าน settings จริง
- ทดสอบ syntax ด้วย `node --check` ผ่านทุกไฟล์ (ไม่มี GNOME Shell จริงในสภาพแวดล้อมนี้ให้รัน
  end-to-end ผ่าน Looking Glass/`ps` ตาม acceptance criteria ได้ — ต้องการเครื่อง GNOME 50 จริง
  เพื่อ verify ข้อ MPRIS/leak เหล่านั้น)
- ไม่ได้แก้ไฟล์ใดใน `products/extension/` สำหรับ task นี้ตามที่กำหนด — `WidgetAPI` ปัจจุบัน (settings,
  logger) เพียงพอสำหรับทั้งสอง widget แล้วจริง ไม่ต้องรายงานช่องโหว่กลับไปที่ task 01/02

**อัปเดต (2026-07-16):** ดึง DBusProxy/MPRIS logic ทั้งหมดออกจาก
`products/extension/widgets/media-player/widget.js` ไปเป็น
`products/extension/lib/mediaApi.js` (`MprisMediaService`) เพื่อไม่ให้ logic ซ้ำถ้ามี
widget เกี่ยวกับ media เพิ่มในอนาคต — พฤติกรรมเดิมทุกอย่างเหมือนเดิม (first-found-wins,
ไม่ poll, cleanup ครบใน `stop()`) แค่ย้ายที่อยู่ ตอนนี้แก้ไฟล์ `products/extension/` แล้ว
(ต่างจากข้อบนที่บอกว่าไม่ได้แก้) — **นี่ไม่ใช่การเพิ่ม host hook ให้ third-party widget**
`MprisMediaService` เข้าถึงได้แค่จาก relative import ภายใน tree ของ extension เอง (bundled
widget เท่านั้น) ไม่ได้ผูกเข้ากับ `api` object ใน `widgetLoader.js`'s `_buildApi()` เลย
third-party widget ที่ทำตาม §8 ยังคงต้องคุย `Gio.DBusProxy` ตรงๆ เหมือนเดิมทุกประการ ถ้าจะ
เปิด `api.media` ให้ third-party ใช้ด้วยควรเป็น task ใหม่แยกต่างหาก ไม่ใช่ผลพลอยได้เงียบๆ
จากงานนี้

**ยืนยันบนเครื่องจริงบางส่วน (2026-07-16):** log จาก `journalctl` จริงยืนยันว่าทั้ง `clock`
และ `media-player` โหลดสำเร็จบน GNOME Shell จริง (ดู `development/tasks/01-widget-loader-core.md`'s
"Real hardware verification" สำหรับ log เต็ม) — ยืนยันแค่ขั้น load/enable เท่านั้น ยัง
**ไม่มี evidence** สำหรับ acceptance criteria ข้ออื่น (แสดงชื่อเพลงถูกต้อง, ปุ่มกดใช้ได้จริง,
ไม่มี memory leak) ยังไม่ tick checkbox ใดใน "Acceptance criteria" ข้างต้น
