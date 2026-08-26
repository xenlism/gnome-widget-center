// lib/appearanceFieldsSchema.js
//
// Single source of truth for the "Card" settings every widget's own
// card is styled from — background color, background blur, shadow,
// border, opacity. These are the exact fields lib/widgetVisualKit.js's
// cardStyleCss()/blurCss()/shadowBoxShadowCss()/borderCss()/
// opacityValue() read off a widget's own settings (see
// lib/cardLayers.js's applyLayeredCardStyle()).
//
// Previously ~44 widgets each hand-rolled a copy of these fields in
// their own config.json (same ids, same defaults, copy-pasted), and
// any widget that didn't (e.g. an old themeable:true widget) had no
// Appearance tab at all. lib/widgetConfigReader.js's
// mergeAppearanceFields() now folds these in automatically for every
// widget, filling in only what a widget's own config.json doesn't
// already declare - a widget that already has its own copy of a field
// (id match) always keeps its own definition untouched. shadow-angle/
// shadow-distance are deliberately NOT here - those stay global (see
// lib/globalShadowHelper.js), a widget's own settings for them are
// never read.
//
// cornerRadiusEnabled: most widgets never read this directly - they call
// cardStyleCss()/applyLayeredCardStyle() (lib/widgetVisualKit.js /
// lib/cardLayers.js), which already resolve it via resolveCornerRadius()
// and pick this field up automatically the moment it's declared here.
// The exception is any widget that builds its own card CSS by hand
// instead of delegating to those helpers - currently widgets/power-menu,
// widgets/settings-control, and widgets/notification-stack - which must
// each call resolveCornerRadius() themselves, or this toggle shows up in
// their settings UI (added automatically, see mergeAppearanceFields()
// below) but silently does nothing - the same bug that previously hit
// "Enable background blur" on that same set of hand-rolled widgets.
//
// NOT exported for third-party widgets to import directly (they live
// outside this extension's directory and can't reach lib/*.js - see
// CLAUDE.md "Architecture facts"). A third-party widget that wants
// these fields still has to declare its own copies in its own
// config.json, same as before.

export const APPEARANCE_FIELD_IDS = Object.freeze([
    "backgroundColor", "cornerRadius", "cornerRadiusEnabled", "blurEnabled", "blurRadius",
    "shadowEnabled", "shadowColor", "shadowOpacity", "shadowBlur",
    "borderEnabled", "borderColor", "borderWidth", "opacity"
]);

function field(def) {
    return Object.freeze(def);
}

// Grouped the same way the hand-rolled copies typically were: Card
// (background+corner-radius), Background Blur, Shadow, Border, Opacity.
// Same 12 fields as buildAppearanceGroups() above, but in the flat
// {id, type, label, default, ...} shape lib/settingsSchemaUI.js's
// buildSettingsPage() expects (the fallback settings renderer used
// when a widget has no config.json/prefs.js/settings.js at all - see
// lib/prefsWidgetManagement.js's _openWidgetPrefs()). Kept as a
// separate function rather than converting buildAppearanceGroups()'s
// shape at call time because the two renderers' field shapes really
// are different enough (dataType+fieldType+tabs/groups vs a flat
// type string) that a lossy on-the-fly conversion would be harder to
// keep correct than just declaring both directly.
export function buildAppearanceFieldsFlat() {
    return [
        field({
            id: "backgroundColor",
            type: "color",
            label: "Background color",
            description: "Card background. Use the alpha slider for transparency.",
            default: "#000000F5"
        }),
        field({
            id: "cornerRadiusEnabled",
            type: "boolean",
            label: "Round card corners",
            description: "Turn off for square corners regardless of the radius below.",
            default: true
        }),
        field({
            id: "cornerRadius",
            type: "range",
            label: "Corner radius",
            description: "Roundness of the card corners",
            default: 18,
            min: 0,
            max: 64,
            step: 1
        }),
        field({
            id: "blurEnabled",
            type: "boolean",
            label: "Enable background blur",
            description: "",
            default: false
        }),
        field({
            id: "blurRadius",
            type: "range",
            label: "Blur radius",
            description: "",
            default: 24,
            min: 0,
            max: 100,
            step: 1
        }),
        field({
            id: "shadowEnabled",
            type: "boolean",
            label: "Enable shadow",
            description: "",
            default: false
        }),
        field({
            id: "shadowColor",
            type: "color",
            label: "Shadow color",
            description: "",
            default: "#000000"
        }),
        field({
            id: "shadowOpacity",
            type: "range",
            label: "Shadow transparency",
            description: "",
            default: 30,
            min: 0,
            max: 100,
            step: 1
        }),
        field({
            id: "shadowBlur",
            type: "range",
            label: "Shadow blur",
            description: "",
            default: 16,
            min: 0,
            max: 100,
            step: 1
        }),
        field({
            id: "borderEnabled",
            type: "boolean",
            label: "Enable border",
            description: "Draw a border around this widget's card",
            default: false
        }),
        field({
            id: "borderColor",
            type: "color",
            label: "Border color",
            description: "",
            default: "#FFFFFF33"
        }),
        field({
            id: "borderWidth",
            type: "range",
            label: "Border width",
            description: "",
            default: 1,
            min: 0,
            max: 16,
            step: 1
        }),
        field({
            id: "opacity",
            type: "range",
            label: "Opacity",
            description: "Fades the entire widget - background, text, icons, everything.",
            default: 100,
            min: 0,
            max: 100,
            step: 1
        })
    ];
}

