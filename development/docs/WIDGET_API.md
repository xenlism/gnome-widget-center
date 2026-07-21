# WIDGET_API.md — สัญญาสำหรับผู้พัฒนา Widget

เอกสารนี้คือสิ่งเดียวที่นักพัฒนาภายนอกต้องอ่านเพื่อสร้าง widget ใหม่
โดยไม่ต้องรู้จักโค้ดภายใน `products/extension/` เลย

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
  "block-type": { "cols": 14, "rows": 9 },
  "default-position": { "x": 40, "y": 40, "monitor": 0 }
}
```

- `id` ต้องตรงกับชื่อโฟลเดอร์ และห้ามชนกับ widget อื่น (host เช็คและ reject ถ้าซ้ำ)
- `api-version` ใช้เช็ค compatibility — ถ้า host เปลี่ยน API แบบ breaking จะขยับเลขนี้ และ
  widget เก่าจะถูกปิดใช้งานพร้อมแจ้งเตือนแทนที่จะ crash
- `block-type` (`{cols, rows}`) — ขนาดจริงบนจอ **เป็นจำนวน grid cell** ไม่ใช่ pixel
  ตรงๆ (ดู `development/architecture/specs/ui/size-constraints.md` — ระบบ block-type)
  host จะคูณด้วย `GridEngine.cellSize` (ปัจจุบัน 16px/cell) ให้เองตอนวาง widget ไม่ต้อง
  ประกาศ `default-size` เป็น pixel อีกต่อไป ถ้าไม่ประกาศ field นี้เลย จะได้ค่า default
  กลาง (`10 x 6` cell) แทน — ขนาดนี้คือขนาดจริงตายตัว **ไม่มี min/max และผู้ใช้ resize
  เองไม่ได้** (ดู size-constraints.md — ไม่มี field `size-constraints` อีกต่อไป)
- `themeable` (optional boolean, default `false`) — opts a widget's own
  FRONT actor into the host-wide theme system (see
  `development/docs/THEME_SYSTEM.md`): its background/drop-shadow is
  styled from `theme.json`'s global appearance settings (with any
  per-widget override under that file's `widgets.<id>.config`) via
  `ThemeService.applyWidgetStyle()`, called once when the widget is
  placed and again live whenever `theme.json` changes. Leave unset (or
  `false`) for widgets that already paint their own background in
  `stylesheet.css`/their own code (e.g. macos-clock) — this field exists
  so the host theme never silently overrides a widget's own design
  without the widget author asking for it.

### 2.1 `settings` (optional) — declarative settings schema (task 05)

ทางเลือกแทนการเขียน `prefs.js` เอง: ประกาศ field ของ settings เป็น array ตรงๆ ใน
`metadata.json` แล้ว Control Center จะสร้างหน้า GTK4/Libadwaita ให้อัตโนมัติ
(`settingsSchemaUI.js`) — widget author ไม่ต้องรู้จัก Gtk/Adw เลยสำหรับ settings ธรรมดา

```json
{
  "id": "clock",
  "name": "Clock",
  "entry": "widget.js",
  "settings": [
    {
      "id": "format24h",
      "type": "boolean",
      "label": "24-hour format",
      "default": true
    },
    {
      "id": "fontSize",
      "type": "range",
      "label": "Font size",
      "description": "Size in points",
      "default": 32,
      "min": 12,
      "max": 96,
      "step": 1
    },
    {
      "id": "accentColor",
      "type": "color",
      "label": "Accent color",
      "default": "#3584e4"
    },
    {
      "id": "labelFont",
      "type": "font",
      "label": "Label font",
      "default": "Sans Bold 12"
    },
    {
      "id": "iconSize",
      "type": "size",
      "label": "Icon size",
      "description": "Pixels",
      "default": 32,
      "min": 16,
      "max": 128,
      "step": 1
    }
  ]
}
```

**Type ที่รองรับใน v1:** `string`, `number`, `range`, `boolean`, `dropdown`, `color`, `font`, `size`
(field-level กฎเต็มอยู่ใน `products/extension/lib/settingsSchema.js`'s `validateSettingsSchema()`
— เช่น `range`/`size` (ถ้าประกาศ `min`/`max`) ต้องมี `min`/`max` เป็นตัวเลขคู่กัน, `dropdown`
ต้องมี `options`, `font` ต้องมี `default` เป็น string อย่าง `"Sans 10"`)

- `size` ต่างจาก `range` ตรงที่ `min`/`max` เป็น **optional** — ถ้าไม่ประกาศจะได้ช่วงกว้างๆ
  0–10000px แทน (เหมาะกับ "ขนาดพิกเซลทั่วไป ไม่อยากบังคับขอบเขต" ต่างจาก `range` ที่บังคับ
  `min`/`max` เสมอ) ค่าที่เก็บ/อ่านจาก `api.settings` เป็นตัวเลข pixel ธรรมดา
- `font` เก็บ/อ่านจาก `api.settings` เป็น **string** ธรรมดา (ผลลัพธ์ของ
  `Pango.FontDescription.to_string()`, เช่น `"Sans Bold 12"`) — widget.js ไม่ต้อง import
  Pango เองเพื่ออ่านค่านี้ แค่ parse string เองถ้าต้องใช้ family/size แยกกัน

**ยังไม่รองรับในรอบนี้ (out of scope):** `file`, `folder`, `desktop-file`, `command`, `date`,
`time`, `password`, `url`, `icon`, `label`/`separator`/`group` (structural) — ต้องใช้
`prefs.js` เขียนเองไปก่อนถ้าต้องการ type พวกนี้

**ถ้ามีทั้ง `prefs.js` และ `settings` พร้อมกัน:** `prefs.js` ชนะเสมอ — ถือว่าเป็นการเลือกเอง
ของ author ที่จะ opt-out จาก auto-generation (โค้ดเขียนเองทำอะไรก็ได้มากกว่า schema อยู่แล้ว)

**Default value:** มาจาก `settings[].default` เสมอ — รวมเข้ากับ (และถูก
`instance.getDefaultSettings()` ทับได้ถ้า key ซ้ำกัน) ตอนโหลด widget ครั้งแรก เหมือนกับ
defaults ที่มาจาก `getDefaultSettings()` เดิมทุกประการ (ดู `development/docs/SETTINGS_SPEC.md`)

**Validation:** ถ้า `settings` array มีปัญหาโครงสร้าง (เช่น `id` ซ้ำ, `type` ไม่รู้จัก, `range`
ไม่มี `min`/`max`) — widget ทั้งตัวจะไม่ถูกโหลด และไปโผล่ในรายการ error ของ Control Center
เหมือน `metadata.json` พังปกติ (ดู `WidgetLoader.discover()`)

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

    // Optional — เรียกเมื่อ settings ของ widget นี้เปลี่ยนจาก "นอก" process
    // ของ widget เอง (เช่น ผู้ใช้แก้ค่าใน Control Center ซึ่งรันอยู่คนละ
    // process กับตัว widget) โดย `api.settings` (this._settings) จะถูก
    // อัปเดตให้ตรงกับค่าใหม่บนดิสก์แล้ว "ก่อน" เรียก hook นี้เสมอ — ใช้ทำ
    // อะไรก็ตามที่ buildActor() ไม่ได้ทำอัตโนมัติซ้ำทุก frame อยู่แล้ว เช่น
    // อัปเดต label ที่ set ไว้ครั้งเดียวตอน enable(), หรือ re-fetch ข้อมูล
    // จาก DBus service ด้วยค่า config ใหม่ ไม่จำเป็นต้องมีถ้า widget อ่าน
    // this._settings สดใหม่ทุกครั้งอยู่แล้ว (เช่นใน timer update loop)
    onSettingsChanged(settings) {}
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
| `api.settings` | object อ่าน/เขียนได้ ผูกกับไฟล์ settings เฉพาะของ widget นี้ (ดู SETTINGS_SPEC.md) — object เดียวกันนี้จะถูกอัปเดตให้เองแบบ live ถ้ามีการแก้ผ่าน Control Center (คนละ process) ด้วย ดู `onSettingsChanged()` ด้านบน |
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

## 9. อ่านค่า System Metrics (CPU / RAM / Network) จาก `widget.js`

widget ที่ต้องการแสดงสถานะเครื่อง (CPU, RAM, network throughput, รายชื่อ network
device) ใช้ `SystemMetricsService` จาก `lib/systemMetricsApi.js` ได้เลย — เป็น
class เดียวกับที่ `widgets/system-stats/widget.js` (bundled) ใช้อยู่ ไม่ต้องเขียน
`/proc` parsing เองใหม่

**ข้อจำกัดสำคัญ:** import แบบ relative path (`../../lib/systemMetricsApi.js`) ใช้ได้
เฉพาะ widget ที่ bundle มากับ extension นี้เท่านั้น (เช่น `system-stats`) — widget
ของบุคคลภายนอกที่ติดตั้งไว้ที่ `~/.local/share/gnome-widget-center/widgets/` จะ
**import ไฟล์นี้ไม่ได้** เพราะอยู่คนละโฟลเดอร์กันโดยสิ้นเชิง ไม่มี path เชื่อมถึงกัน
(เหมือนกับข้อจำกัดของ `lib/mediaApi.js` ใน §8) ไฟล์นี้ยังไม่ถูก expose เป็น
`api.system` ให้ widget ทุกตัวเรียกได้ — ถ้าต้องการแบบนั้นในอนาคต เป็นการเพิ่ม API
แบบตั้งใจ (ต้องแก้ `widgetLoader.js`'s `_buildApi()` + เอกสารนี้คู่กัน) ไม่ใช่ผลพลอยได้
เงียบๆ จากการเปลี่ยนแปลงอื่น

```js
import {SystemMetricsService} from '../../lib/systemMetricsApi.js';

