// products/extension/lib/widgetConfigValidator.js
//
// Validates a widget's config.json against the tabs/groups/fields spec
// (see development/docs/WIDGET_API.md §6.4). Pure JS, no `gi://` imports —
// safe to load in both the Shell (extension.js) and Prefs processes.
//
// A widget with an invalid config.json fails closed exactly like a
// malformed metadata.json `settings` array does today (WidgetLoader
// excludes it and files the reasons in `errors` instead of throwing) —
// see widgetConfigReader.js, which calls validateConfig() before ever
// handing a config back to a caller.

const DATA_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'list', 'object']);

const FIELD_TYPES = new Set([
    'text', 'location', 'textarea', 'password',
    'switch', 'checkbox', 'dropdown', 'radio',
    'spinbutton', 'slider',
    'colorpicker', 'fontpicker', 'iconpicker', 'filepicker', 'folderpicker',
    'list', 'object', 'autocomplete',
]);

const FORMATS = new Set([
    'email', 'url', 'hostname', 'ip', 'ipv4', 'ipv6', 'mac', 'uuid',
    'color', 'font', 'icon', 'file', 'folder', 'date', 'time', 'datetime',
    // 'app' is an ITEM-level format only (field.item.format inside a
    // fieldType:"list" field — see widgetConfigUI.js's _listRow()), never
    // field.format on the field itself. Marks a string list whose items
    // are installed .desktop application entries (e.g. a browser-chooser
    // list), so the "+" control browses/scans a directory instead of a
    // plain text entry. Deliberately NOT a separate field type — it's a
    // format hint on an ordinary `dataType: "string"` list item.
    'app',
]);

/**
 * @param {object} config - parsed config.json contents
 * @returns {Array<{message: string}>} empty array = valid
 */
export function validateConfig(config) {
    const errors = [];

    if (!config || typeof config !== 'object') {
        return [{message: 'config is not a valid object'}];
    }

    if (typeof config.version !== 'string') {
        errors.push({message: 'Missing or invalid "version" (must be string)'});
    }

    if (!Array.isArray(config.tabs)) {
        errors.push({message: 'Missing or invalid "tabs" (must be array)'});
        return errors;
    }

    if (config.tabs.length === 0) {
        errors.push({message: '"tabs" array is empty'});
        return errors;
    }

    const tabIds = new Set();
    config.tabs.forEach((tab, tabIndex) => {
        const tabPath = `tabs[${tabIndex}]`;

        if (typeof tab.id !== 'string' || !tab.id) {
            errors.push({message: `${tabPath}: missing or invalid "id"`});
        } else if (tabIds.has(tab.id)) {
            errors.push({message: `${tabPath}: duplicate tab id "${tab.id}"`});
        } else {
            tabIds.add(tab.id);
        }

        if (typeof tab.label !== 'string')
            errors.push({message: `${tabPath}: missing or invalid "label"`});

        if (typeof tab.description !== 'string')
            errors.push({message: `${tabPath}: missing or invalid "description"`});

        if (!Array.isArray(tab.groups)) {
            errors.push({message: `${tabPath}: missing or invalid "groups" (must be array)`});
            return;
        }

        const groupIds = new Set();
        tab.groups.forEach((group, groupIndex) => {
            const groupPath = `${tabPath}.groups[${groupIndex}]`;

            if (typeof group.id !== 'string' || !group.id) {
                errors.push({message: `${groupPath}: missing or invalid "id"`});
            } else if (groupIds.has(group.id)) {
                errors.push({message: `${groupPath}: duplicate group id "${group.id}"`});
            } else {
                groupIds.add(group.id);
            }

            if (typeof group.label !== 'string')
                errors.push({message: `${groupPath}: missing or invalid "label"`});

            if (!Array.isArray(group.fields)) {
                errors.push({message: `${groupPath}: missing or invalid "fields" (must be array)`});
                return;
            }

            const fieldIds = new Set();
            group.fields.forEach((field, fieldIndex) => {
                validateField(field, `${groupPath}.fields[${fieldIndex}]`, fieldIds, errors);
            });
        });
    });

    return errors;
}

