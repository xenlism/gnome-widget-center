import GLib from "gi://GLib";

import { validateConfig } from "./widgetConfigValidator.js";

import { fileExists, readTextFile } from "./fsUtils.js";

import { APPEARANCE_FIELD_IDS, buildAppearanceGroups } from "./appearanceFieldsSchema.js";

export function widgetHasConfigJson(widgetPath) {
    const configPath = GLib.build_filenamev([ widgetPath, "config.json" ]);
    return fileExists(configPath);
}

// Folds in whichever of the shared Card/Blur/Shadow/Border/Opacity
// fields (lib/appearanceFieldsSchema.js) this widget's own config.json
// doesn't already declare, so every widget always has an Appearance
// section - never mutates/duplicates a field the widget already
// defines under a matching id (a widget's own definition, wherever it
// lives in its tabs, always wins). Runs on the already-validated
// config, so it never needs to fail the widget's own load - if
// something about the merge itself goes wrong, the widget's own config
// still loads untouched.
function mergeAppearanceFields(config) {
    try {
        const existingIds = new Set;
        for (const tab of config.tabs) {
            for (const group of tab.groups) {
                for (const f of group.fields) existingIds.add(f.id);
            }
        }
        const missingIds = APPEARANCE_FIELD_IDS.filter(id => !existingIds.has(id));
        if (missingIds.length === 0) return config;
        const groups = buildAppearanceGroups().map(group => ({
            ...group,
            fields: group.fields.filter(f => missingIds.includes(f.id))
        })).filter(group => group.fields.length > 0);
        if (groups.length === 0) return config;
        const existingAppearanceTab = config.tabs.find(t => t.id === "appearance");
        if (existingAppearanceTab) {
            existingAppearanceTab.groups = [ ...existingAppearanceTab.groups, ...groups ];
        } else {
            config.tabs = [ ...config.tabs, {
                id: "appearance",
                label: "Appearance",
                description: "Background, blur, shadow, border, and opacity for this widget's card.",
                icon: "applications-graphics-symbolic",
                groups: groups
            } ];
        }
        return config;
    } catch (e) {
        return config;
    }
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
        config: mergeAppearanceFields(parsed),
        errors: []
    };
}