import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * @class StorageService
 * @description Manages persistent JSON storage for widget layouts and isolated instance settings.
 * Operates under strict sandbox directory rules to maintain system security.
 * 
 * มอดูลหลักสำหรับการจัดการข้อมูลพิกัดผัง Layout และ Properties พิเศษต่างๆ ของ Widget
 * โดยเก็บข้อมูลในรูปแบบไฟล์ JSON ภายใต้พื้นที่จำกัดสิทธิ์ (Sandboxed Directory) เพื่อความปลอดภัย
 * อ้างอิงตามสเปก: specs/contracts/IStorage.md และ specs/api/storage-service.md
 */
export class StorageService {
    constructor() {
        /** @private {Gio.File} Base directory path for storage (~/.config/gnome-widget-center) */
        this._storageDir = null;
        /** @private {Gio.File} Target file pointer for global layout schema */
        this._layoutFile = null;
        /** @private {Gio.File} Subfolder holding one JSON file per widget's
         * own settings — `widgets/<id>.json`, per development/docs/SETTINGS_SPEC.md
         * (task 03). Kept separate from layout.json, which is host-owned
         * position data, not widget settings. */
        this._widgetsDir = null;
        /** @private {boolean} Internal initialization flag */
        this._isInitialized = false;
    }

    /**
     * @method init
     * @description Initializes storage paths and creates configuration directories if missing.
     * ตั้งค่าโฟลเดอร์สำหรับจัดเก็บข้อมูลและตรวจสอบระบบ Sandbox Directory หากยังไม่มีจะสร้างขึ้นใหม่ทันที
     */
    init() {
        if (this._isInitialized) return;

        // ดึงพาธโฟลเดอร์สำหรับเก็บ Config มาตรฐานของผู้ใช้ระบบ (~/.config)
        const configPath = GLib.get_user_config_dir();
        const baseDirPath = GLib.build_filenamev([configPath, 'gnome-widget-center']);
        this._storageDir = Gio.File.new_for_path(baseDirPath);

        // ตรวจสอบและสร้าง Directory หากยังไม่มีอยู่ใน Sandbox
        if (!this._storageDir.query_exists(null)) {
            this._storageDir.make_directory_with_parents(null);
        }

        // กำหนดพาธไฟล์ศูนย์กลางสำหรับการจัดระเบียบผังตาราง Widget
        const layoutPath = GLib.build_filenamev([baseDirPath, 'layout.json']);
        this._layoutFile = Gio.File.new_for_path(layoutPath);

        // widgets/ — หนึ่งไฟล์ต่อ widget สำหรับ settings ของตัวเอง ตาม
        // development/docs/SETTINGS_SPEC.md (`widgets/<widget-id>.json`) — แก้ไข
        // 2026-07-14: เดิมโค้ดนี้ยังไม่มีโฟลเดอร์ย่อยเลย เขียนไฟล์แบบ
        // `widget-<id>.json` ตรง root ของ storage dir ซึ่งขัดกับสเปกที่
        // task 03 อ้างอิง (และ acceptance criteria เช็ค path ตรงๆ) แก้ให้
        // ตรงกันแล้ว
        const widgetsDirPath = GLib.build_filenamev([baseDirPath, 'widgets']);
        this._widgetsDir = Gio.File.new_for_path(widgetsDirPath);
        if (!this._widgetsDir.query_exists(null)) {
            this._widgetsDir.make_directory_with_parents(null);
        }

        this._isInitialized = true;
    }

    /**
     * @method loadLayout
     * @description Reads and parses the current widget layout configuration.
     * @returns {Object|null} Array of widgets structure matching specs/protocol/layout.json
     * โหลดโครงสร้างผังพิกัดการจัดวางของ Widget ทั้งหมดขึ้นมาจากไฟล์ layout.json
     */
    loadLayout() {
        if (!this._isInitialized) this.init();

        if (!this._layoutFile.query_exists(null)) {
            return null; // คืนค่าว่างหากระบบเพิ่งติดตั้งและยังไม่เคยมีการเซฟผังมาก่อน
        }

        try {
            const [success, contents] = this._layoutFile.load_contents(null);
            if (!success) return null;

            const decoder = new TextDecoder('utf-8');
            const jsonString = decoder.decode(contents);
            return JSON.parse(jsonString);
        } catch (error) {
            logError(error, "Failed to load layout.json");
            return null;
        }
    }

