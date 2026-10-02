// Font Settings (global defaults): the font face + size for the shared text
// roles, saved in a .gwct under  appearance.fontSettings  and in theme.json
// under  global.fontSettings.
//
// Same idea as the Card Color Scheme (colorScheme.js), but for fonts: every
// fontpicker field in a widget's config.json can opt in with
//     "fontRole": "text-1"      (or "text-2")
// and a widget added later starts with the pack's text-1 / text-2 font
// instead of its own hard-coded default.
//
// A value is a Pango font string ("Sans Bold 24"), the same format the
// fontpicker fields already store, so face and size travel together.
//
// Rules (same as colorScheme.js / cardDefaults.js):
//   * Only fills keys that are still missing from a widget's saved settings,
//     so widgets the user already customized are never touched ...
//   * ... unless the user presses "Apply to all widgets" in Preferences.
//   * Only fields the widget declares with a fontRole are written.
//
// Plain module (no gi:// imports): shared by the Shell and GTK4 prefs processes.

export const FONT_ROLES = Object.freeze([ "text-1", "text-2" ]);

// role -> key used inside the fontSettings object (and in the .gwct)
export function fontKey(role) {
    return `${role}-font`;
}

export const DEFAULT_FONT_SETTINGS = Object.freeze({
    "text-1-font": "Sans Bold 24",
    "text-2-font": "Sans 12"
});

// "Family [Style ...] Size" with size 1..200 (decimals allowed).
const FONT_RE = /^(.+?)\s+(\d+(?:\.\d+)?)$/;

export function parseFont(value) {
    if (typeof value !== "string") return null;
    const m = FONT_RE.exec(value.trim());
    if (!m) return null;
    const size = Number(m[2]);
    if (!Number.isFinite(size) || size < 1 || size > 200) return null;
    return { face: m[1], size: size };
}

// Keeps only known keys with valid Pango font strings. Returns null when
// nothing valid is left (= "no font settings": widgets keep their own).
export function normalizeFontSettings(input) {
    if (!input || typeof input !== "object") return null;
    const out = {};
    for (const role of FONT_ROLES) {
        const key = fontKey(role);
        if (parseFont(input[key])) out[key] = input[key].trim();
    }
    return Object.keys(out).length > 0 ? out : null;
}

// [{id, role}] for every config.json field that declares a fontRole.
export function collectFontFields(config) {
    const found = [];
    if (!config || !Array.isArray(config.tabs)) return found;
    for (const tab of config.tabs) {
        for (const group of tab.groups ?? []) {
            for (const field of group.fields ?? []) {
                if (field?.id && FONT_ROLES.includes(field.fontRole)) {
                    found.push({ id: field.id, role: field.fontRole, default: field.default });
                }
            }
        }
    }
    return found;
}

// {fieldId: fontString} for the font fields of this widget that the block covers.
export function fontSettingsDefaults(config, fontSettings) {
    const s = normalizeFontSettings(fontSettings);
    if (!s) return {};
    const out = {};
    for (const { id, role } of collectFontFields(config)) {
        const value = s[fontKey(role)];
        if (value) out[id] = value;
    }
    return out;
}

// Overwrites the covered font keys of an existing settings object.
// Returns the number of keys changed.
export function applyFontSettingsToSettings(config, settings, fontSettings) {
    let changed = 0;
    for (const [id, value] of Object.entries(fontSettingsDefaults(config, fontSettings))) {
        if (settings[id] !== value) {
            settings[id] = value;
            changed += 1;
        }
    }
    return changed;
}

// Derives the font block from a set of widgets: for each role, the most
// common font value among the widgets' fontRole fields (saved value first,
// config default otherwise). Ties go to the value seen first.
//   items: [{ config, settings }]
// Returns null when no widget has a font field for any role.
export function deriveFontSettings(items) {
    const counts = {};
    for (const role of FONT_ROLES) counts[role] = new Map;
    for (const { config, settings } of items ?? []) {
        for (const { id, role, default: dflt } of collectFontFields(config)) {
            const raw = settings && typeof settings[id] === "string" ? settings[id] : dflt;
            if (!parseFont(raw)) continue;
            const value = raw.trim();
            counts[role].set(value, (counts[role].get(value) ?? 0) + 1);
        }
    }
    const out = {};
    for (const role of FONT_ROLES) {
        let best = null, bestCount = 0;
        for (const [value, n] of counts[role]) {
            if (n > bestCount) { best = value; bestCount = n; }
        }
        if (best) out[fontKey(role)] = best;
    }
    return normalizeFontSettings(out);
}
