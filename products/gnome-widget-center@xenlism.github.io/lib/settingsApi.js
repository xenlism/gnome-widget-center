/**
 * lib/settingsApi.js
 *
 * Declarative settings schema builder for gnome-widget-center widgets.
 *
 * A widget declares its configurable options once, in its own
 * `settings.js` file, using a fluent builder passed in as `gwc.settings`:
 *
 *   export function defineSettings(gwc) {
 *       gwc.settings
 *           .group('Appearance')
 *           .setFont('fontFamily', { label: 'Font', default: 'Cantarell 11' })
 *           .setColor('accentColor', { label: 'Accent Color', default: '#3584e4' })
 *           .option('layout', { 1: 'Compact', 2: 'Comfortable', 3: 'Custom' }, {
 *               label: 'Layout',
 *               default: 1,
 *           })
 *           .setRange('customSpacing', { label: 'Spacing', min: 0, max: 32, default: 8 })
 *           .showIf('layout', '3')
 *
 *           .group('Behavior')
 *           .setBoolean('showHeader', { label: 'Show Header', default: true })
 *           .setDate('startDate', { label: 'Start Date' })
 *           .setText('customLabel', { label: 'Custom Label', placeholder: 'My Widget' })
 *           .setMultiOption('activeDays', { 1: 'Mon', 2: 'Tue', 3: 'Wed' }, { label: 'Active Days' })
 *           .setAction('resetCache', {
 *               label: 'Cache',
 *               buttonLabel: 'Clear Cache',
 *               destructive: true,
 *               onActivate: (store) => store.setMany({ startDate: null }),
 *           });
 *   }
 *
 * The engine (settingsRegistry) calls `defineSettings(gwc)` once per widget
 * with a fresh builder bound to that widget's id, then hands the resulting
 * schema to settingsRenderer.js to build actual GTK4/libadwaita rows, and to
 * settingsStore.js to persist values.
 *
 * This file has NO GTK/Adw imports on purpose — it's pure data, so it can be
 * safely imported both from prefs.js (GTK4 process) and from unit tests.
 */

'use strict';

const VALID_TYPES = [
    'font', 'color', 'date', 'boolean', 'option',
    'number', 'range', 'text', 'action', 'icon', 'multiOption',
];

/**
 * @typedef {Object} SettingField
 * @property {string} type - one of VALID_TYPES
 * @property {string} key - unique key within the widget, used for storage
 * @property {string} label - human-readable label shown in prefs UI
 * @property {*} default - default value
 * @property {Object} [choices] - for 'option'/'multiOption': { value: label, ... }
 * @property {boolean} [useAlpha] - only for 'color' type
 * @property {number} [min] - only for 'number'/'range'
 * @property {number} [max] - only for 'number'/'range'
 * @property {number} [step] - only for 'number'/'range'
 * @property {number} [digits] - only for 'number'/'range'
 * @property {string} [placeholder] - only for 'text'
 * @property {string} [buttonLabel] - only for 'action'
 * @property {boolean} [destructive] - only for 'action'
 * @property {(store: Object) => void} [onActivate] - only for 'action'
 * @property {(string|null)} [group] - section header this field is placed under
 * @property {{key: string, value: *}} [showIf] - only visible when field `key` equals `value`
 * @property {string} [hint] - optional secondary/subtitle text in the UI
 */

class WidgetSettingsSchema {
    /**
     * @param {string} widgetId - unique widget identifier, e.g. 'clock-widget'
     */
    constructor(widgetId) {
        if (!widgetId) {
            throw new Error('WidgetSettingsSchema requires a widgetId');
        }
        this.widgetId = widgetId;
        /** @type {SettingField[]} */
        this._fields = [];
        this._keys = new Set();
        this._currentGroup = null;
    }

    _register(field) {
        if (this._keys.has(field.key)) {
            throw new Error(
                `[gwc.settings] Duplicate setting key "${field.key}" in widget "${this.widgetId}"`
            );
        }
        this._keys.add(field.key);
        field.group = this._currentGroup;
        this._fields.push(field);
        return this;
    }

    /**
     * Sets the section header that subsequent setXxx() calls will be
     * placed under, until group() is called again with a different title.
     * Fields declared before the first group() call have no group and
     * fall back to the widget's own title.
     * @param {string} title
     */
    group(title) {
        this._currentGroup = title;
        return this;
    }