export function buildAppearanceGroups() {
    return [
        {
            id: "appearance-card",
            label: "Card",
            description: "",
            fields: [
                field({
                    id: "backgroundColor",
                    label: "Background color",
                    description: "Card background. Use the alpha slider for transparency.",
                    dataType: "string",
                    fieldType: "colorpicker",
                    format: "color",
                    alpha: true,
                    default: "#000000F5"
                }),
                field({
                    id: "cornerRadiusEnabled",
                    label: "Round card corners",
                    description: "Turn off for square corners regardless of the radius below.",
                    dataType: "boolean",
                    fieldType: "switch",
                    default: true
                }),
                field({
                    id: "cornerRadius",
                    label: "Corner radius",
                    description: "Roundness of the card corners",
                    dataType: "integer",
                    fieldType: "spinbutton",
                    default: 18,
                    min: 0,
                    max: 64,
                    step: 1,
                    suffix: "px",
                    visibleIf: "cornerRadiusEnabled"
                })
            ]
        },
        {
            id: "appearance-blur",
            label: "Background Blur",
            description: "",
            fields: [
                field({
                    id: "blurEnabled",
                    label: "Enable background blur",
                    description: "",
                    dataType: "boolean",
                    fieldType: "switch",
                    default: false
                }),
                field({
                    id: "blurRadius",
                    label: "Blur radius",
                    description: "",
                    dataType: "integer",
                    fieldType: "spinbutton",
                    default: 24,
                    min: 0,
                    max: 100,
                    step: 1,
                    suffix: "px",
                    visibleIf: "blurEnabled"
                })
            ]
        },
        {
            id: "appearance-shadow",
            label: "Shadow",
            description: "Angle and distance are set once for every widget - see Preferences → Appearance → Global Shadow.",
            fields: [
                field({
                    id: "shadowEnabled",
                    label: "Enable shadow",
                    description: "",
                    dataType: "boolean",
                    fieldType: "switch",
                    default: false
                }),
                field({
                    id: "shadowColor",
                    label: "Shadow color",
                    description: "",
                    dataType: "string",
                    fieldType: "colorpicker",
                    default: "#000000",
                    visibleIf: "shadowEnabled"
                }),
                field({
                    id: "shadowOpacity",
                    label: "Shadow transparency",
                    description: "",
                    dataType: "integer",
                    fieldType: "slider",
                    default: 30,
                    min: 0,
                    max: 100,
                    step: 1,
                    suffix: "%",
                    visibleIf: "shadowEnabled"
                }),
                field({
                    id: "shadowBlur",
                    label: "Shadow blur",
                    description: "",
                    dataType: "integer",
                    fieldType: "spinbutton",
                    default: 16,
                    min: 0,
                    max: 100,
                    step: 1,
                    suffix: "px",
                    visibleIf: "shadowEnabled"
                })
            ]
        },
        {
            id: "appearance-border",
            label: "Border & Opacity",
            description: "",
            fields: [
                field({
                    id: "borderEnabled",
                    label: "Enable border",
                    description: "Draw a border around this widget's card",
                    dataType: "boolean",
                    fieldType: "switch",
                    default: false
                }),
                field({
                    id: "borderColor",
                    label: "Border color",
                    description: "",
                    dataType: "string",
                    fieldType: "colorpicker",
                    format: "color",
                    alpha: true,
                    default: "#FFFFFF33",
                    visibleIf: "borderEnabled"
                }),
                field({
                    id: "borderWidth",
                    label: "Border width",
                    description: "",
                    dataType: "integer",
                    fieldType: "spinbutton",
                    default: 1,
                    min: 0,
                    max: 16,
                    step: 1,
                    suffix: "px",
                    visibleIf: "borderEnabled"
                }),
                field({
                    id: "opacity",
                    label: "Opacity",
                    description: "Fades the entire widget - background, text, icons, everything.",
                    dataType: "integer",
                    fieldType: "slider",
                    default: 100,
                    min: 0,
                    max: 100,
                    step: 1,
                    suffix: "%"
                })
            ]
        }
    ];
}
