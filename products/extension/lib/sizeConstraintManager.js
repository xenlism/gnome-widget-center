// products/extension/lib/sizeConstraintManager.js
//
// Task 14 — Widget size constraints. บังคับขนาด Min/Max ของ Widget เพื่อกัน UI พัง
// (เช่น GridEngine snap ตำแหน่งแล้วเจอ widget ที่ถูกลาก/resize จนเล็ก/ใหญ่เกินไป)
//
// Design notes (แก้จาก draft แรกที่ hard-code widget id ในไฟล์นี้ตรงๆ):
//
// 1. อ่าน constraint จาก `metadata['size-constraints']` ของ widget แต่ละตัวเอง (ตาม
//    ที่ size-constraints.md เองก็บอกว่า "อ้างอิงจาก id ใน metadata.json") แทนที่จะ
//    ฝัง 'clock'/'media-player' ไว้ในโค้ด host — third-party widget ประกาศเองได้เลย
//    โดยไม่ต้องแก้ extension ตาม pattern เดียวกับ settings schema ของ task 05 (ดู
//    settingsSchemaUI.js / development/tasks/05-prefs-control-center.md) ไม่มี
//    'size-constraints' ในเมทาดาต้า → ใช้ DEFAULT_CONSTRAINTS เป็น fallback
//
// 2. ห้ามอ่าน actor.get_size() แล้วเอาไป clamp ตรงๆ ตอนนี้ — ตอนที่
//    _placeEntry() เรียก applyConstraints() นั้น (extension.js) actor ยังไม่เคย
//    ถูก parent เข้า container/ยังไม่เคยผ่าน allocation เลยสักครั้ง ดังนั้น
//    get_size() แทบทุกกรณีจะได้ (0, 0) กลับมา ถ้าเอาไป Math.min/Math.max กับ
//    constraint ตรงๆ จะกลายเป็นบังคับ set_size(minW, minH) ทุกครั้งโดยไม่ตั้งใจ
//    (เช่น clock ที่ตั้งใจให้มี natural size 220x90 จะโดนหดเหลือ minW/minH ทันที)
//    แก้โดย fallback ไปใช้ get_preferred_width()/get_preferred_height() (natural
//    size จาก layout request ซึ่งคำนวณได้โดยไม่ต้องรอ allocation) เมื่อ get_size()
//    คืนค่า 0 มา
//
// 3. ไม่บังคับ set_size() ถ้าขนาดปัจจุบัน (หรือ natural size ที่ fallback มา) อยู่ใน
//    ขอบเขต [min, max] อยู่แล้ว — กัน layout ธรรมชาติของ widget (เช่น St.BoxLayout ที่
//    ไม่ได้ set_size ตายตัว) ไม่ให้ถูก override โดยไม่จำเป็นตอนที่ไม่มีอะไรเกินขอบเขตจริงๆ

const DEFAULT_CONSTRAINTS = Object.freeze({minW: 50, minH: 50, maxW: 1000, maxH: 1000});

export class SizeConstraintManager {
    /**
     * @method getConstraintsFor
     * @description Constraint ของ widget หนึ่งตัว — จาก metadata.json ของมันเองถ้ามี
     * ประกาศไว้ (`"size-constraints": {"minW":.., "minH":.., "maxW":.., "maxH":..}`),
     * ไม่งั้น fallback ไปที่ DEFAULT_CONSTRAINTS เดียวกันสำหรับทุก widget
     * @param {object} metadata - entry.metadata ของ widget (จาก WidgetLoader)
     * @returns {{minW:number, minH:number, maxW:number, maxH:number}}
     */
    static getConstraintsFor(metadata) {
        const declared = metadata?.['size-constraints'];
        if (!declared || typeof declared !== 'object')
            return DEFAULT_CONSTRAINTS;

        // Merge เฉพาะ key ที่ประกาศจริง ที่เหลือ fallback เป็น default ทีละค่า กัน
        // metadata.json ที่ประกาศไม่ครบ (เช่นมีแค่ maxW) พังทั้งก้อน
        return {
            minW: Number.isFinite(declared.minW) ? declared.minW : DEFAULT_CONSTRAINTS.minW,
            minH: Number.isFinite(declared.minH) ? declared.minH : DEFAULT_CONSTRAINTS.minH,
            maxW: Number.isFinite(declared.maxW) ? declared.maxW : DEFAULT_CONSTRAINTS.maxW,
            maxH: Number.isFinite(declared.maxH) ? declared.maxH : DEFAULT_CONSTRAINTS.maxH,
        };
    }

    /**
     * @private ขนาดปัจจุบันของ actor แบบไม่พึ่ง allocation อย่างเดียว — ถ้ายังไม่เคย
     * allocate (get_size() คืน 0 มาด้านใดด้านหนึ่ง) ให้ fallback ไปที่ natural size
     * จาก get_preferred_width/height() ซึ่งเป็นค่าที่ St/Clutter คำนวณจาก layout
     * request ของ actor เองได้โดยไม่ต้องรอรอบ allocation จริง
     * @param {Clutter.Actor} actor
     * @returns {[number, number]}
     */
    static _currentSize(actor) {
        let [width, height] = actor.get_size();

        if (width === 0 || height === 0) {
            const [, natWidth] = actor.get_preferred_width(-1);
            const [, natHeight] = actor.get_preferred_height(-1);
            width = width || natWidth;
            height = height || natHeight;
        }

        return [width, height];
    }

    /**
     * @method applyConstraints
     * @description บังคับขนาด actor ให้อยู่ในขอบเขต [min, max] ของ widget นั้นๆ —
     * เป็น no-op ถ้าขนาดปัจจุบัน/natural size อยู่ในขอบเขตอยู่แล้ว (ดูข้อ 3 ด้านบน)
     * @param {object} metadata - entry.metadata (ต้องมี metadata.id สำหรับ log)
     * @param {Clutter.Actor} actor
     */
    static applyConstraints(metadata, actor) {
        const rules = this.getConstraintsFor(metadata);
        const [width, height] = this._currentSize(actor);

        const clampedWidth = Math.max(rules.minW, Math.min(width, rules.maxW));
        const clampedHeight = Math.max(rules.minH, Math.min(height, rules.maxH));

        if (clampedWidth === width && clampedHeight === height)
            return; // อยู่ในขอบเขตอยู่แล้ว ไม่ต้องยุ่งกับ layout ธรรมชาติของ widget

        actor.set_size(clampedWidth, clampedHeight);
    }
}
