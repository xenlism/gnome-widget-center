// products/extension/lib/settingsSchemaUI.js
//
// Task 05 — builds an Adw.PreferencesPage from a widget's declarative
// `metadata.json` "settings" schema (see settingsSchema.js for the
// format this consumes and the reasoning behind its v1 type list) plus a
// live WidgetSettings proxy to read/write. Prefs process ONLY (imports
// Adw/Gtk/Gdk) — never import this from widgetLoader.js or anything else
// that also runs in the Shell process, per development/docs/WIDGET_API.md §4's
// process split.
//
// One row type per settingsSchema.js's SETTING_TYPES entry:
//   string   -> Adw.EntryRow
//   number   -> Adw.SpinRow (unbounded)
//   range    -> Adw.SpinRow bounded by min/max
//   boolean  -> Adw.SwitchRow
//   dropdown -> Adw.ComboRow (Gtk.StringList of option labels)
//   color    -> Adw.ActionRow + Gtk.ColorDialogButton suffix
//
// Every row writes straight through to the settings proxy on change —
// same debounced auto-save WidgetSettings.load() already gives any other
// caller (see widgetSettings.js), no separate "Save" step. Matches every
// hand-written prefs.js already in this codebase (e.g.
// widgets/clock/prefs.js) so a widget switching FROM a hand-written
// prefs.js TO a declarative schema doesn't change that behavior.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';

/**
 * @method buildSettingsPage
 * @description Entry point — call this instead of importing a widget's
 * own prefs.js when it has no prefs.js of its own but does have a
 * `settings` array in metadata.json (see prefs.js's `_openWidgetPrefs()`
 * for the precedence rule between the two).
 * @param {Array} schema - metadata.settings. Assumed already validated —
 *   WidgetLoader.discover() rejects a widget with an invalid schema
 *   before it can ever reach the Control Center's widget list (see
 *   settingsSchema.js's validateSettingsSchema()), so this function
 *   trusts its input and does not re-validate.
 * @param {Object} settingsProxy - from WidgetSettings.load(), already
 *   defaulted (WidgetSettings.applyDefaults() has already run by the
 *   time a widget shows up in the list — see widgetLoader.js).
 * @param {string} title - the widget's display name, used as the page
 *   title.
 * @returns {Adw.PreferencesPage}
 */
export function buildSettingsPage(schema, settingsProxy, title) {
    const page = new Adw.PreferencesPage({title});
    const group = new Adw.PreferencesGroup();
    page.add(group);

    for (const field of schema)
        group.add(_buildRow(field, settingsProxy));

    return page;
}

function _buildRow(field, settingsProxy) {
    const current = field.id in settingsProxy ? settingsProxy[field.id] : field.default;

    switch (field.type) {
    case 'string':
        return _stringRow(field, settingsProxy, current);
    case 'number':
        return _numberRow(field, settingsProxy, current);
    case 'range':
        return _rangeRow(field, settingsProxy, current);
    case 'boolean':
        return _booleanRow(field, settingsProxy, current);
    case 'dropdown':
        return _dropdownRow(field, settingsProxy, current);
    case 'color':
        return _colorRow(field, settingsProxy, current);
    default:
        // Unreachable if validateSettingsSchema() ran first (see this
        // function's caller doc comment) — a plain disabled row instead
        // of throwing, so one bad field can't blank the whole page if
        // this is ever reached by some future caller that skips
        // validation.
        return new Adw.ActionRow({
            title: field.label ?? field.id,
            subtitle: `Unknown setting type "${field.type}"`,
            sensitive: false,
        });
    }
}

function _stringRow(field, settingsProxy, current) {
    const row = new Adw.EntryRow({title: field.label, text: String(current ?? '')});
    if (field.description)
        row.set_tooltip_text(field.description);
    row.connect('notify::text', () => {
        settingsProxy[field.id] = row.text;
    });
    return row;
}

function _numberRow(field, settingsProxy, current) {
    const adjustment = new Gtk.Adjustment({
        value: current,
        lower: -Number.MAX_SAFE_INTEGER,
        upper: Number.MAX_SAFE_INTEGER,
        step_increment: 1,
    });
    const row = new Adw.SpinRow({title: field.label, adjustment});
    if (field.description)
        row.set_tooltip_text(field.description);
    row.connect('notify::value', () => {
        settingsProxy[field.id] = row.value;
    });
    return row;
}

function _rangeRow(field, settingsProxy, current) {
    const step = field.step ?? 1;
    const adjustment = new Gtk.Adjustment({
        value: current,
        lower: field.min,
        upper: field.max,
        step_increment: step,
    });
    const row = new Adw.SpinRow({
        title: field.label,
        subtitle: `${field.min}\u2013${field.max}`,
        adjustment,
        digits: Number.isInteger(step) ? 0 : 2,
    });
    if (field.description)
        row.set_tooltip_text(field.description);
    row.connect('notify::value', () => {
        settingsProxy[field.id] = row.value;
    });
    return row;
}

function _booleanRow(field, settingsProxy, current) {
    const row = new Adw.SwitchRow({title: field.label, active: Boolean(current)});
    if (field.description)
        row.set_subtitle(field.description);
    row.connect('notify::active', () => {
        settingsProxy[field.id] = row.active;
    });
    return row;
}

function _dropdownRow(field, settingsProxy, current) {
    // options: either plain strings, or {value, label} objects — both
    // forms accepted so a widget author with a plain enum-like list of
    // strings doesn't have to wrap every one in an object.
    const options = field.options.map(opt =>
        typeof opt === 'string' ? {value: opt, label: opt} : opt);

    const model = new Gtk.StringList({strings: options.map(opt => opt.label)});
    const row = new Adw.ComboRow({title: field.label, model});
    if (field.description)
        row.set_tooltip_text(field.description);

    const currentIndex = options.findIndex(opt => opt.value === current);
    row.selected = currentIndex >= 0 ? currentIndex : 0;

    row.connect('notify::selected', () => {
        settingsProxy[field.id] = options[row.selected]?.value;
    });
    return row;
}

function _colorRow(field, settingsProxy, current) {
    const row = new Adw.ActionRow({title: field.label});
    if (field.description)
        row.set_subtitle(field.description);

    const rgba = new Gdk.RGBA();
    rgba.parse(typeof current === 'string' ? current : String(field.default));

    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog(),
        rgba,
        valign: Gtk.Align.CENTER,
    });
    button.connect('notify::rgba', () => {
        settingsProxy[field.id] = button.rgba.to_string();
    });
    row.add_suffix(button);
    row.set_activatable_widget(button);
    return row;
}
