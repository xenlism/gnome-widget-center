import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * @class SettingsService
 * @description Manages global HOST-level flags/preferences (which widgets
 * are disabled, dev-mode, etc) via GNOME's GSettings — compiled locally
 * inside the extension (`products/extension/schemas/`), never installed system-wide.
 *
 * มอดูลศูนย์กลางสำหรับการจัดการ Host-level settings เท่านั้น (ไม่ใช่ settings ของ
 * widget แต่ละตัว - อันนั้นเป็นหน้าที่ของ WidgetSettings/JSON ตาม
 * development/docs/SETTINGS_SPEC.md) อ้างอิงตามสเปก: development/docs/ARCHITECTURE.md §2.3
 *
 * แก้ไข 2026-07-13: เดิม init() เรียก
 * `Gio.SettingsSchemaSource.get_default()` ซึ่งมองหาแค่ schema ที่ compile
 * ติดตั้งระดับระบบ (`/usr/share/glib-2.0/schemas`) เท่านั้น — schema ของเรา
 * ไม่เคยถูกติดตั้งตรงนั้น (compile ไว้ใน `products/extension/schemas/` เอง) ดังนั้น
 * lookup() จะคืน null และ throw เสมอ ไม่ว่าจะสร้างไฟล์ .gschema.xml ถูกต้อง
 * แค่ไหนก็ตาม แก้เป็นใช้ `Extension.getSettings()` ที่ GNOME Shell 45+
 * ให้มาแทน — เมธอดนี้ resolve schema จากโฟลเดอร์ของ extension เองโดยตรง
 * ไม่ต้องแตะ system schema dir เลย (ตรงตามเป้าหมาย "ไม่ต้อง root" ของโปรเจกต์)
 */
export class SettingsService {
    /**
     * @param {Extension} extensionObject - the `this` from
     *   WidgetCenterExtension.enable() (extends the GNOME Shell Extension
     *   base class) — needed because getSettings() must know the
     *   extension's own install directory to find its local schema.
     */
    constructor(extensionObject) {
        this._extensionObject = extensionObject;
        /** @private {Gio.Settings} GNOME GSettings engine wrapper link */
        this._globalSettings = null;
        /** @private {boolean} Internal initialization state indicator */
        this._isInitialized = false;
        /** @private {string} Target unique local schema id */
        this._schemaId = 'org.gnome.shell.extensions.widget-center';
    }

    /**
     * @method init
     * @description Resolves the locally-compiled schema via the Extension
     * base class and initializes the GSettings link. Throws only if the
     * extension's own `schemas/gschemas.compiled` is missing/corrupt (a
     * packaging bug), never because of anything outside the extension.
     */
    init() {
        if (this._isInitialized) return;

        if (!this._extensionObject?.getSettings) {
            throw new Error(
                'SettingsService requires the Extension instance (with getSettings()) — ' +
                'pass `this` from enable(), not a bare object.'
            );
        }

        // getSettings() looks up products/extension/schemas/gschemas.compiled inside
        // this extension's own install dir - no system-wide compile needed.
        this._globalSettings = this._extensionObject.getSettings(this._schemaId);
        this._isInitialized = true;
    }

    /**
     * @method getGlobalValue
     * @description Safe retrieval of host preference fields mapped automatically to native JS types.
     * @param {string} key - Host configuration key name defined in the schema.
     * @returns {*} Formatted unpacked native JavaScript type data.
     */
    getGlobalValue(key) {
        if (!this._isInitialized) {
            throw new Error('SettingsService has not been initialized yet.');
        }

        if (!this._globalSettings.settings_schema.has_key(key)) {
            throw new Error(`The key '${key}' does not exist in the schema '${this._schemaId}'.`);
        }

        const variant = this._globalSettings.get_value(key);
        return variant.deep_unpack();
    }

    /**
     * @method setGlobalValue
     * @description Updates a host preference by auto-detecting the compiled schema data type.
     * @param {string} key - Target key name.
     * @param {*} value - Data to record into GSettings (dconf).
     */
    setGlobalValue(key, value) {
        if (!this._isInitialized) {
            throw new Error('SettingsService has not been initialized yet.');
        }

        if (!this._globalSettings.settings_schema.has_key(key)) {
            throw new Error(`The key '${key}' does not exist in the schema '${this._schemaId}'.`);
        }

        const keyType = this._globalSettings.settings_schema.get_key(key).get_value_type().get_string();
        const variant = GLib.Variant.new(keyType, value);
        this._globalSettings.set_value(key, variant);

        Gio.Settings.sync();
    }

    /**
     * @method isReady
     * @description Whether init() has completed successfully — callers
     *   (extension.js, prefs.js) treat SettingsService as non-essential
     *   per its own init() doc comment, so this lets them check once
     *   instead of wrapping every call in try/catch.
     * @returns {boolean}
     */
    get isReady() {
        return this._isInitialized;
    }

    /**
     * @method onChanged
     * @description Subscribes to live GSettings changes for one key (task
     * 05 — lets the Control Center's toggle switches take effect on the
     * desktop immediately, without a shell restart: prefs.js runs in a
     * separate GTK4 process, but both processes are watching the SAME
     * dconf-backed key, so this fires in the Shell process whenever the
     * prefs process changes it). Returns the GObject signal handler id,
     * to be passed to disconnect() during teardown.
     * @param {string} key
     * @param {function(*):void} callback - called with the new unpacked
     *   value every time the key changes, from either process.
     * @returns {number} handlerId
     */
    onChanged(key, callback) {
        if (!this._isInitialized) {
            throw new Error('SettingsService has not been initialized yet.');
        }

        return this._globalSettings.connect(`changed::${key}`, () => {
            callback(this.getGlobalValue(key));
        });
    }

    /**
     * @method disconnect
     * @description Disconnects a handler previously returned by
     * onChanged(). Safe to call with a null/undefined handlerId (no-op) so
     * callers don't need to guard every teardown path themselves.
     * @param {number} [handlerId]
     */
    disconnect(handlerId) {
        if (this._globalSettings && handlerId != null)
            this._globalSettings.disconnect(handlerId);
    }
}
