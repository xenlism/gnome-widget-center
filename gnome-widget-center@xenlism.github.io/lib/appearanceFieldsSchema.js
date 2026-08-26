export const APPEARANCE_FIELD_IDS = Object.freeze([
    "backgroundColor", "cornerRadius", "cornerRadiusEnabled", "blurEnabled", "blurRadius",
    "shadowEnabled", "shadowColor", "shadowOpacity", "shadowBlur",
    "borderEnabled", "borderColor", "borderWidth", "opacity"
]);

function field(def) {
    return Object.freeze(def);
}

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
