# PUBLISHING_A_WIDGET.md — สร้างและแจกจ่าย widget ของคุณเอง

เอกสารนี้สำหรับคนที่ไม่เคยเห็น codebase ของ GNOME Widget Center มาก่อน และอยากสร้าง widget
ของตัวเอง แล้วแจกให้คนอื่นติดตั้งได้ ไม่ต้องอ่านโค้ดใน `extension/` เลย — อ่านแค่เอกสารนี้
กับ [`docs/WIDGET_API.md`](WIDGET_API.md) (สเปกเต็มของสิ่งที่ widget หนึ่งตัว "ต้อง" ทำ/ห้ามทำ)
ก็สร้าง widget ที่ใช้งานได้จริงได้เลย

ข้อกำหนดเดียว: เครื่องที่จะรัน widget ต้องติดตั้ง GNOME Widget Center (ตัว extension หลัก)
ไว้แล้วและเปิดใช้งานอยู่ — เอกสารนี้ไม่ครอบคลุมการติดตั้งตัว extension หลักเอง

## 1. Quick start — 4 ขั้นตอน

1. **Copy** โฟลเดอร์ `widgets/_template/` ทั้งโฟลเดอร์ ไปเป็นโฟลเดอร์ใหม่ชื่อ widget ของคุณ
   เช่น `my-widget/` (ชื่อโฟลเดอร์ต้องตรงกับ `id` ใน `metadata.json` — ดูข้อ 2)

2. **แก้ 3 ไฟล์** ในโฟลเดอร์ที่ copy มา:
   - `metadata.json` — เปลี่ยน `id`, `name`, `description`, `author` เป็นของ widget คุณ
     (มี `// TODO:`-style placeholder ระบุจุดที่ต้องแก้อยู่แล้ว — ฟิลด์อื่น ๆ ปล่อยไว้เป็นค่า
     default ได้ก่อน)
   - `widget.js` — แก้ `buildActor()` ให้แสดงสิ่งที่ widget คุณต้องการจริง ๆ (ไฟล์นี้มี
     `// TODO:` กำกับไว้ทุกจุดที่ควรแก้ พร้อมตัวอย่างการใช้ `enable()`/`disable()`/
     `getDefaultSettings()` ที่ทำงานได้จริงอยู่แล้ว — ลบส่วนที่ไม่ใช้ได้)
   - `prefs.js` — ถ้า widget มี settings ให้ผู้ใช้ปรับ ให้เพิ่ม row ตาม comment ตัวอย่างในไฟล์
     (ถ้าไม่มี settings เลย ลบไฟล์นี้ทิ้งได้ พร้อมลบบรรทัด `"prefs"` ออกจาก `metadata.json`)

3. **วางโฟลเดอร์** ไว้ที่:
   ```
   ~/.local/share/gnome-widget-center/widgets/my-widget/
   ```
   (สร้างโฟลเดอร์นี้เองถ้ายังไม่มี — path นี้คือที่ที่ host สแกนหา widget ที่ผู้ใช้ติดตั้งเอง
   นอกเหนือจาก widget ที่มากับตัวโปรเจกต์ ดู `docs/ARCHITECTURE.md` §2.2)

