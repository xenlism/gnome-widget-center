# tests/e2e-checklist.md — End-to-end regression (tasks 00-09)

รวบยอด acceptance criteria ของทุก task 00-09 ไว้ในที่เดียว ตามที่ `tasks/10-testing-release.md`
ข้อ 1 กำหนด — รันทุกข้อรวดเดียวก่อน release ทุกครั้ง

**สถานะรวม (2026-07-15):** โค้ดของ task 00-09 เขียนครบตามสเปกในไฟล์ task ของแต่ละอัน และผ่าน
syntax-check (`node --check`) กับ unit test (เฉพาะส่วนที่ mock ได้ใน Node เช่น
`widgetSettings.js`) หมดแล้ว **แต่ยังไม่เคยรัน end-to-end บน GNOME Shell จริงเป็นชุดเดียวกัน
ทั้งหมด** — container ที่ใช้พัฒนาไม่มี GNOME Shell ให้รัน (เหมือนที่บันทึกไว้ใน
`tasks/ROADMAP.md` และ Notes from implementation ของแต่ละ task ตั้งแต่ 01 เป็นต้นมา) คอลัมน์
"สถานะ" ด้านล่างสะท้อนสิ่งที่ตรวจสอบได้จริงในสภาพแวดล้อมนี้ (อ่านโค้ด, syntax-check, unit test)
ไม่ใช่การยืนยันบนเครื่องจริง — **ต้องรันซ้ำบนเครื่องที่มี GNOME Shell 45+ จริงก่อนติ๊กว่า
"ผ่าน" ในความหมายที่ acceptance criteria เดิมต้องการ**

Legend: ✅ ตรวจแล้ว (ระดับที่ระบุ) — ⚠️ เขียนโค้ดแล้วแต่ยังไม่ยืนยัน — ❓ ไม่มีบันทึกผลเลย

## Task 00 — Project Setup & Feasibility

- ✅ `gnome-extensions enable` ใช้งานได้บน GNOME 50 Wayland จริง — ยืนยันแล้วโดยผู้ใช้จริงบน
  เครื่อง (ดู "Notes from implementation" ของ `tasks/00-project-setup.md`)
- ✅ กล่องทดสอบอยู่ต่ำกว่าหน้าต่างแอป, ไม่บัง lock screen — ยืนยันแล้วเช่นกัน
- ✅ `disable()` ไม่มี actor ค้าง/ไม่มี warning ใน log — ยืนยันแล้ว (ทดสอบ enable/disable 5 รอบ)
- ✅ มี section "Notes from implementation" — มีครบ

**สรุป: ผ่านทั้งหมด ยืนยันบนเครื่องจริงแล้ว** (task เดียวใน 00-09 ที่ยืนยันครบ)

## Task 01 — Widget Loader Core

- ⚠️ วาง widget ใหม่ในโฟลเดอร์ user-installed โดยไม่แก้ `extension/` แล้วถูกโหลด — โค้ด
  `discoverWidgets()`/`loadOne()` ตรงสเปก แต่ยังไม่ทดสอบบนเครื่องจริง
- ⚠️ ลบ `metadata.json` ของ widget หนึ่งตัว → widget อื่นไม่กระทบ, มี log ชัดเจน — มี
  `this._recordError()`/`this.errors` ในโค้ดตรงสเปก แต่ยังไม่ยืนยันบนเครื่องจริง
- ⚠️ widget สอง id ซ้ำกัน → ตัวที่สอง skip พร้อม log — ต้องอ่านโค้ด `discoverWidgets()` ยืนยันว่า
  reject ตาม id ซ้ำจริง (`docs/WIDGET_API.md` §2 พูดถึงพฤติกรรมนี้) แต่ยังไม่รันจริง
- ⚠️ `disable()` แล้ว widget ทุกตัว unload สะอาด — โค้ดมี แต่ยังไม่ยืนยันบนเครื่องจริง

## Task 02 — Widget Layer Rendering

- ⚠️ Widget ตัวอย่างแสดงบนพื้นโต๊ะจริง ต่ำกว่าหน้าต่างแอปทุกตัว — ต่อยอดจาก `background_group`
  ที่ task 00 ยืนยันแล้ว, โค้ด `widgetLayer.js` เชื่อมเข้า `extension.js` ครบ (ดู bug ที่แก้ไปแล้ว
  ใน ROADMAP.md Notes 2026-07-13 ข้อ 2) แต่ยังไม่ยืนยันด้วยตาบนเครื่องจริงหลังแก้บั๊กนั้น
- ⚠️ ล็อกหน้าจอ → widget หายทันที, ปลดล็อก → กลับมา — คาดว่าได้ผลจากกลไก auto-disable-on-lock
  ที่ task 00 ค้นพบ (ไม่ต้องเขียน `Main.sessionMode` guard เอง) แต่ยังไม่ยืนยันซ้ำกับ widget
  layer จริง (ต่างจากกล่องทดสอบเปล่า ๆ ของ task 00)
