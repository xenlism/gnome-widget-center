# Handover: ส่ง kit ให้ widget ผ่าน `api.host.kit`

สถานะ: **ยังไม่ได้ implement** (วางแผนไว้เท่านั้น)
ที่ทำไปแล้วและใช้เป็นทางออกชั่วคราว: symlink `~/.local/share/gnome-widget-center/lib` → `<extension>/lib` (ดูหัวข้อ 1)

---

## 1. สถานะปัจจุบัน (symlink)

Widget import kit ของ host แบบ relative: `import {...} from '../../lib/widgetVisualKit.js'`

- widget ที่มากับ extension: `<ext>/widgets/<id>/widget.js` → `../../lib` = `<ext>/lib` ใช้ได้
- widget ที่ติดตั้งจาก store: `~/.local/share/gnome-widget-center/widgets/<id>/widget.js` → `../../lib` = `~/.local/share/gnome-widget-center/lib` ซึ่งไม่เคยมี → `Error opening file ... lib/systemMetricsApi.js`

ทางแก้ชั่วคราวที่ทำแล้ว:

| ไฟล์ | หน้าที่ |
|---|---|
| `lib/hostLibLink.js` (ใหม่) | `ensureHostLibLink(libDir, logger)` สร้าง/ซ่อม symlink; ไม่ทับ `lib/` ที่เป็นโฟลเดอร์จริง; คืน `true/false` |
| `extension.js` | เรียกตอน `enable()` ก่อนสร้าง loader |
| `lib/shell/widgetRuntimeLoader.js` | เรียกก่อน `import()` ของ widget ทุกตัวใน `loadModule()` (ซ่อมตัวเองถ้า link หาย) |

หมายเหตุ: บน Wayland การ disable/enable extension **ไม่โหลดไฟล์ JS ใหม่** ต้อง logout/login หลังอัปเดตไฟล์

## 2. ทำไมถึงควรเลิกพึ่ง path

1. **ผูกกับโครงสร้างโฟลเดอร์** widget ต้องอยู่ลึก 2 ระดับจาก `lib/` พอดี ไม่งั้น import พัง
2. **อาจโหลดโมดูลซ้ำสองชุด (ยังไม่ได้ยืนยัน)** GJS ระบุโมดูลด้วย URI widget ในตัว extension import ผ่าน `file:///…/extensions/…/lib/x.js` ส่วน widget จาก store import ผ่าน `file:///…/gnome-widget-center/lib/x.js` ถ้า GJS ไม่ resolve symlink จะเป็นสองอินสแตนซ์ที่ state แยกกัน ตัวอย่างที่เสี่ยง: `setGlobalShadowHelper` (widgetVisualKit), singleton/cache ใน `SystemMetricsService`, `MprisMediaService`
   - วิธียืนยัน: ใส่ `console.log(import.meta.url)` ที่หัว `widgetVisualKit.js` แล้วดูว่า log ออกมา 2 ครั้งหรือไม่
3. **พึ่ง symlink** ใช้ไม่ได้ในบางสภาพแวดล้อม (home บน FS ที่ไม่รองรับ, sandbox)
4. widget ที่ย้ายเครื่อง/ย้ายโฟลเดอร์ได้ยาก (loader เคยตั้งใจแก้เรื่อง child widget ให้ portable แล้ว)

## 3. เป้าหมาย: `api.host.kit`

Constructor ของ widget รับ `api` อยู่แล้ว (`new ModuleClass(api)` หรือ `ModuleClass.createInstance(api)` ใน `loadOne()` และ `reloadWidget()`) และมี `api.host = { rescan }` อยู่แล้ว จึงเพิ่ม `api.host.kit` โดยไม่ต้องเปลี่ยนรูปแบบ constructor

```js
// ก่อน
import { SHADOW_DEFAULTS, cardStyleCss } from '../../lib/widgetVisualKit.js';
import { createLayeredCard } from '../../lib/shell/cardLayers.js';

export default class MyWidget {
    constructor(api) { ... SHADOW_DEFAULTS ... }
}

// หลัง
export default class MyWidget {
    constructor(api) {
        const { visual, layers } = api.host.kit;
        const { SHADOW_DEFAULTS, cardStyleCss } = visual;
        const { createLayeredCard } = layers;
    }
}
```

`import ... from 'gi://...'` และ `resource:///org/gnome/shell/...` **ยังใช้ได้เหมือนเดิม** (เป็นของระบบ ไม่ใช่ path ของเรา)

### รูปแบบของ kit (เสนอ)

