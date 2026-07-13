# WIDGET_API.md — สัญญาสำหรับผู้พัฒนา Widget

เอกสารนี้คือสิ่งเดียวที่นักพัฒนาภายนอกต้องอ่านเพื่อสร้าง widget ใหม่
โดยไม่ต้องรู้จักโค้ดภายใน `extension/` เลย

## 1. โครงสร้างโฟลเดอร์ของ 1 widget

```
my-widget/
├── metadata.json      # required
├── widget.js          # required — ตัว widget จริงที่แสดงบนพื้นโต๊ะ
├── prefs.js           # optional — หน้า settings ของ widget นี้
├── stylesheet.css      # optional — CSS เฉพาะของ widget นี้ (namespaced อัตโนมัติ)
└── icon.svg            # optional — ใช้แสดงใน Control Center
```

วางโฟลเดอร์นี้ไว้ที่ `~/.local/share/gnome-widget-center/widgets/my-widget/` ก็ใช้งานได้ทันที
(หลังกด "Rescan widgets" ใน Control Center หรือ restart shell)

## 2. metadata.json

```json
{
  "id": "my-widget",
  "name": "My Widget",
  "description": "คำอธิบายสั้น ๆ",
  "version": "1.0.0",
  "author": "ชื่อผู้พัฒนา",
  "api-version": 1,
  "entry": "widget.js",
  "prefs": "prefs.js",
  "default-size": { "width": 220, "height": 140 },
  "default-position": { "x": 40, "y": 40, "monitor": 0 }
}
```

- `id` ต้องตรงกับชื่อโฟลเดอร์ และห้ามชนกับ widget อื่น (host เช็คและ reject ถ้าซ้ำ)
- `api-version` ใช้เช็ค compatibility — ถ้า host เปลี่ยน API แบบ breaking จะขยับเลขนี้ และ
  widget เก่าจะถูกปิดใช้งานพร้อมแจ้งเตือนแทนที่จะ crash

## 3. widget.js — ต้อง export default class ที่มีเมธอดตามนี้

```js
export default class MyWidget {
    /**
     * @param {WidgetAPI} api - ส่งมาจาก host ตอนโหลด
     */
    constructor(api) {
        this._api = api;
        this._settings = api.settings; // อ่าน/เขียนได้เฉพาะของ widget นี้เท่านั้น
    }

    // คืนค่า St.Widget หรือ Clutter.Actor ที่จะถูกวางบนพื้นโต๊ะ
    // ห้าม return null — ถ้ายังไม่พร้อมให้คืน placeholder แล้วอัปเดตทีหลังได้
    buildActor() {
        this._actor = new St.BoxLayout({ style_class: 'my-widget-root', vertical: true });
        // ... เพิ่ม St.Label / St.Icon ฯลฯ
        return this._actor;
    }

    // เรียกหลังจาก actor ถูกใส่เข้า Widget Layer แล้ว — เริ่ม timer/signal ที่นี่
    enable() {}

    // ต้อง cleanup signal/timer ทั้งหมดที่ตั้งไว้ใน enable()
    disable() {}

    // ค่า default ของ settings ตัวนี้ (ใช้ตอนยังไม่มีไฟล์ settings อยู่)
    getDefaultSettings() {
        return { refreshInterval: 60 };
    }
}
```

### กติกาบังคับ (MUST)