export default class MyWidget {
    constructor(api) {
        this._api = api;
        // instance เดียวต่อ widget instance เดียว — ค่า CPU%/network
        // throughput เป็นค่า "delta ตั้งแต่ครั้งก่อนที่เรียกเมธอดเดิม" จึงต้อง
        // เก็บ state ไว้ใน object นี้ (ดูคอมเมนต์ในไฟล์ systemMetricsApi.js)
        this._metrics = new SystemMetricsService();
    }

    enable() {
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            const {cpu, memory, network, devices} = this._metrics.sample();
            // cpu.percent, memory.percent, network.totalRxBytesPerSec, ...
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        GLib.source_remove(this._timerId);
    }
}
```

**เมธอดที่มี** (แต่ละอันเป็น synchronous snapshot อ่านครั้งเดียว ไม่มี timer/polling
ของตัวเอง — widget เป็นคนตั้ง timer เรียกเองตามจังหวะที่ต้องการ):

| เมธอด | คืนค่า |
|---|---|
| `getCpuUsage()` | `{percent}` — CPU รวมทุก core ตั้งแต่ครั้งก่อนที่เรียกเมธอดนี้ (ครั้งแรกได้ 0 เสมอ) |
| `getMemoryUsage()` | `{totalKb, availableKb, usedKb, percent}` — ค่า ณ ขณะนั้น ไม่ต้องมีค่าครั้งก่อน |
| `getNetworkUsage()` | `{interfaces: [{name, rxBytesPerSec, txBytesPerSec, rxTotalBytes, txTotalBytes}], totalRxBytesPerSec, totalTxBytesPerSec}` — throughput ตั้งแต่ครั้งก่อน (ครั้งแรกได้ 0 เสมอ) |
| `listNetworkDevices()` | `[{name}]` — รายชื่อ interface ทั้งหมดที่เจอ (รวม `lo`, กรองเองถ้าไม่ต้องการ) |
| `sample()` | รวมทั้ง 4 อย่างข้างบนไว้ใน `{cpu, memory, network, devices}` เดียว — สะดวกถ้า widget มี timer เดียวที่อยากได้ทุกอย่างพร้อมกัน |

### กติกาบังคับ (MUST)

- **ห้าม** เรียกเมธอดเหล่านี้จาก timer ที่ถี่กว่าที่จำเป็นจริง (เช่นทุก 100ms) —
  เป็นการอ่านไฟล์ `/proc/*` ทุกครั้ง ถี่เกินไปสิ้นเปลือง CPU โดยใช่เหตุ ค่า default ของ
  `system-stats` เอง (ทุก 1-10 วินาที ปรับได้ผ่าน settings) เป็นตัวอย่างช่วงเวลาที่เหมาะสม
- แต่ละ widget instance ต้องมี `SystemMetricsService` เป็นของตัวเอง (`new` ใน
  constructor) — อย่า share instance เดียวกันข้าม widget เพราะ state ของ CPU%/network
  delta จะปนกัน
- `getCpuUsage()`/`getNetworkUsage()` คืนค่า 0 เสมอในการเรียกครั้งแรก (ยังไม่มีค่าครั้ง
  ก่อนให้ diff) — เป็นพฤติกรรมที่ตั้งใจ ไม่ใช่ bug ถ้า widget ต้องการค่าที่ "ถูกต้อง" ตั้งแต่
  เฟรมแรก ให้เรียกเมธอดนี้ทิ้งหนึ่งครั้งตอน `enable()` ก่อนเริ่ม timer จริง