Export จริงที่มีใน `lib/` (นับจากโค้ดปัจจุบัน) จัดกลุ่มเป็น namespace:

| `kit.<name>` | มาจาก | export หลัก | จำนวน widget ที่ import |
|---|---|---|---|
| `config` | `widgetConfigDefaults.js` | `configJsonDefaults` | 73 |
| `layers` | `shell/cardLayers.js` | `createLayeredCard`, `applyLayeredCardStyle`, `applyCardBlur` | 72 |
| `visual` | `widgetVisualKit.js` | `SHADOW_DEFAULTS`, `BORDER_DEFAULTS`, `OPACITY_DEFAULTS`, `BLUR_DEFAULTS`, `TEXT_SHADOW_DEFAULTS`, `cardStyleCss`, `hexToRgba`, `toCssColor`, `parseFontDescription`, `applyCardOpacity`, `deferUntilMapped`, `resolveCornerRadius`, … | 66 |
| `metrics` | `systemMetricsApi.js` | `SystemMetricsService` | 15 |
| `tooltip` | `shell/widgetTooltip.js` | `attachTooltip` | 10 |
| `fs` | `fsUtils.js` | `fileExists`, `readTextFile…`, `writeTextFile…`, `ensureDirectory`, … | 9 |
| `utils` | `utils.js` | `getAppInfoFromFilename`, `findAppInfoByQuery` | 5 |
| `gauge` | `shell/halfCircleGaugeKit.js` | `HalfCircleGauge` + ค่าคงที่ | 5 |
| `media` | `mediaApi.js` | `MprisMediaService` | 4 |
| `calendar` | `systemCalendarEvents.js`, `calendarGridKit.js` | `SystemCalendarEvents`, `buildMonthGrid`, `weekdayLabels`, … | 2 + 2 |
| `architect` | `architectWidgetKit.js` | `createChildWidgetFromParent`, `childIdCandidates`, … | 2 |
| `iconAccent` | `iconAccentColor.js` | `getAccentColorForApp`, `clearAccentColorCache` | 1 |

กฎของ object:
- `Object.freeze` ทั้ง `kit` และแต่ละ namespace
- มี `kit.version` (เริ่มที่ `1`) ไว้ให้ widget เช็ก/เตือนเมื่อ host เก่าเกินไป
- เป็น **อินสแตนซ์เดียวต่อ shell process** ทุก widget ใช้ร่วมกัน (แก้ปัญหาข้อ 2)

## 4. ส่วนที่ต้องทำฝั่ง host

1. สร้าง `lib/shell/hostKit.js` ที่ `import * as` โมดูลข้างบนแบบ static แล้ว `export const HOST_KIT = Object.freeze({...})`
   - ใช้ static import เพราะโมดูลเหล่านี้ `widgetRuntimeLoader.js` และ `extension.js` โหลดอยู่แล้วเกือบหมด (ต้นทุนเพิ่มน้อย) ส่วน `mediaApi.js`/`systemMetricsApi.js` ถ้าอยากหน่วง ให้ทำ getter แบบ lazy (`get media() { return mediaMod ??= ... }` ต้องเป็น dynamic import จึงเป็น async ใช้กับ constructor แบบ sync ไม่ได้ → แนะนำ eager)
2. แก้ `_buildApi()` ใน `widgetRuntimeLoader.js`: `host: { rescan, kit: HOST_KIT }`
3. ไม่ต้องแก้ `loadOne()` / `reloadWidget()` เพราะใช้ `_buildApi()` ร่วมกันอยู่แล้ว
4. `lib/apiVersion.js`: ตอนเริ่ม migrate widget ให้เพิ่ม `HOST_API_VERSION = 3` แต่คง `MIN_SUPPORTED_API_VERSION = 2` ไว้ เพื่อให้ widget เก่า (import ผ่าน path) ยังโหลดได้ ผ่าน symlink
5. อัปเดตเอกสารสำหรับผู้เขียน widget (EGO.md / คู่มือ widget API) ให้ใช้ `api.host.kit`

## 5. ส่วนที่ต้องทำฝั่ง widget (migration)

ผลสำรวจจาก `widgets/` ใน zip ปัจจุบัน:
- widget ทั้งหมด 80 ตัว, `widget.js` ที่ import lib 79 ตัว
- **ไม่มี** ไฟล์อื่นใน widget (helper) ที่ import lib
- ไม่พบการใช้ค่าจาก kit ที่ module-scope (ค่าอย่าง `CARD_PADDING` เป็นค่าคงที่ประกาศในไฟล์เอง ไม่ใช่ของ kit) → การย้ายเป็นงาน **mechanical** ได้ แต่ต้อง grep ซ้ำอีกครั้งก่อนลงมือ

