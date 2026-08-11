import GLib from "gi://GLib";

import { validateConfig } from "./widgetConfigValidator.js";

import { fileExists, readTextFile } from "./fsUtils.js";

export function widgetHasConfigJson(widgetPath) {
    const configPath = GLib.build_filenamev([ widgetPath, "config.json" ]);
    return fileExists(configPath);
}

export function readWidgetConfig(widgetPath) {
    const configPath = GLib.build_filenamev([ widgetPath, "config.json" ]);
    let contents;
    try {
        contents = readTextFile(configPath);
        if (contents === null) return {
            config: null,
            errors: []
        };
    } catch (e) {
        return {
            config: null,
            errors: [ {
                message: `Failed to read config.json: ${e.message}`
            } ]
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(contents);
    } catch (e) {
        return {
            config: null,
            errors: [ {
                message: `Failed to parse config.json: ${e.message}`
            } ]
        };
    }
    const errors = validateConfig(parsed);
    if (errors.length > 0) return {
        config: null,
        errors: errors
    };
    return {
        config: parsed,
        errors: []
    };
}