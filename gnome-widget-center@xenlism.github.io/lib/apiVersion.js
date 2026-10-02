// Widget API version (the `api-version` field of a widget's metadata.json).
//
// 2.0  card-* setting keys (lib/cardSettingKeys.js), appearance.cardSettings and
//      appearance.colorScheme in .gwct, schemeRole in config.json.
//      This is the breaking change: v1 widgets read the old key names
//      (backgroundColor, cornerRadius, ...) that saved settings no longer contain.
//
// Plain module (no gi:// imports): shared by the Shell and GTK4 prefs processes.

export const HOST_API_VERSION = 2;

// Oldest widget API this host still loads. Lower this (e.g. to 1) to let old
// widgets keep loading; they would then need the card-* key rename themselves.
export const MIN_SUPPORTED_API_VERSION = 2;

// Accepts 2, 2.0, "2", "2.0", "2.0.0". Returns the major number, or null when
// the value is missing or not a version.
export function parseApiVersion(value) {
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
    if (typeof value === "string") {
        const match = /^\s*(\d+)(?:\.\d+){0,2}\s*$/.exec(value);
        return match ? parseInt(match[1], 10) : null;
    }
    return null;
}

// { ok: true } or { ok: false, reason } for a widget's metadata object.
export function checkApiVersion(metadata) {
    const raw = metadata?.["api-version"];
    const major = parseApiVersion(raw);
    if (major === null) {
        return {
            ok: false,
            reason: `missing or invalid "api-version" (this Widget Center needs ${MIN_SUPPORTED_API_VERSION}.0, got ${JSON.stringify(raw)})`
        };
    }
    if (major > HOST_API_VERSION) {
        return {
            ok: false,
            reason: `built for widget API ${major}.0, but this Widget Center only supports up to ${HOST_API_VERSION}.0 - update Widget Center`
        };
    }
    if (major < MIN_SUPPORTED_API_VERSION) {
        return {
            ok: false,
            reason: `built for widget API ${major}.0, but this Widget Center needs ${MIN_SUPPORTED_API_VERSION}.0 or newer - update the widget to the card-* setting keys (see WIDGET_API.md 9.3.1)`
        };
    }
    return { ok: true };
}
