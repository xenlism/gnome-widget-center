# ARCHITECTURE.md

## 1. ปัญหาที่ต้องแก้

- xenlism/showtime ใช้ GTK4 window แยกโปรเซส + X11 hint ให้หน้าต่างฝังตัวบนพื้นโต๊ะ
  → ใช้ไม่ได้บน Wayland เพราะ compositor (mutter) ไม่ยอมให้ client ภายนอกสั่งจัดชั้น/ตำแหน่งแบบนั้น
- ต้องรองรับ "เพิ่ม widget โดยไม่แก้ core" → ต้องมีระบบปลั๊กอิน (plugin/loader)
- ต้องมี settings แยกต่อ widget → ห้ามพึ่ง GSettings schema ที่ต้อง compile ติดตั้งระดับระบบ
  (เพราะนั่นเท่ากับบังคับ third-party widget ทุกตัวต้องมีขั้นตอนติดตั้งแบบ root/system ซึ่งขัดกับเป้าหมาย
  "ติดตั้งเพิ่มเองได้ไม่ต้องแตะ core")

## 2. การตัดสินใจหลัก (Key Decisions)

### 2.1 เรนเดอร์ widget อยู่ "ใน process ของ GNOME Shell" ไม่ใช่ spawn โปรเซสแยก

GNOME Shell extension รันอยู่ภายใน process ของ Shell เอง ซึ่ง**เป็นตัว compositor เอง**
(ทั้งบน X11 และ Wayland) ดังนั้น extension มีสิทธิ์เข้าถึง Clutter/St/Meta API ได้โดยตรง
ไม่ต้องพึ่ง window-manager protocol จากภายนอกเหมือนโปรแกรมทั่วไป — นี่คือจุดที่ทำให้
วิธีนี้ **ใช้ได้เหมือนกันทั้ง X11 และ Wayland**

แนวทาง: widget แต่ละตัวคือ `St.Widget` / `Clutter.Actor` ที่ถูกใส่เข้าไปใน actor-group พิเศษ
("Widget Layer") ที่ extension สร้างขึ้น แล้วแทรกไว้ **ต่ำกว่าหน้าต่างของแอปทั้งหมด
แต่สูงกว่าพื้นหลัง (wallpaper)** — ตำแหน่งเดียวกับที่ DING (Desktop Icons NG) ใช้แสดงไอคอนบนพื้นโต๊ะ

ข้อดี:
- ไม่มีปัญหาเรื่อง window positioning/always-on-bottom/click-through ที่เจอบน Wayland
- ไม่ต้อง spawn subprocess, ไม่ต้อง IPC ระหว่างโปรเซส
- widget วาดด้วย St + CSS (เหมือนเขียน UI ของ Shell เอง) เบากว่าเปิด GTK4 window แยกทุก widget

ข้อเสีย/ข้อจำกัดที่ต้องรับรู้และ validate ใน Day 1 (`tasks/00-project-setup.md`):
- St widget มีชุด CSS/สไตล์จำกัดกว่า GTK4 เต็มรูปแบบ → widget ที่ต้องการ UI ซับซ้อนมากอาจทำยากกว่า
- ต้อง "หลอก" ให้เหมือนอยู่บนพื้นโต๊ะ ไม่ทับ/บัง notification, overview, lock screen ฯลฯ ต้อง
  connect เข้ากับ `overview showing/hiding`, session-mode ให้ถูกต้อง
- multi-monitor ต้องคำนวณตำแหน่งเองต่อจอ

### 2.2 Widget = ปลั๊กอิน (โฟลเดอร์อิสระ) ไม่ต้องแก้ core

Host extension มีหน้าที่แค่: **ค้นหา (discover) → โหลด (load) → maintain lifecycle** ของ widget
โดยสแกนโฟลเดอร์:

```
~/.local/share/gnome-widget-center/widgets/<widget-id>/    # widget ที่ผู้ใช้ติดตั้งเอง
<extension-dir>/widgets/<widget-id>/                        # widget ที่มากับตัวโปรเจกต์ (bundled)
```

