// Card Color Scheme: one shared palette that widgets pull their colors from.
//
// Stored in a .gwct under  appearance.colorScheme  and in theme.json under
// global.colorScheme.  Each widget color field in config.json opts in with
//     "schemeRole": "text-1"
// so a widget added later starts with the scheme's colors instead of its own
// hard-coded defaults.  Saved per-widget values are never touched unless the
// user explicitly chooses "Apply to all widgets".
//
// Plain module (no gi:// imports): shared by the Shell and GTK4 prefs processes.

export const COLOR_SCHEME_ROLES = Object.freeze([
    "card-background", "card-border", "card-shadow",
    "text-1", "text-2",
    "ring-1", "ring-2", "ring-3", "ring-4",
    "accent"
]);

// role -> key used inside the scheme object (and in the .gwct)
export function schemeKey(role) {
    return `${role}-color`;
}

export const DEFAULT_COLOR_SCHEME = Object.freeze({
    "card-background-color": "#1C1F26F2",
    "card-border-color": "#FFFFFF33",
    "card-shadow-color": "#000000",
    "text-1-color": "#FFFFFF",
    "text-2-color": "#FFFFFF99",
    "ring-1-color": "#4FC3F7",
    "ring-2-color": "#81C784",
    "ring-3-color": "#FFB74D",
    "ring-4-color": "#BA68C8",
    "accent-color": "#4FC3F7"
});

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// Keeps only known keys with valid hex values. Returns null when nothing valid
// is left (= "no scheme": widgets keep their own defaults).
export function normalizeColorScheme(input) {
    if (!input || typeof input !== "object") return null;
    const out = {};
    for (const role of COLOR_SCHEME_ROLES) {
        const key = schemeKey(role);
        const value = input[key];
        if (typeof value === "string" && HEX_RE.test(value.trim())) out[key] = value.trim();
    }
    return Object.keys(out).length > 0 ? out : null;
}

// [{id, role}] for every config.json field that declares a schemeRole.
export function collectSchemeFields(config) {
    const found = [];
    if (!config || !Array.isArray(config.tabs)) return found;
    for (const tab of config.tabs) {
        for (const group of tab.groups ?? []) {
            for (const field of group.fields ?? []) {
                if (field?.id && COLOR_SCHEME_ROLES.includes(field.schemeRole)) {
                    found.push({ id: field.id, role: field.schemeRole });
                }
            }
        }
    }
    return found;
}

// {fieldId: color} for the fields of this widget that the scheme covers.
export function schemeDefaults(config, scheme) {
    const s = normalizeColorScheme(scheme);
    if (!s) return {};
    const out = {};
    for (const { id, role } of collectSchemeFields(config)) {
        const value = s[schemeKey(role)];
        if (value) out[id] = value;
    }
    return out;
}

// Overwrites the scheme-covered keys of an existing settings object.
// Returns the number of keys changed.
export function applySchemeToSettings(config, settings, scheme) {
    let changed = 0;
    for (const [id, value] of Object.entries(schemeDefaults(config, scheme))) {
        if (settings[id] !== value) {
            settings[id] = value;
            changed += 1;
        }
    }
    return changed;
}
