// Single source of truth for per-widget card setting keys.
//
// Naming pattern:  card-[setting type]-[sub-setting]
//   card-background-color   card-opacity
//   card-corner-radius      card-corner-radius-enabled
//   card-border-enabled     card-border-color      card-border-width
//   card-shadow-enabled     card-shadow-color      card-shadow-opacity
//   card-shadow-blur        card-shadow-angle      card-shadow-distance
//   card-blur-enabled       card-blur-radius
//
// Plain module (no gi:// imports) so both the Shell process and the GTK4
// prefs process can import it.

export const CARD_KEYS = Object.freeze({
    backgroundColor: "card-background-color",
    opacity: "card-opacity",
    cornerRadius: "card-corner-radius",
    cornerRadiusEnabled: "card-corner-radius-enabled",
    borderEnabled: "card-border-enabled",
    borderColor: "card-border-color",
    borderWidth: "card-border-width",
    shadowEnabled: "card-shadow-enabled",
    shadowColor: "card-shadow-color",
    shadowOpacity: "card-shadow-opacity",
    shadowBlur: "card-shadow-blur",
    shadowAngle: "card-shadow-angle",
    shadowDistance: "card-shadow-distance",
    blurEnabled: "card-blur-enabled",
    blurRadius: "card-blur-radius"
});

// Pre-rename names -> current names. Used only to migrate saved settings.json
// files and old .gwct theme packs; never write these keys again.
export const LEGACY_CARD_KEY_MAP = Object.freeze({
    backgroundColor: "card-background-color",
    cardColor: "card-background-color",
    paperColor: "card-background-color",
    opacity: "card-opacity",
    cornerRadius: "card-corner-radius",
    widgetCornerRadius: "card-corner-radius",
    cornerRadiusEnabled: "card-corner-radius-enabled",
    borderEnabled: "card-border-enabled",
    borderColor: "card-border-color",
    borderWidth: "card-border-width",
    shadowEnabled: "card-shadow-enabled",
    shadowColor: "card-shadow-color",
    shadowOpacity: "card-shadow-opacity",
    shadowBlur: "card-shadow-blur",
    shadowAngle: "card-shadow-angle",
    shadowDistance: "card-shadow-distance",
    blurEnabled: "card-blur-enabled",
    blurRadius: "card-blur-radius"
});

// Renames legacy keys in place. A value already stored under the new key
// wins over the legacy one. Returns true when anything changed.
export function migrateCardSettings(settings) {
    if (!settings || typeof settings !== "object") return false;
    let changed = false;
    for (const [oldKey, newKey] of Object.entries(LEGACY_CARD_KEY_MAP)) {
        if (!Object.prototype.hasOwnProperty.call(settings, oldKey)) continue;
        if (!Object.prototype.hasOwnProperty.call(settings, newKey)) settings[newKey] = settings[oldKey];
        delete settings[oldKey];
        changed = true;
    }
    return changed;
}
