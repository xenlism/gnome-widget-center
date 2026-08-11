import GLib from "gi://GLib";

import { fileExists, readTextFile, writeJsonFile } from "./fsUtils.js";

/**
 * Dev-only tool: "bake current settings into config.json's defaults".
 *
 * Point this at a widget's own folder (widgets/<id>/) plus the *current*
 * settings a live instance of that widget has (from StorageService's
 * per-instance JSON, NOT config.json itself) - typically because you've
 * been tweaking a widget's Appearance settings live on the desktop and
 * now want config.json's own `default` values to match what you landed
 * on, instead of hand-editing every field by hand.
 *
 * Walks config.json's tabs -> groups -> fields (same shape
 * widgetConfigValidator.js's getConfigDefaults() reads FROM - this is
 * the write direction) and, for every field whose id is present in
 * `currentValues`, overwrites that field's own `default` with the
 * current value. Fields NOT present in `currentValues` (e.g. the user
 * never touched them, so no per-instance override exists) keep
 * whatever `default` config.json already had - this never invents a
 * default for a field with no current value to source one from.
 *
 * A `fieldType: "object"` field with `properties` (see
 * getConfigDefaults()'s own handling of this shape) is updated
 * per-property: `currentValues[field.id]` is expected to be an object
 * itself, and each of its keys overwrites the matching
 * `properties[key].default`.
 */
export function applyCurrentValuesAsConfigDefaults(config, currentValues) {
    if (!config || !Array.isArray(config.tabs) || !currentValues) return config;
    const applyToFields = fields => {
        for (const field of fields ?? []) {
            if (!(field.id in currentValues)) continue;
            const currentValue = currentValues[field.id];
            if (field.fieldType === "object" && field.properties && currentValue && typeof currentValue === "object") {
                for (const [key, propField] of Object.entries(field.properties)) {
                    if (key in currentValue) propField.default = currentValue[key];
                }
            } else {
                field.default = currentValue;
            }
        }
    };
    for (const tab of config.tabs) {
        for (const group of tab.groups ?? []) applyToFields(group.fields);
    }
    return config;
}

/** @private reads and JSON.parses a file, returning `null` on any read/parse failure. */
function _readJson(path) {
    if (!fileExists(path)) return null;
    try {
        const text = readTextFile(path);
        return text === null ? null : JSON.parse(text);
    } catch (e) {
        return null;
    }
}

/**
 * Orchestrates the full "save current settings as defaults" pass for
 * one widget:
 *
 * 1. Reads `<widgetPath>/config.json`, applies `currentValues` onto its
 *    fields' `default`s (see applyCurrentValuesAsConfigDefaults() above),
 *    writes it back.
 * 2. If `position` is given ({x, y, monitor} - the same shape
 *    StorageService.getWidgetPosition()/metadata.json's own
 *    `default-position` already use), reads `<widgetPath>/metadata.json`
 *    and overwrites its `default-position` with it, writes it back.
 *
 * Both files are read/written independently - a problem with one
 * (missing/unparsable file) does not block the other. Returns which
 * parts actually succeeded, so a caller (e.g. a future dev-mode UI
 * button) can report a partial failure instead of assuming success.
 *
 * @param {string} widgetPath - a widget's own folder, e.g. the same
 *   `path` StorageService/WidgetLoader already track per widget id.
 * @param {Object} currentValues - flat {fieldId: value} - typically
 *   `storageService.getWidgetSettings(instanceId)`, passed in by the
 *   caller rather than read here, since resolving an "instance id" to
 *   its live settings is StorageService's job, not this dev tool's.
 * @param {{x: number, y: number, monitor: number}|null} [position]
 * @returns {{configUpdated: boolean, positionUpdated: boolean, errors: string[]}}
 */
export function saveCurrentSettingsAsWidgetDefaults(widgetPath, currentValues, position = null) {
    const result = {
        configUpdated: false,
        positionUpdated: false,
        errors: []
    };
    const configPath = GLib.build_filenamev([ widgetPath, "config.json" ]);
    const config = _readJson(configPath);
    if (config === null) {
        result.errors.push(`could not read/parse ${configPath}`);
    } else {
        try {
            applyCurrentValuesAsConfigDefaults(config, currentValues ?? {});
            writeJsonFile(configPath, config);
            result.configUpdated = true;
        } catch (e) {
            result.errors.push(`failed to write ${configPath}: ${e.message}`);
        }
    }
    if (position) {
        const metadataPath = GLib.build_filenamev([ widgetPath, "metadata.json" ]);
        const metadata = _readJson(metadataPath);
        if (metadata === null) {
            result.errors.push(`could not read/parse ${metadataPath}`);
        } else {
            try {
                metadata["default-position"] = {
                    x: position.x,
                    y: position.y,
                    monitor: position.monitor ?? 0
                };
                writeJsonFile(metadataPath, metadata);
                result.positionUpdated = true;
            } catch (e) {
                result.errors.push(`failed to write ${metadataPath}: ${e.message}`);
            }
        }
    }
    return result;
}
