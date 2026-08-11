import Adw from "gi://Adw";

import GLib from "gi://GLib";

import { pickTranslation } from "./i18nUtils.js";

import { _textRow, _locationRow, _textareaRow, _passwordRow, _switchRow, _checkboxRow, _dropdownRow, _spinRow, _sliderRow, _colorRow, _fontRow, _iconRow, _pathRow, _listRow, _objectRow, _autocompleteRow } from "./widgetConfigFieldRows.js";

export function buildConfigPage(config, settingsProxy, title, widgetPath, translations = {}) {
    const tr = (key, fallback) => pickTranslation(translations, key, fallback);
    const page = new Adw.PreferencesPage({
        title: title
    });
    const multiTab = config.tabs.length > 1;
    const dependents = new Map;
    const conditions = new Map;
    const notifyChange = () => _reevaluateAll(conditions, dependents, settingsProxy);
    let autocompleteModulePromise = null;
    const rowUpdaters = new Map;
    const autocompleteCtx = {
        loadAutocompleteFn(fnName) {
            if (!widgetPath) {
                return Promise.reject(new Error("buildConfigPage() was not given a widgetPath - cannot load autocomplete.js"));
            }
            if (!autocompleteModulePromise) {
                const entryPath = GLib.build_filenamev([ widgetPath, "autocomplete.js" ]);
                autocompleteModulePromise = import(`file://${entryPath}`);
            }
            return autocompleteModulePromise.then(module => {
                const fn = module[fnName];
                if (typeof fn !== "function") throw new Error(`autocomplete.js has no exported function "${fnName}"`);
                return fn;
            });
        },
        fillSibling(fieldId, value) {
            settingsProxy[fieldId] = value;
            notifyChange();
            rowUpdaters.get(fieldId)?.(value);
        },
        registerRow(fieldId, updater) {
            rowUpdaters.set(fieldId, updater);
        }
    };
    const escapeMarkup = text => GLib.markup_escape_text(String(text ?? ""), -1);
    for (const tab of config.tabs) {
        const tabLabel = escapeMarkup(tr(`tab.${tab.id}.label`, tab.label));
        for (const group of tab.groups) {
            const groupLabel = escapeMarkup(tr(`group.${group.id}.label`, group.label));
            const groupDescription = escapeMarkup(tr(`group.${group.id}.description`, group.description || ""));
            const adwGroup = new Adw.PreferencesGroup({
                title: multiTab ? `${tabLabel} — ${groupLabel}` : groupLabel,
                description: groupDescription
            });
            page.add(adwGroup);
            for (const field of group.fields) {
                const translatedField = {
                    ...field,
                    label: tr(`field.${field.id}.label`, field.label),
                    description: tr(`field.${field.id}.description`, field.description || ""),
                    options: field.options?.map(opt => ({
                        ...opt,
                        label: tr(`field.${field.id}.option.${opt.value}`, opt.label)
                    }))
                };
                let row;
                try {
                    row = _buildRow(translatedField, settingsProxy, notifyChange, autocompleteCtx);
                } catch (e) {
                    console.error(`[widget-center] failed to build row for field "${field.id}"`, e);
                    row = new Adw.ActionRow({
                        title: GLib.markup_escape_text(String(field.id ?? "field"), -1),
                        subtitle: "Could not display this setting - see logs."
                    });
                }
                adwGroup.add(row);
                if (field.visibleIf || field.enabledIf || field.dependsOn) {
                    conditions.set(field.id, {
                        row: row,
                        field: field
                    });
                    for (const dep of _extractDependencyIds(field)) _addDependent(dependents, dep, field.id);
                }
            }
        }
    }
    _reevaluateAll(conditions, dependents, settingsProxy);
    return page;
}

function _extractDependencyIds(field) {
    const ids = new Set;
    for (const expr of [ field.visibleIf, field.enabledIf, field.dependsOn ]) {
        if (typeof expr !== "string") continue;
        for (const m of expr.matchAll(/[A-Za-z_][\w.]*/g)) ids.add(m[0]);
    }
    return ids;
}

function _addDependent(dependents, depId, fieldId) {
    if (!dependents.has(depId)) dependents.set(depId, new Set);
    dependents.get(depId).add(fieldId);
}

function _reevaluateAll(conditions, dependents, settingsProxy) {
    for (const {row: row, field: field} of conditions.values()) _applyConditions(row, field, settingsProxy);
}

function _applyConditions(row, field, settingsProxy) {
    if (field.visibleIf !== undefined) row.visible = _evaluateCondition(field.visibleIf, settingsProxy);
    if (field.enabledIf !== undefined) row.sensitive = _evaluateCondition(field.enabledIf, settingsProxy);
    if (field.dependsOn !== undefined && field.enabledIf === undefined) row.sensitive = _evaluateCondition(field.dependsOn, settingsProxy);
}

function _evaluateCondition(expr, settingsProxy) {
    if (!expr) return true;
    return expr.split("||").some(orPart => orPart.split("&&").every(andPart => _evaluateSingle(andPart.trim(), settingsProxy)));
}

function _evaluateSingle(cond, settingsProxy) {
    let negate = false;
    if (cond.startsWith("!")) {
        negate = true;
        cond = cond.slice(1).trim();
    }
    const match = cond.match(/^([\w.]+)\s*(==|!=)\s*(.+)$/);
    let result;
    if (match) {
        const [, key, op, rawValue] = match;
        const actual = settingsProxy[key];
        const expected = _parseLiteral(rawValue.trim());
        const eq = actual === expected || String(actual) === String(expected);
        result = op === "==" ? eq : !eq;
    } else {
        result = Boolean(settingsProxy[cond]);
    }
    return negate ? !result : result;
}

function _parseLiteral(raw) {
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    const quoted = raw.match(/^['"](.*)['"]$/);
    return quoted ? quoted[1] : raw;
}

function _buildRow(field, settingsProxy, notifyChange, autocompleteCtx) {
    const current = field.id in settingsProxy ? settingsProxy[field.id] : field.default;
    const set = value => {
        settingsProxy[field.id] = value;
        notifyChange();
    };
    switch (field.fieldType) {
      case "text":
        return _textRow(field, current, set);

      case "location":
        return _locationRow(field, current, set);

      case "textarea":
        return _textareaRow(field, current, set);

      case "password":
        return _passwordRow(field, current, set);

      case "switch":
        return _switchRow(field, current, set);

      case "checkbox":
        return _checkboxRow(field, current, set);

      case "dropdown":
      case "radio":
        return _dropdownRow(field, current, set);

      case "spinbutton":
        return _spinRow(field, current, set);

      case "slider":
        return _sliderRow(field, current, set);

      case "colorpicker":
        return _colorRow(field, current, set);

      case "fontpicker":
        return _fontRow(field, current, set);

      case "iconpicker":
        return _iconRow(field, current, set);

      case "filepicker":
        return _pathRow(field, current, set, {
            folder: false
        });

      case "folderpicker":
        return _pathRow(field, current, set, {
            folder: true
        });

      case "list":
        return _listRow(field, current, set);

      case "object":
        return _objectRow(field, current, set);

      case "autocomplete":
        return _autocompleteRow(field, current, set, autocompleteCtx);

      default:
        return new Adw.ActionRow({
            title: GLib.markup_escape_text(String(field.label ?? field.id ?? ""), -1),
            subtitle: `Unknown fieldType "${field.fieldType}"`,
            sensitive: false
        });
    }
}