    /**
     * Makes the field just declared conditionally visible, based on the
     * current value of another field in the same widget. Must be chained
     * directly after the setXxx()/option() call it applies to.
     *
     *   gwc.settings
     *       .option('layout', {1: 'Compact', 2: 'Custom'}, { default: 1 })
     *       .setColor('customColor', { label: 'Custom Color' })
     *       .showIf('layout', '2');
     *
     * @param {string} key - the controlling field's key
     * @param {*} value - the value of `key` that makes this field visible
     */
    showIf(key, value) {
        if (this._fields.length === 0) {
            throw new Error(
                '[gwc.settings] showIf() must be chained right after a setXxx()/option() call'
            );
        }
        this._fields[this._fields.length - 1].showIf = { key, value };
        return this;
    }

    /**
     * Font picker setting.
     * @param {string} key
     * @param {{label?: string, default?: string, hint?: string}} [opts]
     */
    setFont(key, opts = {}) {
        return this._register({
            type: 'font',
            key,
            label: opts.label ?? key,
            hint: opts.hint,
            default: opts.default ?? 'Sans 10',
        });
    }

    /**
     * Color picker setting. Stored as an 8-digit hex string (#RRGGBBAA)
     * when useAlpha is true, otherwise 6-digit (#RRGGBB).
     * @param {string} key
     * @param {{label?: string, default?: string, useAlpha?: boolean, hint?: string}} [opts]
     */
    setColor(key, opts = {}) {
        return this._register({
            type: 'color',
            key,
            label: opts.label ?? key,
            hint: opts.hint,
            useAlpha: opts.useAlpha ?? false,
            default: opts.default ?? (opts.useAlpha ? '#3584e4ff' : '#3584e4'),
        });
    }

    /**
     * Date picker setting. Value is stored/returned as an ISO date string
     * ('YYYY-MM-DD') or null if unset.
     * @param {string} key
     * @param {{label?: string, default?: (string|null), hint?: string}} [opts]
     */
    setDate(key, opts = {}) {
        return this._register({
            type: 'date',
            key,
            label: opts.label ?? key,
            hint: opts.hint,
            default: opts.default ?? null,
        });
    }

    /**
     * Boolean toggle setting.
     * @param {string} key
     * @param {{label?: string, default?: boolean, hint?: string}} [opts]
     */
    setBoolean(key, opts = {}) {
        return this._register({
            type: 'boolean',
            key,
            label: opts.label ?? key,
            hint: opts.hint,
            default: opts.default ?? false,
        });
    }

    /**
     * Dropdown setting.
     * @param {string} key
     * @param {Object.<string,string>} choices - { value: displayLabel, ... }
     * @param {{label?: string, default?: string, hint?: string}} [opts]
     */
    option(key, choices, opts = {}) {
        if (!choices || typeof choices !== 'object' || Array.isArray(choices)) {
            throw new Error(
                `[gwc.settings] option("${key}") requires a choices object, e.g. {1: 'Compact', 2: 'Comfortable'}`
            );
        }
        const choiceKeys = Object.keys(choices);
        if (choiceKeys.length === 0) {
            throw new Error(`[gwc.settings] option("${key}") needs at least one choice`);
        }
        return this._register({
            type: 'option',
            key,
            label: opts.label ?? key,
            hint: opts.hint,
            choices,
            default: String(opts.default ?? choiceKeys[0]),
        });
    }

    /**
     * Precise numeric input with steppers (spin button).
     * @param {string} key
     * @param {{label?: string, default?: number, min?: number, max?: number, step?: number, digits?: number, hint?: string}} [opts]
     */
    setNumber(key, opts = {}) {
        return this._register({
            type: 'number',
            key,
            label: opts.label ?? key,
            hint: opts.hint,
            min: opts.min ?? 0,
            max: opts.max ?? 100,
            step: opts.step ?? 1,
            digits: opts.digits ?? 0,
            default: opts.default ?? (opts.min ?? 0),
        });
    }