- ⚠️ พฤติกรรมตอนเปิด overview — ต้องตรวจตาม Notes ของ task 02 เอง (ยังไม่อ่านละเอียดในรอบนี้)
- ⚠️ `disable()` แล้ว layer ถูก destroy หมด (เช็คด้วย Looking Glass) — ต้องใช้เครื่องจริง

## Task 03 — Settings Store

- ✅ เขียนไฟล์ settings ภายใน ~300ms, merge defaults, sanitize path traversal, สอง widget ไม่ชน
  กัน — **มี unit test จริงที่ mock `GLib`/`StorageService` ใน Node ครอบทั้ง 5 ข้อ รันผ่านหมด**
  (ดู "Notes from implementation" ของ `tasks/03-settings-store.md`) — ระดับ logic ผ่านแน่นอน
  แต่ path จริงที่พึ่ง `Gio`/GNOME Shell runtime ยังไม่ทดสอบ

## Task 04 — Drag & Reposition

- ⚠️ Super+drag บันทึกตำแหน่งใน `layout.json` ทันที, กลับมาตำแหน่งเดิมหลัง reload, ไม่เขียนไฟล์
  ถี่ต่อเฟรม, widget อื่นไม่กระทบ, `disable()` ไม่ throw — ตรวจด้วยการอ่านโค้ด + syntax-check
  เท่านั้น เพราะพึ่ง `Clutter`/`global.stage` ที่ mock ยากกว่า settings (ตามที่ระบุไว้ในไฟล์ task
  เอง) **ยังไม่ยืนยันบนเครื่องจริง**

## Task 05 — Prefs / Control Center

- ⚠️ Control Center เห็น widget ทุกตัว (bundled + user), toggle ปิดแล้วหายจากพื้นโต๊ะทันที,
  กด Settings เห็นหน้า prefs, widget ที่ metadata พังไม่ทำ Control Center ทั้งหน้าพัง — อ่านโค้ด
  `extension/prefs.js`/`prefsWidgetList.js` แล้วตรงสเปกทุกข้อ (มี error section แยกจริง,
  `_openWidgetPrefs()` มี try/catch) แต่ไฟล์ task 05 ไม่มี section "Notes from implementation"
  เลย (ไม่เหมือน 00/01/02/03/04) — ไม่มีบันทึกว่าเคยทดสอบจริงหรือยัง ต้องรันบนเครื่องจริงก่อน
- ⚠️ known limitation ที่ comment ไว้ใน `extension/prefs.js`: การแก้ settings ผ่าน Control
  Center ไม่ sync แบบ real-time เข้า widget instance ที่กำลังรันอยู่ในกระบวนการ Shell (ต้อง
  toggle ปิด/เปิดใหม่ หรือ restart) — ตรงกับที่ acceptance criteria ข้อ 3 อนุญาตให้เป็นได้
  ("หรืออย่างช้าคือหลัง toggle ปิดเปิดใหม่") ไม่ใช่บั๊ก แต่ต้อง regression-test ว่าพฤติกรรมจริง
  ตรงกับที่ comment ไว้

## Task 06 — Widget SDK Example Pack (clock + media-player)

- ⚠️ `clock`: แสดงเวลาถูกต้อง, เปลี่ยน `format24h` ผ่าน Control Center อัปเดตไม่ต้อง restart —
  โค้ดตรงสเปก (`GLib.timeout_add_seconds` + remove ใน `disable()`) ยังไม่รันจริง
- ⚠️ `media-player`: แสดงชื่อเพลง/ศิลปินจาก MPRIS ภายในไม่กี่วินาที, ปุ่ม Play/Pause/Next/Previous
  ทำงานจริง, ไม่มี media player เปิดอยู่ → placeholder "No media playing" ไม่ crash, ปิด/เปิดซ้ำ
  ไม่มี DBus proxy/timer ค้าง — โค้ดใช้ signal (`g-properties-changed`, `NameOwnerChanged`) ไม่ poll
  ตรงสเปก §8 ของ `WIDGET_API.md` แต่ **ทดสอบได้แค่ `node --check` เท่านั้น** (ตามที่ระบุไว้ใน
  Notes from implementation ของ `tasks/06-widget-sdk-example.md`) จำเป็นต้องมี media player
  จริงที่รองรับ MPRIS (Spotify/VLC/Firefox) บนเครื่องที่มี GNOME Shell เพื่อยืนยัน
- ✅ `docs/WIDGET_API.md` §8 ถูกเพิ่มจริงแล้ว — ตรวจสอบแล้วมีอยู่จริงในไฟล์

## Task 07 — Multi-monitor Support

