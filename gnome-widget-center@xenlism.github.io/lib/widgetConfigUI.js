// products/extension/lib/widgetConfigUI.js
//
// Builds an Adw.PreferencesPage from a widget's config.json (tabs/groups/
// fields — see development/docs/WIDGET_API.md §6.4 and
// widgetConfigValidator.js for the format this consumes). This is the
// config.json equivalent of settingsSchemaUI.js's buildSettingsPage() for
// the older flat `settings` array, and follows the same conventions:
//
//   - Prefs process ONLY (imports Adw/Gtk/Gdk) — never import this
//     from widgetLoader.js or extension.js (development/docs/WIDGET_API.md §4).
//   - Every row writes straight through to the settings proxy on change,
//     same debounced auto-save every other settings path already uses
//     (widgetSettings.js) — no separate "Save" step.
//   - Assumes its input already passed validateConfig() with zero errors
//     (widgetConfigReader.js only ever hands back a config that did) —
//     does not re-validate.
//
// config.json's `tabs` are flattened into Adw.PreferencesGroups rather
// than real GTK notebook tabs: prefs.js's _presentPrefsPage() calls a
// single `.add(actionsGroup)` on whatever this returns, so the return
// value has to stay a plain Adw.PreferencesPage, the same contract a
// hand-written prefs.js's buildPrefsWidget() already follows. A group's
// title becomes "Tab Label — Group Label" when a widget declares more
// than one tab, or just "Group Label" for the (common) single-tab case.
//
// The actual per-fieldType row builders (_textRow, _colorRow, _listRow,
// ...) that _buildRow() below dispatches to live in
// widgetConfigFieldRows.js (split out 2026-08-01 — this file was ~1470
// lines and mixed two concerns: building the page/handling visibleIf
// conditions, vs. rendering one specific field type. Nothing about the
// page-building contract above changed, only where the code lives).

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import {pickTranslation} from './i18nUtils.js';
import {
    _textRow, _locationRow, _textareaRow, _passwordRow, _switchRow,
    _checkboxRow, _dropdownRow, _spinRow, _sliderRow, _colorRow,
    _fontRow, _iconRow, _pathRow, _listRow, _objectRow, _autocompleteRow,
} from './widgetConfigFieldRows.js';

/**
 * @param {object} config - a widget's parsed + validated config.json
 * @param {object} settingsProxy - from WidgetSettings.load(), already
 *   defaulted (see buildSettingsPage()'s equivalent parameter).
 * @param {string} title - the widget's display name, used as page title.
 * @param {string} [widgetPath] - the widget's own folder on disk (same
 *   value a widget.js sees as `api.path.me`, see widgetLoader.js). Only
 *   needed if the config declares any `fieldType: "autocomplete"` field —
 *   it's where that field's `autocomplete.js` is dynamically imported
 *   from (Handover.md's Autocomplete Field design). Safe to omit for a
 *   config with no autocomplete fields.
 * @param {Object} [translations] - this widget's i18n table for the
 *   currently-selected locale (from i18n/index.js's loadTranslations() —
 *   see prefs.js's caller for where this gets resolved before
 *   buildConfigPage() is invoked, since the dynamic import() that loads
 *   it is async and everything in here is built synchronously). Keys are
 *   "tab.<id>.label", "group.<id>.label", "field.<id>.label",
 *   "field.<id>.description", "field.<id>.option.<value>", etc., 1:1
 *   with config.json's own ids — see gen/generate_i18n.py's
 *   collect_widget_keys(). Missing keys (locale file doesn't cover a
 *   string yet, or no i18n/ folder at all) silently fall back to
 *   config.json's own English text — this param is entirely optional.
 * @returns {Adw.PreferencesPage}
 */