ขั้นตอนต่อ widget:
1. ลบบรรทัด `import ... from '../../lib/...'`
2. ใน `constructor(api)` (หรือ `static createInstance(api)`) ดึงสิ่งที่ใช้จาก `api.host.kit.<ns>`
3. ถ้ามีฟังก์ชัน/ค่าจาก kit ที่ใช้นอก constructor (method อื่น, callback) ให้เก็บไว้ที่ `this._kit` หรือ destructure ไปไว้ใน field
4. เปลี่ยน `api-version` ใน `metadata.json` เป็น `3` และ bump `version`
5. สคริปต์ codemod ที่แนะนำ: อ่าน import จาก `../../lib/<file>`, map ชื่อไฟล์ → namespace ตามตารางข้างบน, สร้าง destructuring ใน constructor, รายงานตัวที่ถูก import แต่ไม่ได้ใช้

ข้อควรระวัง:
- **child widget** (เช่น geek-architect) ใช้โค้ดของ parent ผ่าน `parent` ใน metadata → ได้ `api` เหมือนกัน ไม่กระทบ แต่ต้อง migrate parent ก่อน
- widget ที่ใช้ kit ใน `static` field หรือ top-level `const x = fn(...)` ต้องย้ายเข้า constructor
- `ModuleClass.createInstance(api)` (async) ใช้ `api` เหมือนกัน

## 6. ผลกระทบกับ store

- widget ที่แก้ไฟล์ = hash/ขนาดเปลี่ยน → ต้อง **build ใหม่, เซ็นใหม่, เพิ่มเวอร์ชัน** ใน store (`item.h`, `item.v`, signature ของ manifest)
- widget `api-version: 3` จะใช้ไม่ได้กับ Widget Center เวอร์ชันเก่า → ใช้ `checkApiVersion` ที่มีอยู่ (แจ้ง "update Widget Center") ตรวจสอบว่าข้อความไม่ทำให้สับสน
- theme pack (`.gwct`) ไม่กระทบ (ไม่มีโค้ด)

## 7. แผนทีละเฟส

| เฟส | งาน | ความเสี่ยง |
|---|---|---|
| 1 | เพิ่ม `api.host.kit` (host-only) ยังไม่แตะ widget | ต่ำ — เพิ่มอย่างเดียว |
| 2 | ทดสอบกับ widget 2–3 ตัว (เช่น `circles-year`, `cpu-monitor`, `media-player-*`) | ต่ำ |
| 3 | codemod widget ที่เหลือ + publish เวอร์ชันใหม่ขึ้น store, `api-version: 3` | กลาง — ต้องเซ็นใหม่ทั้งหมด |
| 4 | ประกาศ widget API 2 deprecated; เมื่อพร้อมตั้ง `MIN_SUPPORTED_API_VERSION = 3` แล้วลบ symlink (`hostLibLink.js`) | ต่ำ ถ้าผู้ใช้อัปเดตแล้ว |

## 8. Checklist ทดสอบ

- [ ] widget เก่า (api 2, import ผ่าน path) ยังโหลดได้ในเฟส 1–3
- [ ] widget ใหม่ (api 3, ใช้ `host.kit`) โหลดได้ทั้งแบบ bundled และแบบติดตั้งจาก store โดย **ไม่มี** symlink `lib/`
- [ ] hot-reload (`reloadWidget`) ยังได้ `host.kit`
- [ ] child widget ของ architect ยังสร้างและโหลดได้
- [ ] `setGlobalShadowHelper` มีผลกับ widget ทุกตัว (ทั้งสองกลุ่ม) หลังใช้ kit อินสแตนซ์เดียว
- [ ] theme pack apply แล้ว widget ขึ้นครบ (ไม่มี import error ใน journal)
- [ ] ไม่มี `Unable to load file from: file:///…/gnome-widget-center/lib/…` ใน `journalctl`

## 9. คำถามที่ยังต้องยืนยัน

1. โมดูลถูกโหลดซ้ำสองชุดจริงหรือไม่ (วิธีเช็กในหัวข้อ 2)
2. ในเอกสารผู้เขียน widget ภายนอก (ถ้ามี) มีใครอ้าง `../../lib/` อยู่ ต้องประกาศช่วง deprecate กี่เวอร์ชัน
3. จะให้ `kit.version` เพิ่มเมื่อมี export ใหม่ (additive) หรือเมื่อมี breaking เท่านั้น