    /**
     * @method saveLayout
     * @description Serializes and saves current layout with dynamic properties using atomic replacement.
     * @param {Array<Object>} widgetsLayout - Array containing position, size, and dynamic keyword parameters.
     * บันทึกผังการจัดวางพิกัด และโครงสร้างอาเรย์ของ Widget ทั้งหมดลงบนดิสก์ 
     * ฟังก์ชันนี้รองรับการรับค่า Keyword พิเศษ (Dynamic Properties) แตกต่างกันไปตามที่แต่ละ Widget ต้องการ
     */
    saveLayout(widgetsLayout) {
        if (!this._isInitialized) this.init();

        try {
            const serializedData = widgetsLayout.map(widget => {
                return {
                    id: widget.id,
                    type: widget.type,
                    x: widget.x,
                    y: widget.y,
                    width: widget.width || 200,
                    height: widget.height || 200,
                    zIndex: widget.zIndex || 1,
                    // รวบรวมฟิลด์พิเศษอื่นๆ เพิ่มเติมแบบยืดหยุ่น เช่น ค่าสี, โทเค็น, ลิงก์ URL ประจำตัว Widget
                    customProperties: widget.customProperties || {} 
                };
            });

            const jsonString = JSON.stringify({ version: "1.0", widgets: serializedData }, null, 4);
            const encoder = new TextEncoder();
            const bytes = encoder.encode(jsonString);

            // บันทึกไฟล์ข้อมูลแบบ Atomic (แทนที่ไฟล์เก่าอย่างปลอดภัย ป้องกันข้อมูลเสียหายขณะเขียนไฟล์)
            this._layoutFile.replace_contents(
                bytes,
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (error) {
            logError(error, "Failed to save layout.json");
            throw error;
        }
    }

    /**
     * @method _sanitizeWidgetId
     * @description Rejects/strips anything that could turn a widget id into a
     * path-traversal payload (e.g. "../../etc/passwd") before it's ever used
     * to build a filesystem path. Widget ids are meant to be simple slugs
     * (matches metadata.json "id" — see development/docs/WIDGET_API.md §2).
     * @param {string} widgetId
     * @returns {string} sanitized id, safe to interpolate into a path
     * @throws {Error} if the id is empty or contains no valid characters at all
     */
    _sanitizeWidgetId(widgetId) {
        const safe = String(widgetId ?? '').replace(/[^a-zA-Z0-9._-]/g, '');
        if (!safe || safe === '.' || safe === '..') {
            throw new Error(`Invalid widget id: "${widgetId}"`);
        }
        return safe;
    }

    /**
     * @method getWidgetPosition
     * @description Reads the saved position for a single widget from layout.json.
     * @param {string} widgetId
     * @returns {{x:number,y:number,monitorIndex:number}|null} null if never saved before
     */
    getWidgetPosition(widgetId) {
        const id = this._sanitizeWidgetId(widgetId);
        const layoutData = this.loadLayout();
        const entry = layoutData?.widgets?.find(w => w.id === id);
        if (!entry) return null;

        return {
            x: entry.x,
            y: entry.y,
            monitorIndex: entry.monitorIndex ?? 0,
        };
    }

    /**
     * @method updateWidgetPosition
     * @description Read-modify-write a single widget's position into
     * layout.json WITHOUT touching any other widget's entry — used by the
     * drag controller (task 04) on drop, so dragging one widget can never
     * clobber another widget's saved position.
     * @param {string} widgetId
     * @param {number} x
     * @param {number} y
     * @param {number} [monitorIndex=0]
     */
    updateWidgetPosition(widgetId, x, y, monitorIndex = 0) {
        const id = this._sanitizeWidgetId(widgetId);
        const layoutData = this.loadLayout() ?? {version: '1.0', widgets: []};
        const widgets = layoutData.widgets ?? [];

        const existing = widgets.find(w => w.id === id);
        if (existing) {
            existing.x = x;
            existing.y = y;
            existing.monitorIndex = monitorIndex;
        } else {
            widgets.push({id, type: id, x, y, monitorIndex, width: 200, height: 200, zIndex: 1, customProperties: {}});
        }

        this.saveLayout(widgets);
    }

    /**
     * @method getWidgetSettings
     * @description Retrieves isolated private configuration for a specific widget instance.
     * @param {string} instanceId - Unique identifier for the widget instance.
     * @returns {Object} JSON configuration object for the instance.
     * ดึงข้อมูลการตั้งค่าที่เป็นความลับเฉพาะตัวแยกตามรหัส ID ของ Widget Instance นั้นๆ (Sandbox Boundary Isolation)
     */
    getWidgetSettings(instanceId) {
        if (!this._isInitialized) this.init();
        const id = this._sanitizeWidgetId(instanceId);

        const widgetSettingsPath = GLib.build_filenamev([this._widgetsDir.get_path(), `${id}.json`]);
        const widgetSettingsFile = Gio.File.new_for_path(widgetSettingsPath);

        if (!widgetSettingsFile.query_exists(null)) {
            return {};
        }

        try {
            const [success, contents] = widgetSettingsFile.load_contents(null);
            if (!success) return {};

            const decoder = new TextDecoder('utf-8');
            return JSON.parse(decoder.decode(contents));
        } catch (error) {
            logError(error, `Failed to load settings for widget instance: ${instanceId}`);
            return {};
        }
    }

    /**
     * @method saveWidgetSettings
     * @description Persists isolated private configuration for a specific widget instance.
     * @param {string} instanceId - Unique identifier for the widget instance.
     * @param {Object} settingsData - Key-value pair configuration data.
     * บันทึกข้อมูลคอนฟิกเฉพาะรายตัวของ Widget Instance ลงในไฟล์ประจำไอดีแยกต่างหาก
     */
    saveWidgetSettings(instanceId, settingsData) {
        if (!this._isInitialized) this.init();
        const id = this._sanitizeWidgetId(instanceId);

        try {
            const widgetSettingsPath = GLib.build_filenamev([this._widgetsDir.get_path(), `${id}.json`]);
            const widgetSettingsFile = Gio.File.new_for_path(widgetSettingsPath);

            const jsonString = JSON.stringify(settingsData, null, 4);
            const encoder = new TextEncoder();
            const bytes = encoder.encode(jsonString);

            widgetSettingsFile.replace_contents(
                bytes,
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (error) {
            logError(error, `Failed to save settings for widget instance: ${instanceId}`);
            throw error;
        }
    }

    /**
     * @method updateWidgetProperty
     * @description Appends or updates a single key-value parameter dynamically inside a widget configuration.
     * @param {string} instanceId - Unique identifier for the widget.
     * @param {string} key - Parameter keyword (e.g., "themeColor", "refreshInterval").
     * @param {*} value - The value data to attach.
     * ฟังก์ชันตัวช่วยด่วนในการแนบหรืออัปเดต Keyword พิเศษรายฟิลด์ เข้าไปในข้อมูลส่วนตัวของ Widget แบบไดนามิก
     */
    updateWidgetProperty(instanceId, key, value) {
        if (!this._isInitialized) this.init();

        const currentSettings = this.getWidgetSettings(instanceId);
        currentSettings[key] = value;
        this.saveWidgetSettings(instanceId, currentSettings);
    }

    /**
     * @method resetWidgetSettings
     * @description Task 12 (Widget Edit Mode) "Reset" back-side action —
     * deletes this widget's own `widgets/<id>.json` settings file
     * entirely (not just clearing keys to `{}`), so the NEXT load goes
     * through the exact same first-run path documented in
     * widgetSettings.js: `WidgetSettings.load()` finds nothing on disk,
     * then `WidgetLoader` calls `applyDefaults()` with the widget's own
     * `getDefaultSettings()`, recreating the file from scratch. Safe to
     * call for a widget with no settings file yet (no-op).
     * @param {string} instanceId
     */
    resetWidgetSettings(instanceId) {
        if (!this._isInitialized) this.init();
        const id = this._sanitizeWidgetId(instanceId);

        const widgetSettingsPath = GLib.build_filenamev([this._widgetsDir.get_path(), `${id}.json`]);
        const widgetSettingsFile = Gio.File.new_for_path(widgetSettingsPath);

        try {
            if (widgetSettingsFile.query_exists(null))
                widgetSettingsFile.delete(null);
        } catch (error) {
            logError(error, `Failed to reset settings for widget instance: ${instanceId}`);
            throw error;
        }
    }

    /**
     * @method removeWidgetLayoutEntry
     * @description Task 12 "Reset" also drops the widget's saved
     * position from layout.json (read-modify-write, same one-entry-only
     * discipline as updateWidgetPosition() — see that method's doc
     * comment) so the widget reappears at its `metadata.json`
     * `default-position` on next load instead of the spot it was reset
     * from. Safe to call for a widget with no saved position yet
     * (no-op).
     * @param {string} widgetId
     */
    removeWidgetLayoutEntry(widgetId) {
        const id = this._sanitizeWidgetId(widgetId);
        const layoutData = this.loadLayout();
        if (!layoutData?.widgets)
            return;

        const next = layoutData.widgets.filter(w => w.id !== id);
        if (next.length === layoutData.widgets.length)
            return; // nothing to remove

        this.saveLayout(next);
    }
}