- ❓ ถอดจอรอง → widget ย้ายมาจอหลัก, เสียบจอเดิมกลับ → พฤติกรรมตามที่ตัดสินใจ, HiDPI ไม่เพี้ยน —
  **ไฟล์ `tasks/07-multi-monitor-support.md` ไม่มี section "Notes from implementation" เลย**
  แม้ `extension/lib/monitorWatcher.js` จะมีอยู่จริงและถูก import/wire เข้า `extension.js`
  แล้ว (`this._monitors = new MonitorWatcher()`) — สถานะจริงไม่ชัดเจนว่า "เสร็จ" ตามคำนิยามของ
  `tasks/CONTRIBUTING.md` (ต้องมี Notes ท้ายไฟล์ตอนทำเสร็จ) หรือยังทำค้างอยู่ — **ควรเปิด task
  ใหม่/session ใหม่ตรวจสอบและเติม Notes ให้ task 07 ก่อน** ไม่ใช่ scope ของ task 09/10 ที่จะไป
  แก้เนื้อหาของ task 07 เอง จึงรายงานไว้ตรงนี้แทน
- ตัดสินใจไม่ทึกทักว่า "ผ่าน" หรือ "ไม่ผ่าน" ในรายการนี้ — ทำเครื่องหมาย ❓ ไว้ตรงตามจริง

## Task 08 — Hot Reload / Dev Mode

- ❓ เช่นเดียวกับ task 07 — **`tasks/08-hot-reload-dev-mode.md` ไม่มี section "Notes from
  implementation"** แม้ `extension/lib/devWatcher.js` จะมีอยู่จริงและถูก wire เข้า
  `extension.js` ครบ (`this._devWatcher = new DevWatcher(...)`, เรียก `start()`/`stop()`/
  `watchWidget()`/`unwatchWidget()`) — โค้ดดูสอดคล้องกับสเปก (debounce, cache-bust ด้วย
  `?t=timestamp` query string ตามที่ task แนะนำ — ควรอ่าน `devWatcher.js` ยืนยันอีกรอบ) แต่ไม่มี
  บันทึกว่าทดสอบ 3 ข้อ acceptance จริงหรือยัง — เช่นเดียวกับ 07: รายงานเป็นช่องว่างเอกสาร ไม่ใช่
  bug ที่ต้องแก้ในงานนี้

## Task 09 — Third-Party Widget Template & Packaging Docs

- ✅ `docs/PUBLISHING_A_WIDGET.md` เขียนครบตาม Quick start/แจกจ่าย/checklist/versioning,
  `widgets/_template/` (ทั้ง 2 ชุด — ดูหมายเหตุ duplicate ใน Notes from implementation ของ
  `tasks/09-packaging-third-party-docs.md`) มี TODO ครบ, `node --check` ผ่านทุกไฟล์ที่แก้ —
  ดูรายละเอียดใน Notes from implementation ของไฟล์ task 09 เอง

## GNOME Shell Extension Review Guidelines — spot check (ถ้าตั้งใจส่งขึ้น extensions.gnome.org)

ตรวจตาม [GNOME Shell Extension Review Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
เท่าที่ตรวจได้จากการอ่านโค้ด (ไม่ใช่การ submit จริง):

- ✅ `extension/extension.js` ไม่ import `Gtk` เลย (ตรวจด้วย `grep "^import" extension/extension.js`)
- ✅ ไม่มี custom `constructor()` ใน `extension.js` ที่ทำงานหนัก/spawn subprocess — ใช้ default
  จาก `Extension` base class
- ✅ ไม่มี `metadata.json` ไฟล์ไหนใน `extension/` หรือ widget bundled ประกาศ `"session-modes"`
  (ยืนยันด้วย `grep -r session-modes` ไม่เจอผลเลย) — ตรงกับการตัดสินใจใน
  `tasks/00-project-setup.md` ที่ต้องการให้กลไก auto-disable-on-lock ของ GNOME ทำงานแทน
- ❓ ยังไม่ตรวจ: การใช้ `GLib.spawn_*`/`Gio.Subprocess` จุดอื่นในโค้ด, การขอ permission ที่
  ไม่จำเป็น, ข้อความ description/ชื่อ extension ตาม guideline เรื่อง naming — ควรตรวจเพิ่มก่อน
  ส่งจริง ไม่ได้ครอบคลุมในรอบตรวจนี้

## สรุปสิ่งที่ต้องทำก่อน "ผ่าน" ในความหมายเดิมของทุก task

1. รันบนเครื่องที่มี GNOME Shell 45+ จริง (แนะนำ GNOME 50 / Wayland ตามที่ project กำหนดไว้
   หลักใน `docs/ARCHITECTURE.md`) แล้วไล่ทำตาม checklist นี้ทีละข้อ แก้ ✅/⚠️/❓ เป็นผลจริง
2. เติม "Notes from implementation" ให้ `tasks/07-multi-monitor-support.md` และ
   `tasks/08-hot-reload-dev-mode.md` ให้ตรงกับ convention ของ task อื่นทั้งหมด (ปัจจุบันเป็น
   task เดียวที่ขาดหาย)
3. ตัดสินใจเรื่อง top-level `widgets/` vs `extension/widgets/` (duplicate — ดู Notes from
   implementation ของ task 09) ก่อน package สำหรับแจกจริง เพราะ `extension/widgets/` เท่านั้น
   ที่ host โหลดจริงตอนนี้
