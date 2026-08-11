export const VALID_TYPES = [ "font", "color", "date", "boolean", "option", "number", "range", "text", "action", "icon", "multiOption" ];

export class WidgetSettingsSchema {
    constructor(widgetId) {
        if (!widgetId) {
            throw new Error("WidgetSettingsSchema requires a widgetId");
        }
        this.widgetId = widgetId;
        this._fields = [];
        this._keys = new Set;
        this._currentGroup = null;
    }
    _register(field) {
        if (this._keys.has(field.key)) {
            throw new Error(`[gwc.settings] Duplicate setting key "${field.key}" in widget "${this.widgetId}"`);
        }
        this._keys.add(field.key);
        field.group = this._currentGroup;
        this._fields.push(field);
        return this;
    }
    group(title) {
        this._currentGroup = title;
        return this;
    }
    showIf(key, value) {
        if (this._fields.length === 0) {
            throw new Error("[gwc.settings] showIf() must be chained right after a setXxx()/option() call");
        }
        this._fields[this._fields.length - 1].showIf = {
            key: key,
            value: value
        };
        return this;
    }
    setFont(key, opts = {}) {
        return this._register({
            type: "font",
            key: key,
            label: opts.label ?? key,
            hint: opts.hint,
            default: opts.default ?? "Sans 10"
        });
    }
    setColor(key, opts = {}) {
        return this._register({
            type: "color",
            key: key,
            label: opts.label ?? key,
            hint: opts.hint,
            useAlpha: opts.useAlpha ?? false,
            default: opts.default ?? (opts.useAlpha ? "#3584e4ff" : "#3584e4")
        });
    }
    setDate(key, opts = {}) {
        return this._register({
            type: "date",
            key: key,
            label: opts.label ?? key,
            hint: opts.hint,
            default: opts.default ?? null
        });
    }
    setBoolean(key, opts = {}) {
        return this._register({
            type: "boolean",
            key: key,
            label: opts.label ?? key,
            hint: opts.hint,
            default: opts.default ?? false
        });
    }
    option(key, choices, opts = {}) {
        if (!choices || typeof choices !== "object" || Array.isArray(choices)) {
            throw new Error(`[gwc.settings] option("${key}") requires a choices object, e.g. {1: 'Compact', 2: 'Comfortable'}`);
        }
        const choiceKeys = Object.keys(choices);
        if (choiceKeys.length === 0) {
            throw new Error(`[gwc.settings] option("${key}") needs at least one choice`);
        }
        return this._register({
            type: "option",
            key: key,
            label: opts.label ?? key,
            hint: opts.hint,
            choices: choices,
            default: String(opts.default ?? choiceKeys[0])
        });
    }
    setNumber(key, opts = {}) {
        return this._register({
            type: "number",
            key: key,
            label: opts.label ?? key,
            hint: opts.hint,
            min: opts.min ?? 0,
            max: opts.max ?? 100,
            step: opts.step ?? 1,
            digits: opts.digits ?? 0,
            default: opts.default ?? (opts.min ?? 0)
        });
    }
    setRange(key, opts = {}) {
        return this._register({
            type: "range",
            key: key,
            label: opts.label ?? key,
            hint: opts.hint,
            min: opts.min ?? 0,
            max: opts.max ?? 100,
            step: opts.step ?? 1,
            digits: opts.digits ?? 0,
            default: opts.default ?? (opts.min ?? 0)
        });
    }
    setText(key, opts = {}) {
        return this._register({
            type: "text",
            key: key,
            label: opts.label ?? key,
            hint: opts.hint,
            placeholder: opts.placeholder ?? "",
            default: opts.default ?? ""
        });
    }
    setAction(key, opts = {}) {
        return this._register({
            type: "action",
            key: key,
            label: opts.label ?? key,
            hint: opts.hint,
            buttonLabel: opts.buttonLabel ?? "Run",
            destructive: opts.destructive ?? false,
            onActivate: opts.onActivate ?? (() => {})
        });
    }
    setIcon(key, opts = {}) {
        return this._register({
            type: "icon",
            key: key,
            label: opts.label ?? key,
            hint: opts.hint,
            default: opts.default ?? "image-missing-symbolic"
        });
    }
    setMultiOption(key, choices, opts = {}) {
        if (!choices || typeof choices !== "object" || Array.isArray(choices)) {
            throw new Error(`[gwc.settings] setMultiOption("${key}") requires a choices object, e.g. {1: 'Weekdays', 2: 'Weekends'}`);
        }
        if (Object.keys(choices).length === 0) {
            throw new Error(`[gwc.settings] setMultiOption("${key}") needs at least one choice`);
        }
        return this._register({
            type: "multiOption",
            key: key,
            label: opts.label ?? key,
            hint: opts.hint,
            choices: choices,
            default: opts.default ?? []
        });
    }
    build() {
        return {
            widgetId: this.widgetId,
            fields: this._fields
        };
    }
}

export function createGwcContext(widgetId) {
    return {
        settings: new WidgetSettingsSchema(widgetId)
    };
}

export function validateSchema(schema) {
    if (!schema || !Array.isArray(schema.fields)) {
        throw new Error("Invalid settings schema: missing fields[]");
    }
    for (const field of schema.fields) {
        if (!VALID_TYPES.includes(field.type)) {
            throw new Error(`Invalid settings schema: unknown field type "${field.type}"`);
        }
        if (!field.key) {
            throw new Error("Invalid settings schema: field missing key");
        }
    }
    return true;
}