widget ใหม่ = สร้างโฟลเดอร์ใหม่ตามสเปกใน `docs/WIDGET_API.md` แล้ววางไว้ในพาธข้างบน
**ไม่ต้องแตะไฟล์ใน `extension/` เลย**

### 2.3 Settings แยกต่อ widget แบบไม่ใช้ GSettings schema ระดับระบบ

ใช้ JSON file settings store แทน:

```
~/.config/gnome-widget-center/widgets/<widget-id>.json
```

Host จัดการ read/write/validate (มี default + merge) ให้ แล้วส่ง object `settings` ผ่าน
`WidgetAPI` เข้าไปให้ widget ใช้ — widget ไม่ต้องยุ่งกับไฟล์เอง ดูรายละเอียดใน
`docs/SETTINGS_SPEC.md`

ส่วน "Host-level settings" (เช่น รายชื่อ widget ไหนเปิด/ปิดอยู่, ตำแหน่งของแต่ละ widget)
เก็บแยกเป็นของ core เอง ใน `extension/schemas/...gschema.xml` (อันเดียวที่ยัง compile
เป็น GSettings จริง เพราะเป็นของ core ไม่ใช่ของ third-party)

### 2.4 Control Center (GUI จัดการ widget)

`extension/prefs.js` เป็น GTK4/Libadwaita window แสดง list widget ที่ค้นพบทั้งหมด
(เปิด/ปิด toggle, ปุ่ม "Settings" ต่อตัว) — เมื่อกด "Settings" ของ widget ใดตัวหนึ่ง
Control Center จะโหลด `prefs.js` ของ widget นั้น (ถ้ามี) มาแสดงเป็นหน้าย่อย
โดยส่ง settings object ของ widget นั้น ๆ เท่านั้นเข้าไป (sandboxed ต่อ widget)

## 3. Layering Diagram (แนวคิด)

```
[ Lock screen / Overview UI ]        <- สูงสุด, จัดการโดย Shell เอง
[ Normal application windows ]
[ >>> Widget Layer (ของเรา) <<< ]     <- widgets ทั้งหมดอยู่ชั้นนี้
[ Desktop icons (ถ้ามี, เช่น DING) ]
[ Wallpaper / background ]           <- ต่ำสุด
```

## 4. Data flow ตอน enable widget

```
Extension.enable()
  → WidgetLoader.discoverWidgets()          // scan โฟลเดอร์, อ่าน metadata.json
  → for each widget ที่ enabled ใน host settings:
      settings = WidgetSettings.load(widget.id)
      api = new WidgetAPI({ settings, layer: WidgetLayer, monitorInfo, dragController })
      instance = widget.module.default (api)   // widget constructor
      actor = instance.buildActor()
      WidgetLayer.addWidgetActor(widget.id, actor, savedPosition)
      instance.enable()
```

## 5. เทคโนโลยีที่ใช้

- GJS (GNOME 45+ ES module extension style — `export default class extends Extension`)
- St / Clutter (สำหรับตัว widget บนพื้นโต๊ะ)
- GTK4 + Libadwaita (สำหรับ prefs.js / Control Center เท่านั้น — ห้ามใช้ St/Clutter/Meta ใน prefs process
  และห้ามใช้ Gtk ใน extension.js process ตามกฎของ GNOME Shell extension review guidelines)
- JSON (สำหรับ per-widget settings)

## 6. สิ่งที่ต้อง validate ก่อนลงมือสร้างจริง (= tasks/00)

1. แทรก actor ลงใน layer ต่ำกว่า window group ได้จริงบน GNOME 50 / Wayland หรือไม่ ตำแหน่งไหนใน
   scene graph ที่ถูกต้อง (`global.window_group`, `Main.layoutManager._backgroundGroup`, หรือ
   ต้องสร้าง group ใหม่แล้วแทรกด้วย `insert_child_below`)
2. พฤติกรรมตอนสลับ workspace / overview / fullscreen แอป — widget ควรซ่อน/โผล่เมื่อไหร่
3. รองรับ multi-monitor และการเปลี่ยนความละเอียดจอ (`monitors-changed` signal)
