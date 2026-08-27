import GLib from "gi://GLib";

import { fileExists, readTextFileAsync, writeJsonFileAsync } from "./fsUtils.js";

import { invalidateWidgetConfigCache } from "./widgetConfigReader.js";

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

async function _readJson(path) {
    if (!fileExists(path)) return null;
    try {
        const text = await readTextFileAsync(path);
        return text === null ? null : JSON.parse(text);
    } catch (e) {
        return null;
    }
}

export async function saveCurrentSettingsAsWidgetDefaults(widgetPath, currentValues, position = null) {
    const result = {
        configUpdated: false,
        positionUpdated: false,
        errors: []
    };
    const configPath = GLib.build_filenamev([ widgetPath, "config.json" ]);
    const config = await _readJson(configPath);
    if (config === null) {
        result.errors.push(`could not read/parse ${configPath}`);
    } else {
        try {
            applyCurrentValuesAsConfigDefaults(config, currentValues ?? {});
            await writeJsonFileAsync(configPath, config);
            result.configUpdated = true;
            // readWidgetConfig() caches by path (see widgetConfigReader.js);
            // we just rewrote config.json out from under it, so the next
            // read of this widget's config needs to see this write, not the
            // stale cached copy from before "Save Defaults" was clicked.
            invalidateWidgetConfigCache(widgetPath);
        } catch (e) {
            result.errors.push(`failed to write ${configPath}: ${e.message}`);
        }
    }
    if (position) {
        const metadataPath = GLib.build_filenamev([ widgetPath, "metadata.json" ]);
        const metadata = await _readJson(metadataPath);
        if (metadata === null) {
            result.errors.push(`could not read/parse ${metadataPath}`);
        } else {
            try {
                metadata["default-position"] = {
                    x: position.x,
                    y: position.y,
                    monitor: position.monitor ?? 0
                };
                await writeJsonFileAsync(metadataPath, metadata);
                result.positionUpdated = true;
            } catch (e) {
                result.errors.push(`failed to write ${metadataPath}: ${e.message}`);
            }
        }
    }
    return result;
}