export function buildConfigPage(config, settingsProxy, title, widgetPath, translations = {}) {
    const tr = (key, fallback) => pickTranslation(translations, key, fallback);

    const page = new Adw.PreferencesPage({title});
    const multiTab = config.tabs.length > 1;

    // fieldId -> [{row, field}] — every row that declared a visibleIf/
    // enabledIf/dependsOn condition naming that fieldId, so a change to
    // one field can re-evaluate just the rows that actually depend on it
    // (see _rebuildDependencyIndex() / _reevaluate() below).
    const dependents = new Map();
    // fieldId -> the condition string(s) to re-check for that row.
    const conditions = new Map();

    const notifyChange = () => _reevaluateAll(conditions, dependents, settingsProxy);

    // Autocomplete-field support (Handover.md): one shared dynamic import
    // of the widget's own autocomplete.js (cached so every autocomplete
    // field in this config reuses the same module instance instead of
    // re-importing per keystroke), plus a small cross-field registry so
    // selecting a suggestion in one field (e.g. "place") can also update a
    // sibling field's stored value AND its on-screen text (e.g.
    // "location") — see _autocompleteRow()'s `item.fields` handling below.
    let autocompleteModulePromise = null;
    const rowUpdaters = new Map(); // fieldId -> (value) => void, set by _autocompleteRow
    const autocompleteCtx = {
        loadAutocompleteFn(fnName) {
            if (!widgetPath) {
                return Promise.reject(new Error(
                    'buildConfigPage() was not given a widgetPath - cannot load autocomplete.js'));
            }
            if (!autocompleteModulePromise) {
                const entryPath = GLib.build_filenamev([widgetPath, 'autocomplete.js']);
                autocompleteModulePromise = import(`file://${entryPath}`);
            }
            return autocompleteModulePromise.then(module => {
                const fn = module[fnName];
                if (typeof fn !== 'function')
                    throw new Error(`autocomplete.js has no exported function "${fnName}"`);
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
        },
    };

    // GLib.markup_escape_text() every user/config-supplied string that
    // ends up as an Adw widget `title`/`description` below - libadwaita
    // parses those as Pango markup, so a raw "&" or "<" in a widget's
    // own config.json label/description (e.g. "Border & Opacity", "Low
    // battery color (< 20%)") throws a markup parse error at render
    // time instead of just displaying literally (2026-08-09, handover
    // v3 crash report - `journalctl` showed exactly these two strings
    // failing, with "Lost connection to Wayland compositor" alongside).
    const escapeMarkup = text => GLib.markup_escape_text(String(text ?? ''), -1);

    for (const tab of config.tabs) {
        const tabLabel = escapeMarkup(tr(`tab.${tab.id}.label`, tab.label));

        for (const group of tab.groups) {
            const groupLabel = escapeMarkup(tr(`group.${group.id}.label`, group.label));
            const groupDescription = escapeMarkup(tr(`group.${group.id}.description`, group.description || ''));

            const adwGroup = new Adw.PreferencesGroup({
                title: multiTab ? `${tabLabel} — ${groupLabel}` : groupLabel,
                description: groupDescription,
            });
            page.add(adwGroup);

            for (const field of group.fields) {
                const translatedField = {
                    ...field,
                    label: tr(`field.${field.id}.label`, field.label),
                    description: tr(`field.${field.id}.description`, field.description || ''),
                    options: field.options?.map(opt => ({
                        ...opt,
                        label: tr(`field.${field.id}.option.${opt.value}`, opt.label),
                    })),
                };

                let row;
                try {
                    row = _buildRow(translatedField, settingsProxy, notifyChange, autocompleteCtx);
                } catch (e) {
                    // Defense in depth (2026-08-09, handover v4): a bad
                    // field (unescaped markup, a future new fieldType bug,
                    // ...) should degrade to a disabled placeholder row,
                    // never take the whole Preferences window down with it.
                    console.error(`[widget-center] failed to build row for field "${field.id}"`, e);
                    row = new Adw.ActionRow({
                        title: GLib.markup_escape_text(String(field.id ?? 'field'), -1),
                        subtitle: 'Could not display this setting - see logs.',
                    });
                }
                adwGroup.add(row);

                if (field.visibleIf || field.enabledIf || field.dependsOn) {
                    conditions.set(field.id, {row, field});
                    for (const dep of _extractDependencyIds(field))
                        _addDependent(dependents, dep, field.id);
                }
            }
        }
    }

    // Initial pass so a field whose visibility/enabled state depends on
    // another field's *default* value starts correct before any edits.
    _reevaluateAll(conditions, dependents, settingsProxy);

    return page;
}

/** @private every fieldId referenced by a condition string. */
function _extractDependencyIds(field) {
    const ids = new Set();
    for (const expr of [field.visibleIf, field.enabledIf, field.dependsOn]) {
        if (typeof expr !== 'string')
            continue;
        for (const m of expr.matchAll(/[A-Za-z_][\w.]*/g))
            ids.add(m[0]);
    }
    return ids;
}

function _addDependent(dependents, depId, fieldId) {
    if (!dependents.has(depId))
        dependents.set(depId, new Set());
    dependents.get(depId).add(fieldId);
}

function _reevaluateAll(conditions, dependents, settingsProxy) {
    for (const {row, field} of conditions.values())
        _applyConditions(row, field, settingsProxy);
}

function _applyConditions(row, field, settingsProxy) {
    if (field.visibleIf !== undefined)
        row.visible = _evaluateCondition(field.visibleIf, settingsProxy);
    if (field.enabledIf !== undefined)
        row.sensitive = _evaluateCondition(field.enabledIf, settingsProxy);
    if (field.dependsOn !== undefined && field.enabledIf === undefined)
        row.sensitive = _evaluateCondition(field.dependsOn, settingsProxy);
}

/**
 * Tiny, safe (no eval()) boolean expression evaluator for visibleIf /
 * enabledIf / dependsOn. Supports `&&` / `||` (left-to-right, no
 * parentheses), `!field`, `field == 'value'` / `field != 'value'`
 * (string/number/boolean literals), and a bare `field` name as a
 * truthiness check.
 * @private
 */
function _evaluateCondition(expr, settingsProxy) {
    if (!expr)
        return true;
    return expr.split('||').some(orPart =>
        orPart.split('&&').every(andPart => _evaluateSingle(andPart.trim(), settingsProxy)));
}

function _evaluateSingle(cond, settingsProxy) {
    let negate = false;
    if (cond.startsWith('!')) {
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
        result = op === '==' ? eq : !eq;
    } else {
        result = Boolean(settingsProxy[cond]);
    }
    return negate ? !result : result;
}

function _parseLiteral(raw) {
    if (raw === 'true')
        return true;
    if (raw === 'false')
        return false;
    if (/^-?\d+(\.\d+)?$/.test(raw))
        return Number(raw);
    const quoted = raw.match(/^['"](.*)['"]$/);
    return quoted ? quoted[1] : raw;
}

/** @private dispatches a field to its row builder by fieldType. */
function _buildRow(field, settingsProxy, notifyChange, autocompleteCtx) {
    const current = field.id in settingsProxy ? settingsProxy[field.id] : field.default;
    const set = value => {
        settingsProxy[field.id] = value;
        notifyChange();
    };

    switch (field.fieldType) {
    case 'text':
        return _textRow(field, current, set);
    case 'location':
        return _locationRow(field, current, set);
    case 'textarea':
        return _textareaRow(field, current, set);
    case 'password':
        return _passwordRow(field, current, set);
    case 'switch':
        return _switchRow(field, current, set);
    case 'checkbox':
        return _checkboxRow(field, current, set);
    case 'dropdown':
    case 'radio':
        return _dropdownRow(field, current, set);
    case 'spinbutton':
        return _spinRow(field, current, set);
    case 'slider':
        return _sliderRow(field, current, set);
    case 'colorpicker':
        return _colorRow(field, current, set);
    case 'fontpicker':
        return _fontRow(field, current, set);
    case 'iconpicker':
        return _iconRow(field, current, set);
    case 'filepicker':
        return _pathRow(field, current, set, {folder: false});
    case 'folderpicker':
        return _pathRow(field, current, set, {folder: true});
    case 'list':
        return _listRow(field, current, set);
    case 'object':
        return _objectRow(field, current, set);
    case 'autocomplete':
        return _autocompleteRow(field, current, set, autocompleteCtx);
    default:
        // Unreachable if validateConfig() ran first (see this module's
        // header) — a disabled placeholder instead of throwing, so one
        // bad field can't blank a whole page.
        return new Adw.ActionRow({
            title: GLib.markup_escape_text(String(field.label ?? field.id ?? ''), -1),
            subtitle: `Unknown fieldType "${field.fieldType}"`,
            sensitive: false,
        });
    }
}