4. **ดูผลบนพื้นโต๊ะ**: เปิด Control Center ของ GNOME Widget Center (ไอคอนใน system tray/quick
   settings ตามที่ตัว extension หลักติดตั้งไว้) — widget ใหม่จะโผล่ในลิสต์อัตโนมัติ (Control
   Center สแกนโฟลเดอร์ใหม่ทุกครั้งที่เปิดหน้าต่าง) กด toggle เปิดใช้งาน widget นั้น — จะโผล่บน
   พื้นโต๊ะทันทีโดยไม่ต้อง restart shell (การ toggle ใด ๆ ใน Control Center จะสั่งให้ host สแกน
   หาโฟลเดอร์ widget ใหม่ทั้งหมดอีกครั้งเสมอ ไม่ใช่แค่ widget ที่ถูก toggle)

   ถ้ายังไม่โผล่: ปิด/เปิด Control Center อีกครั้ง หรือ restart gnome-shell (Wayland: log out
   แล้ว log in ใหม่ — GNOME Shell บน Wayland ไม่รองรับคำสั่ง restart แบบ X11's `Alt+F2` → `r`)

**ระหว่างพัฒนา** ถ้าเปิด dev-mode ไว้ (ดู `tasks/08-hot-reload-dev-mode.md`) การแก้ไฟล์ของ
widget ที่ถูกโหลดอยู่แล้ว (เช่นแก้สีใน `stylesheet.css` หรือ logic ใน `widget.js`) จะเห็นผลใน
~1 วินาทีโดยไม่ต้องทำขั้นตอน 4 ซ้ำ — แต่ dev-mode ใช้ได้กับ widget ที่ "โหลดอยู่แล้ว" เท่านั้น
widget ที่เพิ่งสร้างโฟลเดอร์ใหม่ยังต้องผ่านขั้นตอน 4 (เปิด Control Center + toggle) ครั้งแรก
ก่อนเสมอ

## 2. วิธีแจกจ่าย widget ของคุณ

หลังผ่าน checklist ในข้อ 3 แล้ว มี 3 วิธีหลักในการแจกให้คนอื่นใช้:

### 2.1 Zip โฟลเดอร์

วิธีง่ายที่สุด — zip แค่โฟลเดอร์ widget เดียว (ไม่ต้อง zip ทั้ง repo):

```
zip -r my-widget.zip my-widget/
```

แจกไฟล์ `.zip` นี้ตรง ๆ (เช่นแนบใน GitHub Release, ส่งลิงก์) ผู้ใช้ปลายทาง unzip แล้วย้าย
โฟลเดอร์ไปตามขั้นตอน 3 ด้านบนเอง

### 2.2 Git repo แยกต่างหาก

ถ้า widget ของคุณจะอัปเดตต่อเนื่อง ให้แยก repo ของตัวเอง (ไม่ต้อง fork
`gnome-widget-center` ทั้งโปรเจกต์) — repo root ควรมีแค่เนื้อหาของโฟลเดอร์ widget เดียว
(`metadata.json` อยู่ที่ root ของ repo เลย ไม่ต้องมีโฟลเดอร์ครอบอีกชั้น) ผู้ใช้ปลายทาง
`git clone` แล้ว rename โฟลเดอร์ที่ได้ให้ตรงกับ `id` ก่อนย้ายไปตามขั้นตอน 3

### 2.3 วิธีให้ผู้ใช้ปลายทางติดตั้ง (สรุปสั้นสำหรับใส่ใน README ของ widget คุณเอง)

```
1. ดาวน์โหลด/clone widget นี้
2. ย้าย (หรือ symlink) โฟลเดอร์ไปที่:
   ~/.local/share/gnome-widget-center/widgets/<id-ของ-widget-นี้>/
   (ชื่อโฟลเดอร์ปลายทางต้องตรงกับ "id" ใน metadata.json ของ widget นี้)
3. เปิด Control Center ของ GNOME Widget Center แล้วเปิดใช้งาน widget นี้จากลิสต์
```

## 3. Checklist ก่อนแจก

ก่อนแจก widget ของคุณ ให้ผ่านทุกข้อใน **§7 "Checklist ก่อนส่ง widget เข้าโปรเจกต์ (หรือแจกเอง)"
ของ [`docs/WIDGET_API.md`](WIDGET_API.md)** ก่อนเสมอ (เช่น `buildActor()` ห้าม throw แม้
settings ว่างเปล่า, `disable()` ต้อง cleanup ครบ, ห้าม hardcode path ของเครื่อง dev) —
เพิ่มเติมเฉพาะสำหรับการแจกจ่าย:

- [ ] ลบไฟล์/โค้ดตัวอย่างที่ไม่ได้ใช้จริงออกจาก template (`// TODO:` ทุกจุดถูกแก้หรือถูกลบแล้ว)
- [ ] `id` ใน `metadata.json` ไม่ชนกับ widget ที่มากับโปรเจกต์เอง (`clock`, `media-player`) หรือ
      widget ที่นิยมของคนอื่น — host จะ reject ถ้า `id` ซ้ำกับ widget ที่โหลดอยู่แล้ว
- [ ] ทดสอบ copy-paste โฟลเดอร์ไปเครื่องอื่น (หรือ user อื่น) แล้วทำตามขั้นตอน 3 ได้จริงโดยไม่มี
      absolute path ของเครื่อง dev เดิมหลงเหลืออยู่
- [ ] ถ้า widget มี `stylesheet.css`: **รู้ข้อจำกัดปัจจุบัน** — host ยังไม่โหลด `stylesheet.css`
      เข้า theme context ให้อัตโนมัติ (ดู comment ในไฟล์ตัวอย่างของ `widgets/clock/`) ต้องพึ่ง
      inline style/`style_class` ที่ประกาศไว้เองใน `widget.js` เป็นหลักไปก่อน
- [ ] มี README สั้น ๆ ของ widget ตัวเอง อธิบายว่า widget ทำอะไร + ขั้นตอนติดตั้ง (ดูตัวอย่างในข้อ 2.3)

## 4. แนวทาง Versioning

- `version` ใน `metadata.json` เป็นเวอร์ชันของ widget คุณเอง (semver ก็ได้ ไม่มีการบังคับรูปแบบ)
  เพิ่มทุกครั้งที่แจกเวอร์ชันใหม่ เพื่อให้ผู้ใช้แยกออกว่าไฟล์ที่ตนมีเป็นเวอร์ชันไหน
- `api-version` **ต้องตรงกับ** เวอร์ชันของ `WidgetAPI` ที่ host เวอร์ชันที่ผู้ใช้ติดตั้งอยู่รองรับ
  (ปัจจุบันคือ `1` — ดู `docs/WIDGET_API.md` §2) ถ้า host เปลี่ยน API แบบ breaking ในอนาคต
  เลขนี้จะขยับ และ widget เก่าที่ยังประกาศเลขเดิมจะถูกปิดใช้งานพร้อมแจ้งเตือนผู้ใช้แทนที่จะ
  crash — **อย่า**เดาเลขนี้เอง หรือใส่เลขที่สูงกว่าที่ host เวอร์ชันปัจจุบันประกาศรองรับจริง
- ถ้า widget ใช้ฟีเจอร์ของ GNOME Shell เวอร์ชันใหม่กว่าขั้นต่ำที่ `docs/WIDGET_API.md` §6
  ระบุไว้ (GNOME Shell 45+) ให้ระบุ `shell-version` เพิ่มใน `metadata.json` ของ widget ด้วย

## เอกสารที่เกี่ยวข้อง

- [`docs/WIDGET_API.md`](WIDGET_API.md) — สเปกเต็มของ `widget.js`/`prefs.js`/`WidgetAPI`
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — ทำไม widget ถึงเป็นโฟลเดอร์ปลั๊กอินอิสระ
  ไม่ต้องแก้ core (§2.2)
- [`docs/SETTINGS_SPEC.md`](SETTINGS_SPEC.md) — รูปแบบไฟล์ settings ที่ `api.settings` ผูกอยู่
- `widgets/_template/` — โฟลเดอร์ตั้งต้นที่ใช้ใน Quick start ข้อ 1
