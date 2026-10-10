# P2 + P3 + แอป GTK4 "GWC Repo Maker"

ผลทดสอบ: Python 82 ผ่าน · Node 111 ผ่าน · GJS จริง (rollback) ผ่าน · GJS จริง (backend ของแอป: init→build→sign→verify) ผ่าน · แอปรันใน Xvfb แล้วจับภาพทุกหน้า (EN/TH)

## P2
| รายการ | ที่ทำ | ไฟล์หลัก |
|---|---|---|
| shard ต่อหมวด | `widgets-<cat>`, `themepacks-<cat>` + `search` (id/ชนิด/ชื่อ/หมวด/แท็กเท่านั้น). เปิดหมวดโหลด ~10 KB, ค้นหาไม่แตะ shard หมวด, `getItem(kind,id)` = search → 1 shard. verify ตรวจว่า search ตรงกับ shard หมวดทุกรายการ | build_store.py `write_shards`, verify_store.py, storeClient.js |
| permissions + CI scan | metadata ต้องมี `perm` (`none`/`network`/`subprocess`/`fs-read:<path>`/`fs-write:<path>`). `perm_scan.py` เทียบกับโค้ด: ใช้แต่ไม่ประกาศ = build ล้ม, ประกาศเกิน = เตือน. ปฏิเสธ `eval`, `new Function`, `import(ตัวแปร)`, `Gio[ตัวแปร]`. สแกน raw text (ไม่ตัด comment) กัน regex-literal `//` หลอก. dialog ติดตั้งแสดงสิทธิ์ | perm_scan.py, permText.js, dialogText.js |
| rollback | ติดตั้งทับ → ของเดิมย้ายไป `~/.local/share/gnome-widget-center/prev/<kind>/<id>` (ไม่ใช่ `<id>.prev` ใน root เพราะ Shell สแกน root นั้น). `rollbackInstalled()` สลับสองทาง (เรียกซ้ำ = ย้อนกลับ). registry เก็บ `prev` 1 ชั้น | gwcFormat.js, installRegistry.js, rollback.js |
| mirrors | `store.config.json: mirrors[]` (https, ≤5) เซ็นอยู่ใน manifest. client ลองฐานหลักก่อน, ล้ม/404/5xx → มิเรอร์, จำฐานที่ตอบล่าสุด. `store.json` กับ `.sig` ต้องมาจากฐานเดียวกัน. redirect ต้องอยู่ origin เดิมของฐานนั้น. ข้อมูลยังถูกตรวจ hash เสมอ มิเรอร์ทำได้แค่ "ล่ม" ไม่ใช่ "โกหก" | storeClient.js `_bases/_get/_fetchManifest` |

## P3
| รายการ | ที่ทำ |
|---|---|
| ลายเซ็นรายแพ็กเกจ | ผู้เขียนเซ็น `GWC-PKG-V1\0 id\0 version\0 entry\0 perm\0 td` (td = tree digest ของไฟล์ทั้งแพ็กเกจ). domain แยกจากลายเซ็น manifest. `authors.json` (kid, name, pub, ids ที่เซ็นได้; `*` เดี่ยวห้าม) เซ็นเข้า manifest. build/verify ตรวจ; client `checkAuthor` ตรวจตอนแสดงรายการ และ `assertPackageBinding` ตรวจไฟล์ที่แตกจริงตรงกับ td/entry/perm. คัดลอกลายเซ็นข้ามวิดเจ็ต/สลับ key ใน authors.json/แก้หลังเซ็น → build ล้ม. key pinning ฝั่งผู้ใช้: ถ้า key ผู้เขียนเปลี่ยนหรือหาย dialog เตือนแดง |
| channel stable/beta | `metadata.channel`; รายการ beta ติด `ch:"beta"`; ผู้ใช้ stable ไม่เห็น/ไม่ถูกเสนออัปเดต beta (ยกเว้นลง beta ไว้แล้ว); config `channel` |
| repo ชุมชน | `tier: community` → บังคับลายเซ็นผู้เขียนโดยปริยาย (`policy.authorSig`). คีย์ official ฝังใน client ใช้ยืนยันได้เฉพาะ manifest `tier:official` เท่านั้น; repo อื่นถูกแสดงเป็น community เสมอ แม้อ้างว่า official |