/** @private shared by top-level fields and nested `object`/`list.item` fields. */
function validateField(field, fieldPath, siblingIds, errors) {
    if (!field || typeof field !== 'object') {
        errors.push({message: `${fieldPath}: not a valid object`});
        return;
    }

    if (typeof field.id !== 'string' || !field.id) {
        errors.push({message: `${fieldPath}: missing or invalid "id"`});
    } else if (siblingIds.has(field.id)) {
        errors.push({message: `${fieldPath}: duplicate field id "${field.id}"`});
    } else {
        siblingIds.add(field.id);
    }

    if (typeof field.label !== 'string')
        errors.push({message: `${fieldPath}: missing or invalid "label"`});

    if (typeof field.description !== 'string')
        errors.push({message: `${fieldPath}: missing or invalid "description"`});

    if (!DATA_TYPES.has(field.dataType))
        errors.push({message: `${fieldPath}: invalid "dataType" "${field.dataType}"`});

    if (!FIELD_TYPES.has(field.fieldType))
        errors.push({message: `${fieldPath}: invalid "fieldType" "${field.fieldType}"`});

    if (!('default' in field))
        errors.push({message: `${fieldPath}: missing "default"`});

    if (field.format !== undefined && !FORMATS.has(field.format))
        errors.push({message: `${fieldPath}: invalid "format" "${field.format}"`});

    // Type-specific structural checks.
    if ((field.fieldType === 'dropdown' || field.fieldType === 'radio')) {
        if (!Array.isArray(field.options) || field.options.length === 0)
            errors.push({message: `${fieldPath}: "${field.fieldType}" requires a non-empty "options" array`});
    }

    // "autocomplete" - see development/docs/WIDGET_API.md §6.4's Autocomplete
    // Field section (Handover.md's design): the field only names WHICH
    // exported function in the widget's own autocomplete.js to call, all
    // business logic (the actual search) lives in that function, not here.
    if (field.fieldType === 'autocomplete') {
        if (typeof field.autocomplete !== 'string' || !field.autocomplete)
            errors.push({message: `${fieldPath}: "autocomplete" requires a non-empty "autocomplete" (function name) string`});
        if (field.fillsField !== undefined && (typeof field.fillsField !== 'string' || !field.fillsField))
            errors.push({message: `${fieldPath}: "fillsField" must be a non-empty string when present`});
    }

    if ((field.fieldType === 'spinbutton' || field.fieldType === 'slider')) {
        if (field.min !== undefined && typeof field.min !== 'number')
            errors.push({message: `${fieldPath}: "min" must be a number`});
        if (field.max !== undefined && typeof field.max !== 'number')
            errors.push({message: `${fieldPath}: "max" must be a number`});
        if (field.min !== undefined && field.max !== undefined && field.min > field.max)
            errors.push({message: `${fieldPath}: "min" must be <= "max"`});
    }

    if (field.fieldType === 'list') {
        if (!field.item || typeof field.item !== 'object') {
            errors.push({message: `${fieldPath}: "list" requires an "item" schema`});
        } else {
            if (field.item.dataType !== undefined && !DATA_TYPES.has(field.item.dataType))
                errors.push({message: `${fieldPath}.item: invalid "dataType" "${field.item.dataType}"`});
            if (field.item.fieldType !== undefined && !FIELD_TYPES.has(field.item.fieldType))
                errors.push({message: `${fieldPath}.item: invalid "fieldType" "${field.item.fieldType}"`});
            if (field.item.dataType === 'object') {
                if (!field.item.properties || typeof field.item.properties !== 'object')
                    errors.push({message: `${fieldPath}.item: object item requires "properties"`});
            }
            if ((field.item.fieldType === 'dropdown' || field.item.fieldType === 'radio') &&
                (!Array.isArray(field.item.options) || field.item.options.length === 0))
                errors.push({message: `${fieldPath}.item: "${field.item.fieldType}" requires a non-empty "options" array`});
            if (field.item.format === 'app' && field.item.dataType !== 'string')
                errors.push({message: `${fieldPath}.item: format "app" requires dataType "string" (stores a .desktop path)`});
        }
        if (field.minItems !== undefined && field.maxItems !== undefined && field.minItems > field.maxItems)
            errors.push({message: `${fieldPath}: "minItems" must be <= "maxItems"`});
    }

    if (field.fieldType === 'object') {
        if (!field.properties || typeof field.properties !== 'object') {
            errors.push({message: `${fieldPath}: "object" requires a "properties" map`});
        } else {
            const nestedIds = new Set();
            Object.entries(field.properties).forEach(([propKey, propField]) => {
                validateField(propField, `${fieldPath}.properties.${propKey}`, nestedIds, errors);
            });
        }
    }

    if (field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength)
        errors.push({message: `${fieldPath}: "minLength" must be <= "maxLength"`});

    if (field.pattern !== undefined) {
        try {
            // eslint-disable-next-line no-new
            new RegExp(field.pattern);
        } catch (e) {
            errors.push({message: `${fieldPath}: invalid "pattern" regex - ${e.message}`});
        }
    }
}

/**
 * Walks a valid config and returns a flat {fieldId: default} map — used to
 * backfill settings the same way getSchemaDefaults() does for the flat
 * `settings` array (see settingsSchema.js). Only call this on a config
 * that already passed validateConfig() with zero errors.
 * @param {object} config
 * @returns {object}
 */
export function getConfigDefaults(config) {
    const defaults = {};
    if (!config || !Array.isArray(config.tabs))
        return defaults;

    const collect = fields => {
        for (const field of fields ?? []) {
            if (field.fieldType === 'object' && field.properties) {
                const nested = {};
                for (const [key, propField] of Object.entries(field.properties))
                    nested[key] = propField.default;
                defaults[field.id] = field.default ?? nested;
            } else {
                defaults[field.id] = field.default;
            }
        }
    };

    for (const tab of config.tabs) {
        for (const group of tab.groups ?? [])
            collect(group.fields);
    }

    return defaults;
}
