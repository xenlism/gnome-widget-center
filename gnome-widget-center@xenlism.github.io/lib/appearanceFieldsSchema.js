export const APPEARANCE_FIELD_IDS = Object.freeze([
    "card-background-color", "card-corner-radius", "card-corner-radius-enabled", "card-blur-enabled", "card-blur-radius",
    "card-shadow-enabled", "card-shadow-color", "card-shadow-opacity", "card-shadow-blur",
    "card-border-enabled", "card-border-color", "card-border-width", "card-opacity"
]);

function field(def) {
    return Object.freeze(def);
}

export function buildAppearanceFieldsFlat() {
    return [
        field({
            id: "card-background-color",
            schemeRole: "card-background",
            type: "color",
            label: "Background color",
            description: "Card background. Use the alpha slider for transparency.",
            default: "#000000F5"
        }),
        field({
            id: "card-corner-radius-enabled",
            type: "boolean",
            label: "Round card corners",
            description: "Turn off for square corners regardless of the radius below.",
            default: true
        }),
        field({
            id: "card-corner-radius",
            type: "range",
            label: "Corner radius",
            description: "Roundness of the card corners",
            default: 18,
            min: 0,
            max: 64,
            step: 1
        }),
        field({
            id: "card-blur-enabled",
            type: "boolean",
            label: "Enable background blur",
            description: "",
            default: false
        }),
        field({
            id: "card-blur-radius",
            type: "range",
            label: "Blur radius",
            description: "",
            default: 24,
            min: 0,
            max: 100,
            step: 1
        }),
        field({
            id: "card-shadow-enabled",
            type: "boolean",
            label: "Enable shadow",
            description: "",
            default: false
        }),
        field({
            id: "card-shadow-color",
            schemeRole: "card-shadow",
            type: "color",
            label: "Shadow color",
            description: "",
            default: "#000000"
        }),
        field({
            id: "card-shadow-opacity",
            type: "range",
            label: "Shadow transparency",
            description: "",
            default: 30,
            min: 0,
            max: 100,
            step: 1
        }),
        field({
            id: "card-shadow-blur",
            type: "range",
            label: "Shadow blur",
            description: "",
            default: 16,
            min: 0,
            max: 100,
            step: 1
        }),
        field({
            id: "card-border-enabled",
            type: "boolean",
            label: "Enable border",
            description: "Draw a border around this widget's card",
            default: false
        }),
        field({
            id: "card-border-color",
            schemeRole: "card-border",
            type: "color",
            label: "Border color",
            description: "",
            default: "#FFFFFF33"
        }),
        field({
            id: "card-border-width",
            type: "range",
            label: "Border width",
            description: "",
            default: 1,
            min: 0,
            max: 16,
            step: 1
        }),
        field({
            id: "card-opacity",
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
                    id: "card-background-color",
                    schemeRole: "card-background",
                    label: "Background color",
                    description: "Card background. Use the alpha slider for transparency.",
                    dataType: "string",
                    fieldType: "colorpicker",
                    format: "color",
                    alpha: true,
                    default: "#000000F5"
                }),
                field({
                    id: "card-corner-radius-enabled",
                    label: "Round card corners",
                    description: "Turn off for square corners regardless of the radius below.",
                    dataType: "boolean",
                    fieldType: "switch",
                    default: true
                }),
                field({
                    id: "card-corner-radius",
                    label: "Corner radius",
                    description: "Roundness of the card corners",
                    dataType: "integer",
                    fieldType: "spinbutton",
                    default: 18,
                    min: 0,
                    max: 64,
                    step: 1,
                    suffix: "px",
                    visibleIf: "card-corner-radius-enabled"
                })
            ]
        },
        {
            id: "appearance-blur",
            label: "Background Blur",
            description: "",
            fields: [
                field({
                    id: "card-blur-enabled",
                    label: "Enable background blur",
                    description: "",
                    dataType: "boolean",
                    fieldType: "switch",
                    default: false
                }),
                field({
                    id: "card-blur-radius",
                    label: "Blur radius",
                    description: "",
                    dataType: "integer",
                    fieldType: "spinbutton",
                    default: 24,
                    min: 0,
                    max: 100,
                    step: 1,
                    suffix: "px",
                    visibleIf: "card-blur-enabled"
                })
            ]
        },
        {
            id: "appearance-shadow",
            label: "Shadow",
            description: "Angle and distance are set once for every widget - see Preferences → Appearance → Global Shadow.",
            fields: [
                field({
                    id: "card-shadow-enabled",
                    label: "Enable shadow",
                    description: "",
                    dataType: "boolean",
                    fieldType: "switch",
                    default: false
                }),
                field({
                    id: "card-shadow-color",
                    schemeRole: "card-shadow",
                    label: "Shadow color",
                    description: "",
                    dataType: "string",
                    fieldType: "colorpicker",
                    default: "#000000",
                    visibleIf: "card-shadow-enabled"
                }),
                field({
                    id: "card-shadow-opacity",
                    label: "Shadow transparency",
                    description: "",
                    dataType: "integer",
                    fieldType: "slider",
                    default: 30,
                    min: 0,
                    max: 100,
                    step: 1,
                    suffix: "%",
                    visibleIf: "card-shadow-enabled"
                }),
                field({
                    id: "card-shadow-blur",
                    label: "Shadow blur",
                    description: "",
                    dataType: "integer",
                    fieldType: "spinbutton",
                    default: 16,
                    min: 0,
                    max: 100,
                    step: 1,
                    suffix: "px",
                    visibleIf: "card-shadow-enabled"
                })
            ]
        },
        {
            id: "appearance-border",
            label: "Border & Opacity",
            description: "",
            fields: [
                field({
                    id: "card-border-enabled",
                    label: "Enable border",
                    description: "Draw a border around this widget's card",
                    dataType: "boolean",
                    fieldType: "switch",
                    default: false
                }),
                field({
                    id: "card-border-color",
                    schemeRole: "card-border",
                    label: "Border color",
                    description: "",
                    dataType: "string",
                    fieldType: "colorpicker",
                    format: "color",
                    alpha: true,
                    default: "#FFFFFF33",
                    visibleIf: "card-border-enabled"
                }),
                field({
                    id: "card-border-width",
                    label: "Border width",
                    description: "",
                    dataType: "integer",
                    fieldType: "spinbutton",
                    default: 1,
                    min: 0,
                    max: 16,
                    step: 1,
                    suffix: "px",
                    visibleIf: "card-border-enabled"
                }),
                field({
                    id: "card-opacity",
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