    /**
     * Slider input — same numeric shape as setNumber, different widget.
     * Prefer this for "feel"-based values (opacity, volume); prefer
     * setNumber for values people type an exact number into.
     * @param {string} key
     * @param {{label?: string, default?: number, min?: number, max?: number, step?: number, digits?: number, hint?: string}} [opts]
     */
    setRange(key, opts = {}) {
        return this._register({
            type: 'range',
            key,
            label: opts.label ?? key,
            hint: opts.hint,
            min: opts.min ?? 0,
            max: opts.max ?? 100,
            step: opts.step ?? 1,
            digits: opts.digits ?? 0,
            default: opts.default ?? (opts.min ?? 0),
        });
    }

    /**
     * Free-text input, e.g. a custom label, URL, or endpoint.
     * @param {string} key
     * @param {{label?: string, default?: string, placeholder?: string, hint?: string}} [opts]
     */
    setText(key, opts = {}) {
        return this._register({
            type: 'text',
            key,
            label: opts.label ?? key,
            hint: opts.hint,
            placeholder: opts.placeholder ?? '',
            default: opts.default ?? '',
        });
    }

    /**
     * A button that triggers a one-off action rather than storing a
     * value — e.g. "Sync now", "Clear cache", "Reset to defaults".
     * @param {string} key - identifier only; nothing is persisted for this key
     * @param {{label?: string, buttonLabel?: string, destructive?: boolean, onActivate?: (store: Object) => void, hint?: string}} [opts]
     */
    setAction(key, opts = {}) {
        return this._register({
            type: 'action',
            key,
            label: opts.label ?? key,
            hint: opts.hint,
            buttonLabel: opts.buttonLabel ?? 'Run',
            destructive: opts.destructive ?? false,
            onActivate: opts.onActivate ?? (() => {}),
        });
    }

    /**
     * Icon-name setting with a live preview. Works well with reverse-DNS
     * icon names (e.g. from the wildfire symlink script).
     * @param {string} key
     * @param {{label?: string, default?: string, hint?: string}} [opts]
     */
    setIcon(key, opts = {}) {
        return this._register({
            type: 'icon',
            key,
            label: opts.label ?? key,
            hint: opts.hint,
            default: opts.default ?? 'image-missing-symbolic',
        });
    }

    /**
     * Multi-select checklist. Value is stored as an array of the selected
     * choice keys (not a single value like option()).
     * @param {string} key
     * @param {Object.<string,string>} choices - { value: displayLabel, ... }
     * @param {{label?: string, default?: string[], hint?: string}} [opts]
     */
    setMultiOption(key, choices, opts = {}) {
        if (!choices || typeof choices !== 'object' || Array.isArray(choices)) {
            throw new Error(
                `[gwc.settings] setMultiOption("${key}") requires a choices object, e.g. {1: 'Weekdays', 2: 'Weekends'}`
            );
        }
        if (Object.keys(choices).length === 0) {
            throw new Error(`[gwc.settings] setMultiOption("${key}") needs at least one choice`);
        }
        return this._register({
            type: 'multiOption',
            key,
            label: opts.label ?? key,
            hint: opts.hint,
            choices,
            default: opts.default ?? [],
        });
    }

    /** Finalize and return the plain schema object. */
    build() {
        return {
            widgetId: this.widgetId,
            fields: this._fields,
        };
    }
}

/**
 * Creates a fresh `gwc`-shaped object exposing `.settings` bound to one
 * widget id. Pass this into a widget's `defineSettings(gwc)` export.
 *
 * @param {string} widgetId
 * @returns {{settings: WidgetSettingsSchema}}
 */
function createGwcContext(widgetId) {
    return { settings: new WidgetSettingsSchema(widgetId) };
}

/**
 * Validates a raw schema object (defensive check, e.g. after JSON round-trip
 * or when loading third-party widgets).
 * @param {*} schema
 */
function validateSchema(schema) {
    if (!schema || !Array.isArray(schema.fields)) {
        throw new Error('Invalid settings schema: missing fields[]');
    }
    for (const field of schema.fields) {
        if (!VALID_TYPES.includes(field.type)) {
            throw new Error(`Invalid settings schema: unknown field type "${field.type}"`);
        }
        if (!field.key) {
            throw new Error('Invalid settings schema: field missing key');
        }
    }
    return true;
}

var GwcSettingsApi = {
    WidgetSettingsSchema,
    createGwcContext,
    validateSchema,
    VALID_TYPES,
};
