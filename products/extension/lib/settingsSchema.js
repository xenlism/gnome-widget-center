// products/extension/lib/settingsSchema.js
//
// Task 05 — declarative widget settings ("Settings Schema"). Optional
// alternative to hand-writing a prefs.js: a widget can list its settings
// as a plain array in metadata.json's `settings` field instead, and the
// Control Center builds a GTK4/Adw page from it automatically (see
// settingsSchemaUI.js, prefs process only). A widget that also ships its
// own prefs.js always wins if both are present — see prefs.js's
// `_openWidgetPrefs()` for the precedence rule.
//
// Deliberately pure JS, no St/Gtk/Clutter/Adw imports: this file is
// shared by widgetLoader.js (Shell process — default-value backfilling,
// same as instance.getDefaultSettings()) AND settingsSchemaUI.js (prefs
// process — building the actual rows), so it must be safe to import from
// either, same constraint development/docs/WIDGET_API.md §4 puts on
// prefs.js itself.
//
// v1 scope is deliberately smaller than the full field-type list floated
// during design (file/folder/desktop-file/command/date/time/password/
// url/icon/font/label/separator/group) — those all need either a
// filesystem-picker dialog or extra sandboxing (command sanitization)
// that's its own chunk of work. Six types cover the common case (a
// widget with a handful of text/number/toggle/choice/color settings)
// without blocking on the rest. See development/tasks/05-prefs-control-center.md
// "Out of scope" for the full list still to add.

export const SETTING_TYPES = Object.freeze([
    'string', 'number', 'range', 'boolean', 'dropdown', 'color',
]);

/**
 * @method validateSettingsSchema
 * @description Checks a widget's `metadata.json` `settings` array for
 * structural problems, WITHOUT throwing — returns a list of human-readable
 * problem strings (empty = valid). Same "collect every problem, never
 * abort on the first one" pattern WidgetLoader.discover() already uses
 * for metadata.json's required top-level fields, so a widget author
 * fixing a broken schema sees every mistake at once instead of one at a
 * time across repeated reloads.
 * @param {Array} [schema] - metadata.settings, or undefined (no schema
 *   declared at all — perfectly valid, means "use prefs.js only, or no
 *   settings UI at all").
 * @returns {string[]} problems, each prefixed with the offending
 *   setting's `id` (or its index if `id` itself is missing/invalid).
 */
export function validateSettingsSchema(schema) {
    if (schema === undefined)
        return [];

    if (!Array.isArray(schema))
        return ['"settings" must be an array'];

    const problems = [];
    const seenIds = new Set();

    schema.forEach((field, index) => {
        const label = typeof field?.id === 'string' && field.id.length > 0 ? field.id : `#${index}`;

        if (typeof field?.id !== 'string' || field.id.length === 0) {
            problems.push(`setting ${label}: missing required "id"`);
            return; // every other check below assumes a usable id
        }
        if (seenIds.has(field.id)) {
            problems.push(`setting "${field.id}": duplicate id`);
            return;
        }
        seenIds.add(field.id);

        if (!SETTING_TYPES.includes(field.type)) {
            problems.push(`setting "${field.id}": type "${field.type}" is not one of ${SETTING_TYPES.join(', ')}`);
            return; // type-specific checks below don't apply to an unknown type
        }
        if (typeof field.label !== 'string' || field.label.length === 0)
            problems.push(`setting "${field.id}": missing required "label"`);
        if (!('default' in field))
            problems.push(`setting "${field.id}": missing required "default"`);

        if (field.type === 'range') {
            if (typeof field.min !== 'number' || typeof field.max !== 'number')
                problems.push(`setting "${field.id}": type "range" requires numeric "min" and "max"`);
            else if (field.min >= field.max)
                problems.push(`setting "${field.id}": "min" must be less than "max"`);
            else if (typeof field.default === 'number' && (field.default < field.min || field.default > field.max))
                problems.push(`setting "${field.id}": "default" (${field.default}) is outside the min/max range`);
        }

        if (field.type === 'dropdown' && (!Array.isArray(field.options) || field.options.length === 0))
            problems.push(`setting "${field.id}": type "dropdown" requires a non-empty "options" array`);
    });

    return problems;
}

/**
 * @method getSchemaDefaults
 * @description Extracts `{id: default}` for every entry in a settings
 * schema — merged into a widget's defaults in widgetLoader.js's
 * loadOne()/reloadWidget() the same way `instance.getDefaultSettings()`
 * already is. Entries that would fail validateSettingsSchema() are
 * silently skipped here rather than throwing — WidgetLoader.discover()
 * is what rejects an invalid schema (recorded as a widget-level error,
 * same as a broken metadata.json), so a widget with a bad schema never
 * reaches loadOne() in the first place and this function doesn't need to
 * re-report the same problem.
 * @param {Array} [schema]
 * @returns {Object}
 */
export function getSchemaDefaults(schema) {
    if (!Array.isArray(schema))
        return {};

    const defaults = {};
    for (const field of schema) {
        if (typeof field?.id === 'string' && field.id.length > 0 && 'default' in field)
            defaults[field.id] = field.default;
    }
    return defaults;
}
