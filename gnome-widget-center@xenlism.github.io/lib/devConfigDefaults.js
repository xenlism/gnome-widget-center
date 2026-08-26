import GLib from "gi://GLib";

import { fileExists, readTextFile, writeJsonFile } from "./fsUtils.js";

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

function _readJson(path) {
    if (!fileExists(path)) return null;
    try {
        const text = readTextFile(path);
        return text === null ? null : JSON.parse(text);
    } catch (e) {
        return null;
    }
}

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
