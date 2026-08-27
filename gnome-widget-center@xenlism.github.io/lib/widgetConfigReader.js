import GLib from "gi://GLib";

import { validateConfig } from "./widgetConfigValidator.js";

import { fileExists, readTextFile } from "./fsUtils.js";

import { APPEARANCE_FIELD_IDS, buildAppearanceGroups } from "./appearanceFieldsSchema.js";

export function widgetHasConfigJson(widgetPath) {
    const configPath = GLib.build_filenamev([ widgetPath, "config.json" ]);
    return fileExists(configPath);
}

const _configCache = new Map;

function mergeAppearanceFields(config) {    try {
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
    // config.json rarely changes while the extension is running, but this
    // gets called more than once for the same widget within a single
    // process — at initial load, again whenever that widget's settings
    // change (widgetRuntimeLoader.js re-applies defaults), and again on a
    // dev hot-reload — so a same-process cache keyed by path turns those
    // repeats into a plain object lookup instead of a fresh disk read each
    // time. Full async here would mean every widget's own top-level
    // `{...configJsonDefaults(import.meta.url)}` call (~50 of them, called
    // synchronously while building a plain object literal) would need to
    // become awaitable, which isn't a same-session fix — see EGO.md.
    if (_configCache.has(widgetPath)) return _configCache.get(widgetPath);
    const result = _readWidgetConfigUncached(widgetPath);
    // Don't cache read/parse/validation failures — those are usually a
    // widget author mid-edit, and the whole point of surfacing the error is
    // so the next attempt (e.g. after they fix config.json) picks it up.
    if (result.config !== null) _configCache.set(widgetPath, result);
    return result;
}

// Exposed for the one place that legitimately needs a fresh read: dev
// hot-reload, where the whole point is picking up on-disk edits.
export function invalidateWidgetConfigCache(widgetPath) {
    _configCache.delete(widgetPath);
}

function _readWidgetConfigUncached(widgetPath) {
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