## แอป `gwc-repo-maker/` (GJS + GTK4 + libadwaita)
สร้างคลัง (โฟลเดอร์ + tools + workflows + กุญแจเซ็น) · เปิด/จำคลังล่าสุด · วิดเจ็ตใหม่/นำเข้า .gwcw/เซ็นในนามผู้เขียน · ชุดธีม · ผู้เขียน + เพิกถอน · ตั้งค่า (mirrors, tier, บังคับลายเซ็น, อายุลายเซ็น) · build ตัวอย่าง / build เซ็น + verify พร้อม log สด · ขั้นตอน publish. UI ไทย/อังกฤษตาม locale (`GWC_LANG=th|en`).
แอปไม่มี logic ของคลังเอง: เรียก `tools/gwc_repo.py` (JSON) และ `build_store.py` ซึ่งมีเทสต์ครอบ. กุญแจส่วนตัวอยู่ `~/.config/gwc-repo-maker/keys` (0600) ไม่เข้า repo.
รัน: `gwc-repo-maker/bin/gwc-repo-maker` · ต้องการ gjs ≥1.76, GTK 4.10+, libadwaita ≥1.5, python3 + `cryptography` (+ Pillow สำหรับ cover). หลังแก้ `gwc-store/tools` รัน `gwc-repo-maker/sync-backend.sh` (มีเทสต์เช็คว่าตรงกัน)

## ต่อเนื่อง: logic ของ UI prefs (channel / rollback / tier)
`gwc-client/lib/store/prefsModel.js` (pure, ไม่มี gi://) + `tests/prefsModel.test.mjs` (8 เคส) + `patches/PREFS-WIRING.md` (โค้ดตัวอย่างต่อ Adw/GTK). ตัวเลือก channel, สถานะ/ข้อความปุ่ม rollback (ดิสก์เป็นตัวตัดสิน ไม่ใช่ registry), ป้าย tier (ใช้ `effectiveTier()` เท่านั้น repo ที่อ้างว่า official จะแสดงเป็น Community). **ยังไม่ได้ต่อเข้า prefs จริงและไม่ได้รันภายใต้ GTK** เพราะไฟล์ prefs ไม่อยู่ในซิป

## ที่ไม่ได้ทดสอบ / ข้อจำกัด (ตรงไปตรงมา)
- mirror failover ใน storeClient: **มีเทสต์แล้ว** (`gwc-client/tests/storeclient.mirrors.test.mjs`, 24 เคส: ฐานหลักล่ม/404/500/503 → มิเรอร์, จำฐานที่ใช้ได้, ล่มทั้งคู่, มิเรอร์โกหก/ล้าหลัง/ซิงก์ค้างครึ่งทาง, redirect ข้าม origin, cold start ไม่ถามมิเรอร์ที่ยังไม่ถูกเซ็น). เทสต์พบบั๊กจริง 1 จุดและแก้แล้ว: เดิม `_good` ถูกตั้งเป็นมิเรอร์ทันทีที่ได้ HTTP 200 *ก่อน* ตรวจ hash → มิเรอร์ที่ส่งไบต์เสียครั้งเดียวจะถูกลองก่อนเสมอและบล็อกฐานหลักที่ปกติไปทั้ง session (ไม่เกิดเนื้อหาปลอม แต่ใช้งานไม่ได้). ตอนนี้ shard/cover/package ตรวจ hash ต่อฐาน (`_get(..., { verify })`): ฐานที่ไบต์ไม่ผ่านถูกข้ามไปฐานถัดไป และ `_good` ตั้งเฉพาะฐานที่ส่งไบต์ที่ผ่านแล้ว. ข้อจำกัดที่เหลือ: เทสต์ใช้ shim ของ Soup/GLib ไม่ใช่ libsoup จริง (timeout/TLS error/redirect จริงยังต้องลองบน GNOME จริง)
- แอป: ทดสอบแบบ headless (Xvfb) + backend ผ่าน GJS จริง + ดูภาพทุกหน้า แต่ **ไม่ได้คลิก dialog/file chooser จริง**. ไอคอนบางตัวไม่ขึ้นในสภาพแวดล้อมทดสอบ (ธีมไอคอนน้อย) น่าจะขึ้นบน GNOME ปกติ
- extension หลัก (prefs UI) ไม่ได้อยู่ในไฟล์ที่ส่งมา: ยังต้องต่อสาย UI ของ **เลือก channel, ปุ่ม rollback (`canRollback/rollbackInstalled`), แสดง tier**. `openUri.js` ต่อให้แล้ว
- `fsUtils.js`/`apiVersion.js` ในเทสต์เป็น stub (`tests/host-stubs`) ไม่ใช่ของจริง
- perm scan เป็นตัวช่วย reviewer ไม่ใช่ sandbox; key ผู้เขียนยังไม่มีการเพิกถอนระดับ key (เพิกถอนทีละแพ็กเกจเท่านั้น); pinning เป็นแบบ TOFU
- manifest/shard เปลี่ยนรูป (ต้องมี `perm`, ชื่อ shard ใหม่) จึงใช้กับ store ที่ build ด้วย P1 ไม่ได้ (ยังไม่เคย publish จึงไม่กระทบ)
- บั๊ก P1 ที่เจอระหว่างทำและแก้แล้ว: `pages.yml` ไม่ trigger เมื่อแก้ `revoked.json` (เพิกถอนจะไม่ถูก publish) → เพิ่ม `revoked.json`, `authors.json` ใน paths
