export const SETTING_TYPES = Object.freeze([ "string", "number", "range", "boolean", "dropdown", "color", "font", "size" ]);

export function validateSettingsSchema(schema) {
    if (schema === undefined) return [];
    if (!Array.isArray(schema)) return [ '"settings" must be an array' ];
    const problems = [];
    const seenIds = new Set;
    schema.forEach((field, index) => {
        const label = typeof field?.id === "string" && field.id.length > 0 ? field.id : `#${index}`;
        if (typeof field?.id !== "string" || field.id.length === 0) {
            problems.push(`setting ${label}: missing required "id"`);
            return;
        }
        if (seenIds.has(field.id)) {
            problems.push(`setting "${field.id}": duplicate id`);
            return;
        }
        seenIds.add(field.id);
        if (!SETTING_TYPES.includes(field.type)) {
            problems.push(`setting "${field.id}": type "${field.type}" is not one of ${SETTING_TYPES.join(", ")}`);
            return;
        }
        if (typeof field.label !== "string" || field.label.length === 0) problems.push(`setting "${field.id}": missing required "label"`);
        if (!("default" in field)) problems.push(`setting "${field.id}": missing required "default"`);
        if (field.type === "range") {
            if (typeof field.min !== "number" || typeof field.max !== "number") problems.push(`setting "${field.id}": type "range" requires numeric "min" and "max"`); else if (field.min >= field.max) problems.push(`setting "${field.id}": "min" must be less than "max"`); else if (typeof field.default === "number" && (field.default < field.min || field.default > field.max)) problems.push(`setting "${field.id}": "default" (${field.default}) is outside the min/max range`);
        }
        if (field.type === "dropdown" && (!Array.isArray(field.options) || field.options.length === 0)) problems.push(`setting "${field.id}": type "dropdown" requires a non-empty "options" array`);
        if (field.type === "size") {
            const hasAnyBound = "min" in field || "max" in field;
            if (hasAnyBound) {
                if (typeof field.min !== "number" || typeof field.max !== "number") problems.push(`setting "${field.id}": type "size" requires numeric "min" and "max" together if either is given`); else if (field.min >= field.max) problems.push(`setting "${field.id}": "min" must be less than "max"`); else if (typeof field.default === "number" && (field.default < field.min || field.default > field.max)) problems.push(`setting "${field.id}": "default" (${field.default}) is outside the min/max range`);
            } else if (typeof field.default !== "number") {
                problems.push(`setting "${field.id}": type "size" requires a numeric "default" (pixels)`);
            }
        }
        if (field.type === "font" && typeof field.default !== "string") problems.push(`setting "${field.id}": type "font" requires a string "default" (e.g. "Sans 10")`);
    });
    return problems;
}

export function getSchemaDefaults(schema) {
    if (!Array.isArray(schema)) return {};
    const defaults = {};
    for (const field of schema) {
        if (typeof field?.id === "string" && field.id.length > 0 && "default" in field) defaults[field.id] = field.default;
    }
    return defaults;
}