- **ห้าม** import `Gtk` ใน `widget.js` (รันใน process ของ Shell — ชน library กับ Clutter/St)
- **ห้าม** เก็บ state ถาวรไว้ที่ระดับ module scope ข้ามรอบ enable/disable (ต้อง cleanup ใน `disable()`)
  ตามกฎ [GNOME Shell Extension Review Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
- ทุก signal ที่ connect ต้อง disconnect ใน `disable()`, ทุก `GLib.timeout_add` ต้อง remove
- ห้ามแก้ไฟล์ใด ๆ นอกโฟลเดอร์ของตัวเอง และห้ามเข้าถึง widget อื่นโดยตรง
  (ถ้าต้องการสื่อสารข้าม widget ให้ร้องขอ event bus ผ่าน `api.bus` — ดู §5)

## 4. prefs.js (optional)

```js
export default class MyWidgetPrefs {
    /**
     * @param {WidgetSettingsHandle} settings - เฉพาะของ widget นี้
     */
    constructor(settings) {
        this._settings = settings;
    }

    // คืนค่า Gtk.Widget (Adw.PreferencesPage แนะนำ) — ถูกฝังใน Control Center
    buildPrefsWidget() {
        const page = new Adw.PreferencesPage();
        // ... สร้าง Adw.PreferencesGroup / Adw.SpinRow ผูกกับ this._settings ...
        return page;
    }
}
```

รันใน process ของ prefs (GTK4) แยกจาก `widget.js` โดยสิ้นเชิง — **ห้าม** import
`St` / `Clutter` / `Meta` / `Shell` ที่นี่

## 5. WidgetAPI (สิ่งที่ host ส่งให้ widget.js)

| Property/Method | คำอธิบาย |
|---|---|
| `api.settings` | object อ่าน/เขียนได้ ผูกกับไฟล์ settings เฉพาะของ widget นี้ (ดู SETTINGS_SPEC.md) |
| `api.monitorInfo` | ข้อมูลจอปัจจุบัน (geometry, scale) |
| `api.position` | ตำแหน่งปัจจุบันของ widget + `setPosition(x, y, monitorIndex)` |
| `api.bus.emit(name, data)` / `api.bus.on(name, cb)` | event bus กลาง สำหรับ widget ที่ต้องการสื่อสารกันแบบ opt-in เท่านั้น |
| `api.logger` | logging ที่มี prefix widget id ให้อัตโนมัติ |

## 6. เวอร์ชันขั้นต่ำที่รองรับ

- GNOME Shell 45+ (ES module extension API) — ทดสอบหลักบน GNOME 50 / Wayland
- ถ้า widget ใช้ฟีเจอร์ที่มีเฉพาะเวอร์ชันใหม่กว่า ให้ระบุใน `metadata.json` ด้วย `shell-version`

## 7. Checklist ก่อนส่ง widget เข้าโปรเจกต์ (หรือแจกเอง)

- [ ] `buildActor()` ไม่ throw exception แม้ settings จะยังว่างเปล่า
- [ ] `disable()` cleanup ครบ (เทียบกับทุกอย่างที่ทำใน `enable()`)
- [ ] ทดสอบตอนสลับจอ/ปลดจอ/เปลี่ยนความละเอียด
- [ ] ทดสอบตอน lock/unlock screen (widget ต้องไม่โผล่บนหน้า lock)
- [ ] ไม่มี hardcoded path, ไม่มี absolute path ของเครื่อง dev

## 8. เข้าถึง external system DBus service (เช่น media player) จาก `widget.js`

widget บางตัวต้องแสดง/ควบคุมข้อมูลจาก service ของระบบที่มีอยู่แล้ว (คนละเรื่องกับ host settings
ของเราเอง ซึ่งยังคงเป็น JSON file ตาม `SETTINGS_SPEC.md` เสมอ — **ไม่มี DBus service กลางของ
Widget Center เอง**) ตัวอย่างที่พบบ่อยที่สุดคือ "Now Playing" widget ที่คุยกับ media player
ผ่านมาตรฐาน **MPRIS2** (`org.mpris.MediaPlayer2.*` บน session bus) — แนวทางเดียวกับ widget
"Media Player" ของ KDE Plasma

widget ทำได้โดยตรงผ่าน `Gio.DBusProxy` ใน `widget.js` — ไม่ต้องผ่าน host, ไม่ต้องมี hook
พิเศษเพิ่มใน `WidgetAPI`:

```js
import Gio from 'gi://Gio';

const proxy = new Gio.DBusProxy.new_for_bus_sync(
    Gio.BusType.SESSION,
    Gio.DBusProxyFlags.NONE,
    null,
    'org.mpris.MediaPlayer2.<player-name>',
    '/org/mpris/MediaPlayer2',
    'org.mpris.MediaPlayer2.Player',
    null
);

// อ่านค่า
const metadata = proxy.get_cached_property('Metadata')?.deep_unpack();
const status = proxy.get_cached_property('PlaybackStatus')?.deep_unpack();

// สั่งงาน
proxy.call('PlayPause', null, Gio.DBusCallFlags.NONE, -1, null, null);

// subscribe การเปลี่ยนแปลง (อย่า poll ด้วย timer)
proxy.connect('g-properties-changed', (_p, changed) => { /* ... */ });
```

### กติกาบังคับ (MUST)

- ต้อง handle กรณี service เป้าหมายไม่มีอยู่ (เช่น ไม่มี media player เปิดอยู่เลย) แบบ graceful —
  `buildActor()` ห้าม throw เด็ดขาด ให้แสดง placeholder/สถานะว่างแทน (เช่น "No media playing")
- Subscribe ผ่าน signal (`g-properties-changed` ของ proxy หรือ `NameOwnerChanged` ของ
  `org.freedesktop.DBus` เพื่อรู้ว่า service เปิด/ปิด) — **ห้าม** poll ด้วย
  `GLib.timeout_add` ถี่ๆ เพื่อเช็คสถานะ (สิ้นเปลือง battery/CPU และขัดกับ
  [GNOME Shell Extension Review Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
  เรื่อง background polling)
- ทุก `Gio.DBusProxy` และทุก signal ที่ connect ไว้ ต้อง disconnect/ปล่อยใน `disable()`
  เหมือน signal อื่นๆ ตามกฎ §3 ของเอกสารนี้
- **ห้าม** เขียนข้อมูลที่อ่านได้จาก service ภายนอก (เช่น ชื่อเพลงที่กำลังเล่น) ลงไฟล์ settings
  ของ widget เอง — มันเป็น state ชั่วคราวจากระบบภายนอก ไม่ใช่ค่าที่ผู้ใช้ตั้งค่าไว้ เก็บไว้ใน
  instance field ธรรมดาพอ
- ถ้า service เป้าหมายอาจมีมากกว่า 1 instance เปิดพร้อมกัน (เช่น media player หลายตัว) ให้
  documentation ของ widget ระบุพฤติกรรมการเลือกไว้ชัดเจน (เช่น "เลือกตัวแรกที่เจอ")
  ไม่ใช่ crash หรือสุ่มเอา
