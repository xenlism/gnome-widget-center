import Gio from "gi://Gio";

import GLib from "gi://GLib";

export class SettingsService {
    constructor(extensionObjectOrSchemasDir) {
        if (typeof extensionObjectOrSchemasDir === "string") {
            this._extensionObject = null;
            this._schemasDir = extensionObjectOrSchemasDir;
        } else {
            this._extensionObject = extensionObjectOrSchemasDir;
            this._schemasDir = null;
        }
        this._globalSettings = null;
        this._isInitialized = false;
        this._schemaId = "org.gnome.shell.extensions.widget-center";
    }
    init() {
        if (this._isInitialized) return;
        if (this._extensionObject?.getSettings) {
            this._globalSettings = this._extensionObject.getSettings(this._schemaId);
        } else if (this._schemasDir) {
            const source = Gio.SettingsSchemaSource.new_from_directory(this._schemasDir, Gio.SettingsSchemaSource.get_default(), false);
            const schema = source.lookup(this._schemaId, false);
            if (!schema) {
                throw new Error(`schema '${this._schemaId}' not found under ${this._schemasDir} — ` + "is schemas/gschemas.compiled present and up to date?");
            }
            this._globalSettings = new Gio.Settings({
                settings_schema: schema
            });
        } else {
            throw new Error("SettingsService requires either an Extension instance (with getSettings()) " + "or a schemas directory path — pass `this` from enable()/fillPreferencesWindow(), " + "or the extension's install directory's `schemas/` path.");
        }
        this._isInitialized = true;
    }
    getGlobalValue(key) {
        if (!this._isInitialized) {
            throw new Error("SettingsService has not been initialized yet.");
        }
        if (!this._globalSettings.settings_schema.has_key(key)) {
            throw new Error(`The key '${key}' does not exist in the schema '${this._schemaId}'.`);
        }
        const variant = this._globalSettings.get_value(key);
        return variant.deep_unpack();
    }
    setGlobalValue(key, value) {
        if (!this._isInitialized) {
            throw new Error("SettingsService has not been initialized yet.");
        }
        if (!this._globalSettings.settings_schema.has_key(key)) {
            throw new Error(`The key '${key}' does not exist in the schema '${this._schemaId}'.`);
        }
        const keyType = this._globalSettings.settings_schema.get_key(key).get_value_type().dup_string();
        const variant = new GLib.Variant(keyType, value);
        this._globalSettings.set_value(key, variant);
        Gio.Settings.sync();
    }
    get isReady() {
        return this._isInitialized;
    }
    onChanged(key, callback) {
        if (!this._isInitialized) {
            throw new Error("SettingsService has not been initialized yet.");
        }
        return this._globalSettings.connect(`changed::${key}`, () => {
            callback(this.getGlobalValue(key));
        });
    }
    disconnect(handlerId) {
        if (this._globalSettings && handlerId != null) this._globalSettings.disconnect(handlerId);
    }
}