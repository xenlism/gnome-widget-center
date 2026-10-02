// Card Settings (global defaults): every per-widget card-* setting in one
// object, saved in a .gwct under  appearance.cardSettings  and in theme.json
// under  global.cardSettings.
//
// Why: a widget opened for the first time used to start with its own
// hard-coded card look (radius, border, shadow, blur, opacity ...) and had to
// be tuned one setting at a time.  With a card-settings block in the theme
// pack, every widget that has those card fields starts with the pack's look.
//
// Rules (same as the Card Color Scheme in colorScheme.js):
//   * Only fills keys that are still missing from a widget's saved settings,
//     so widgets the user already customized are never touched ...
//   * ... unless the user presses "Apply to all widgets" in Preferences.
//   * Only keys the widget actually declares (config.json fields, after the
//     shared Appearance fields are merged in) are written.
//   * Card colors: the Card Color Scheme (colorScheme.js) wins over the color
//     keys here, so a pack can carry either or both.
//
// Plain module (no gi:// imports): shared by the Shell and GTK4 prefs processes.

import { CARD_KEYS } from "./cardSettingKeys.js";

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// type: "color" | "bool" | "number".   min/max only for numbers.
export const CARD_SETTING_SPECS = Object.freeze({
    [CARD_KEYS.backgroundColor]: Object.freeze({ type: "color", fallback: "#000000F5" }),
    [CARD_KEYS.opacity]: Object.freeze({ type: "number", min: 0, max: 100, fallback: 100 }),
    [CARD_KEYS.cornerRadiusEnabled]: Object.freeze({ type: "bool", fallback: true }),
    [CARD_KEYS.cornerRadius]: Object.freeze({ type: "number", min: 0, max: 64, fallback: 18 }),
    [CARD_KEYS.borderEnabled]: Object.freeze({ type: "bool", fallback: false }),
    [CARD_KEYS.borderColor]: Object.freeze({ type: "color", fallback: "#FFFFFF33" }),
    [CARD_KEYS.borderWidth]: Object.freeze({ type: "number", min: 0, max: 16, fallback: 1 }),
    [CARD_KEYS.shadowEnabled]: Object.freeze({ type: "bool", fallback: false }),
    [CARD_KEYS.shadowColor]: Object.freeze({ type: "color", fallback: "#000000" }),
    [CARD_KEYS.shadowOpacity]: Object.freeze({ type: "number", min: 0, max: 100, fallback: 30 }),
    [CARD_KEYS.shadowBlur]: Object.freeze({ type: "number", min: 0, max: 100, fallback: 16 }),
    [CARD_KEYS.shadowAngle]: Object.freeze({ type: "number", min: 0, max: 360, fallback: 90 }),
    [CARD_KEYS.shadowDistance]: Object.freeze({ type: "number", min: 0, max: 60, fallback: 6 }),
    [CARD_KEYS.blurEnabled]: Object.freeze({ type: "bool", fallback: false }),
    [CARD_KEYS.blurRadius]: Object.freeze({ type: "number", min: 0, max: 100, fallback: 24 })
});

export const CARD_SETTING_IDS = Object.freeze(Object.keys(CARD_SETTING_SPECS));

export const DEFAULT_CARD_SETTINGS = Object.freeze(
    Object.fromEntries(CARD_SETTING_IDS.map(id => [ id, CARD_SETTING_SPECS[id].fallback ]))
);

function _coerce(spec, value) {
    if (spec.type === "color") {
        return typeof value === "string" && HEX_RE.test(value.trim()) ? value.trim() : undefined;
    }
    if (spec.type === "bool") {
        return typeof value === "boolean" ? value : undefined;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return Math.min(spec.max, Math.max(spec.min, value));
}

// Keeps only known card-* keys with valid values. Returns null when nothing
// valid is left (= "no card settings": widgets keep their own defaults).
export function normalizeCardSettings(input) {
    if (!input || typeof input !== "object") return null;
    const out = {};
    for (const id of CARD_SETTING_IDS) {
        if (!Object.prototype.hasOwnProperty.call(input, id)) continue;
        const value = _coerce(CARD_SETTING_SPECS[id], input[id]);
        if (value !== undefined) out[id] = value;
    }
    return Object.keys(out).length > 0 ? out : null;
}

// Card settings found in an existing widget's settings object (used by
// "copy from a widget" and when building a pack from the current desktop).
export function extractCardSettings(settings) {
    return normalizeCardSettings(settings);
}

// Ids of every card-* field this widget's config.json declares.
export function collectCardFieldIds(config) {
    const ids = new Set;
    if (!config || !Array.isArray(config.tabs)) return ids;
    for (const tab of config.tabs) {
        for (const group of tab.groups ?? []) {
            for (const field of group.fields ?? []) {
                if (field?.id && CARD_SETTING_SPECS[field.id]) ids.add(field.id);
            }
        }
    }
    return ids;
}

// {fieldId: value} for the card fields of this widget that the block covers.
export function cardSettingsDefaults(config, cardSettings) {
    const s = normalizeCardSettings(cardSettings);
    if (!s) return {};
    const declared = collectCardFieldIds(config);
    const out = {};
    for (const id of declared) {
        if (Object.prototype.hasOwnProperty.call(s, id)) out[id] = s[id];
    }
    return out;
}

// Overwrites the covered card keys of an existing settings object.
// Returns the number of keys changed.
export function applyCardSettingsToSettings(config, settings, cardSettings) {
    let changed = 0;
    for (const [id, value] of Object.entries(cardSettingsDefaults(config, cardSettings))) {
        if (settings[id] !== value) {
            settings[id] = value;
            changed += 1;
        }
    }
    return changed;
}
