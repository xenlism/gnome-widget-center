// products/extension/lib/widgetConfigUI.js
//
// Builds an Adw.PreferencesPage from a widget's config.json (tabs/groups/
// fields — see development/docs/WIDGET_API.md §6.4 and
// widgetConfigValidator.js for the format this consumes). This is the
// config.json equivalent of settingsSchemaUI.js's buildSettingsPage() for
// the older flat `settings` array, and follows the same conventions:
//
//   - Prefs process ONLY (imports Adw/Gtk/Gdk/Pango) — never import this
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

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Pango from 'gi://Pango';
import Gio from 'gi://Gio';

/**
 * @param {object} config - a widget's parsed + validated config.json
 * @param {object} settingsProxy - from WidgetSettings.load(), already
 *   defaulted (see buildSettingsPage()'s equivalent parameter).
 * @param {string} title - the widget's display name, used as page title.
 * @returns {Adw.PreferencesPage}
 */
export function buildConfigPage(config, settingsProxy, title) {
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

    for (const tab of config.tabs) {
        for (const group of tab.groups) {
            const adwGroup = new Adw.PreferencesGroup({
                title: multiTab ? `${tab.label} — ${group.label}` : group.label,
                description: group.description || '',
            });
            page.add(adwGroup);

            for (const field of group.fields) {
                const row = _buildRow(field, settingsProxy, notifyChange);
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
function _buildRow(field, settingsProxy, notifyChange) {
    const current = field.id in settingsProxy ? settingsProxy[field.id] : field.default;
    const set = value => {
        settingsProxy[field.id] = value;
        notifyChange();
    };

    switch (field.fieldType) {
    case 'text':
        return _textRow(field, current, set);
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
    default:
        // Unreachable if validateConfig() ran first (see this module's
        // header) — a disabled placeholder instead of throwing, so one
        // bad field can't blank a whole page.
        return new Adw.ActionRow({
            title: field.label ?? field.id,
            subtitle: `Unknown fieldType "${field.fieldType}"`,
            sensitive: false,
        });
    }
}

function _textRow(field, current, set) {
    const row = new Adw.EntryRow({
        title: field.label,
        text: String(current ?? ''),
        show_apply_button: Boolean(field.pattern || field.minLength || field.maxLength),
    });
    if (field.description)
        row.set_tooltip_text(field.description);

    const validate = () => {
        const value = row.text;
        let ok = true;
        if (field.required && value.length === 0)
            ok = false;
        if (field.minLength !== undefined && value.length < field.minLength)
            ok = false;
        if (field.maxLength !== undefined && value.length > field.maxLength)
            ok = false;
        if (field.pattern && !new RegExp(field.pattern).test(value))
            ok = false;
        row[ok ? 'remove_css_class' : 'add_css_class']('error');
        return ok;
    };

    row.connect('notify::text', () => {
        if (validate())
            set(row.text);
    });
    row.connect('apply', () => validate());
    validate();
    return row;
}

// GTK4/libadwaita has no true multi-line EntryRow, so `textarea` pairs an
// Adw.ActionRow's title/subtitle with a Gtk.TextView in a bordered
// Gtk.ScrolledWindow suffix — the same "row title + custom widget"
// pattern the color/font pickers below already use.
function _textareaRow(field, current, set) {
    const row = new Adw.ActionRow({title: field.label, subtitle: field.description || ''});

    const buffer = new Gtk.TextBuffer({text: String(current ?? '')});
    const textView = new Gtk.TextView({
        buffer,
        wrap_mode: Gtk.WrapMode.WORD_CHAR,
        top_margin: 6, bottom_margin: 6, left_margin: 6, right_margin: 6,
    });
    const scroller = new Gtk.ScrolledWindow({
        child: textView,
        min_content_height: 80,
        min_content_width: 240,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        css_classes: ['card'],
        valign: Gtk.Align.CENTER,
    });
    buffer.connect('changed', () => {
        set(buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false));
    });

    row.add_suffix(scroller);
    row.set_activatable(false);
    return row;
}

function _passwordRow(field, current, set) {
    const row = new Adw.PasswordEntryRow({title: field.label, text: String(current ?? '')});
    if (field.description)
        row.set_tooltip_text(field.description);
    row.connect('notify::text', () => set(row.text));
    return row;
}

function _switchRow(field, current, set) {
    const row = new Adw.SwitchRow({
        title: field.label,
        subtitle: field.description || '',
        active: Boolean(current),
    });
    row.connect('notify::active', () => set(row.active));
    return row;
}

// `checkbox` is semantically identical to `switch` in this spec (a single
// boolean) but rendered as a Gtk.CheckButton suffix instead, for widget
// authors who specifically want checkbox styling (e.g. inside a group of
// otherwise unrelated toggles) rather than an iOS-style switch.
function _checkboxRow(field, current, set) {
    const row = new Adw.ActionRow({title: field.label, subtitle: field.description || ''});
    const check = new Gtk.CheckButton({active: Boolean(current), valign: Gtk.Align.CENTER});
    check.connect('notify::active', () => set(check.active));
    row.add_suffix(check);
    row.set_activatable_widget(check);
    return row;
}

function _dropdownRow(field, current, set) {
    // options: plain strings, or {value, label} objects — both accepted,
    // same convention as settingsSchemaUI.js's _dropdownRow().
    const options = field.options.map(opt =>
        typeof opt === 'string' ? {value: opt, label: opt} : opt);

    const model = new Gtk.StringList({strings: options.map(opt => opt.label)});
    const row = new Adw.ComboRow({
        title: field.label,
        subtitle: field.description || '',
        model,
        enable_search: Boolean(field.searchable),
    });

    const currentIndex = options.findIndex(opt => opt.value === current);
    row.selected = currentIndex >= 0 ? currentIndex : 0;

    row.connect('notify::selected', () => set(options[row.selected]?.value));
    return row;
}

function _spinRow(field, current, set) {
    const hasBounds = typeof field.min === 'number' && typeof field.max === 'number';
    const step = field.step ?? 1;
    const adjustment = new Gtk.Adjustment({
        value: current,
        lower: hasBounds ? field.min : -Number.MAX_SAFE_INTEGER,
        upper: hasBounds ? field.max : Number.MAX_SAFE_INTEGER,
        step_increment: step,
        page_increment: step * 4,
    });
    const row = new Adw.SpinRow({
        title: field.label,
        subtitle: field.description || (hasBounds ? `${field.min}\u2013${field.max}${field.unit ?? ''}` : ''),
        adjustment,
        digits: field.decimals ?? (Number.isInteger(step) ? 0 : 2),
    });
    row.connect('notify::value', () => set(row.value));
    return row;
}

function _sliderRow(field, current, set) {
    const min = field.min ?? 0;
    const max = field.max ?? 100;
    const row = new Adw.ActionRow({title: field.label, subtitle: field.description || ''});

    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        adjustment: new Gtk.Adjustment({
            value: current ?? min,
            lower: min,
            upper: max,
            step_increment: field.step ?? 1,
        }),
        draw_value: Boolean(field.showValue ?? true),
        hexpand: true,
        valign: Gtk.Align.CENTER,
        width_request: 160,
    });
    scale.connect('value-changed', () => set(scale.get_value()));

    row.add_suffix(scale);
    row.set_activatable(false);
    return row;
}

function _colorRow(field, current, set) {
    const row = new Adw.ActionRow({title: field.label, subtitle: field.description || ''});

    const rgba = new Gdk.RGBA();
    rgba.parse(typeof current === 'string' ? current : String(field.default));

    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: Boolean(field.alpha)}),
        rgba,
        valign: Gtk.Align.CENTER,
    });
    button.connect('notify::rgba', () => set(button.rgba.to_string()));

    row.add_suffix(button);
    row.set_activatable_widget(button);
    return row;
}

function _fontRow(field, current, set) {
    const row = new Adw.ActionRow({title: field.label, subtitle: field.description || ''});

    const button = new Gtk.FontDialogButton({dialog: new Gtk.FontDialog(), valign: Gtk.Align.CENTER});
    button.set_font_desc(Pango.FontDescription.from_string(
        typeof current === 'string' ? current : String(field.default)));
    button.connect('notify::font-desc', () => set(button.get_font_desc().to_string()));

    row.add_suffix(button);
    row.set_activatable_widget(button);
    return row;
}

// No dedicated GTK "icon picker" dialog ships in core GTK4, so this takes
// a symbolic icon name as plain text (matching how every icon/symbolic
// name elsewhere in this codebase's own metadata.json files works) with a
// live preview suffix — good enough for "type/paste a
// `something-symbolic` name", not a browsable icon grid.
function _iconRow(field, current, set) {
    const row = new Adw.EntryRow({title: field.label, text: String(current ?? '')});
    if (field.description)
        row.set_tooltip_text(field.description);

    const preview = new Gtk.Image({icon_name: String(current || 'image-missing-symbolic')});
    row.add_suffix(preview);
    row.connect('notify::text', () => {
        preview.set_from_icon_name(row.text || 'image-missing-symbolic');
        set(row.text);
    });
    return row;
}

// Shared by filepicker/folderpicker — a "Browse…" button opening
// Gtk.FileDialog, same pattern widgets/clock-modern/prefs.js already uses
// for its .desktop-file row (see WIDGET_API.md §6.2).
function _pathRow(field, current, set, {folder}) {
    const row = new Adw.ActionRow({
        title: field.label,
        subtitle: current || field.placeholder || 'Not set',
    });

    const button = new Gtk.Button({label: 'Browse…', valign: Gtk.Align.CENTER});
    button.connect('clicked', () => {
        const dialog = new Gtk.FileDialog({title: field.label});

        if (!folder && Array.isArray(field.filters) && field.filters.length > 0) {
            const store = new Gio.ListStore({item_type: Gtk.FileFilter});
            for (const pattern of field.filters) {
                const filter = new Gtk.FileFilter();
                filter.set_name(pattern);
                filter.add_pattern(pattern);
                store.append(filter);
            }
            dialog.set_filters(store);
            dialog.set_default_filter(store.get_item(0));
        }

        const parent = button.get_root();
        const onPicked = (_dialog, result) => {
            try {
                const file = folder ? dialog.select_folder_finish(result) : dialog.open_finish(result);
                if (file) {
                    const path = file.get_path();
                    row.subtitle = path;
                    set(path);
                }
            } catch (e) {
                // User cancelled — nothing to persist.
            }
        };

        if (folder)
            dialog.select_folder(parent, null, onPicked);
        else
            dialog.open(parent, null, onPicked);
    });

    row.add_suffix(button);
    row.set_activatable_widget(button);
    return row;
}

// `object` — a nested group of fields stored as one JSON object under
// this field's id. Rendered as an Adw.ExpanderRow so it doesn't compete
// for vertical space with the rest of the group until opened. Every
// nested field writes through a *whole-object* reassignment
// (`set({...current, [key]: value})`) rather than mutating `current` in
// place, because WidgetSettings' Proxy only triggers its debounced save
// on a top-level property SET (see widgetSettings.js) — mutating a
// nested object's own property silently wouldn't persist.
function _objectRow(field, current, set) {
    const row = new Adw.ExpanderRow({title: field.label, subtitle: field.description || ''});
    const base = current && typeof current === 'object' ? current : {};

    // Each property is built against its own one-key live Proxy so that
    // editing it re-assigns the WHOLE parent object through `set()` (see
    // this function's header comment on why nested mutation alone
    // wouldn't persist), while still reusing every plain _buildRow()
    // fieldType renderer unchanged.
    for (const [key, propField] of Object.entries(field.properties)) {
        const propCurrent = key in base ? base[key] : propField.default;
        const liveProp = new Proxy({[key]: propCurrent}, {
            set(target, prop, value) {
                target[prop] = value;
                set({...(current && typeof current === 'object' ? current : {}), [key]: value});
                return true;
            },
        });
        const nestedField = {...propField, id: key};
        row.add_row(_buildRow(nestedField, liveProp, () => {}));
    }

    return row;
}

// `list` — an add/remove/reorder-able array of items, stored as a whole
// array under this field's id (same whole-value-reassignment reasoning
// as _objectRow() above, for the same Proxy-only-triggers-on-top-level-
// set reason). Supports primitive items (string/number/boolean, shown as
// a single-field row each) and `object` items (shown as a nested
// Adw.ExpanderRow each, reusing _objectRow()'s field renderer).
function _listRow(field, current, set) {
    const row = new Adw.ExpanderRow({title: field.label, subtitle: field.description || ''});
    let items = Array.isArray(current) ? [...current] : [];

    const withinBounds = (delta => {
        const next = items.length + delta;
        if (field.minItems !== undefined && next < field.minItems)
            return false;
        if (field.maxItems !== undefined && next > field.maxItems)
            return false;
        return true;
    });

    const rerender = () => {
        row.remove_all?.();
        items.forEach((item, index) => row.add_row(_buildItemRow(field, item, index)));
        if (field.addable !== false) {
            const addRow = new Adw.ActionRow({title: 'Add item'});
            const addButton = new Gtk.Button({icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
            addButton.set_sensitive(withinBounds(1));
            addButton.connect('clicked', () => {
                items = [...items, _defaultItem(field.item)];
                set([...items]);
                rerender();
            });
            addRow.add_suffix(addButton);
            addRow.set_activatable_widget(addButton);
            row.add_row(addRow);
        }
    };

    // eslint-disable-next-line no-unused-vars
    function _buildItemRow(_field, item, index) {
        const itemSchema = field.item;
        if (itemSchema.dataType === 'object') {
            const objField = {...itemSchema, id: `item-${index}`, label: `Item ${index + 1}`, fieldType: 'object'};
            const expander = _objectRow(objField, item, updated => {
                items = items.map((it, i) => i === index ? updated : it);
                set([...items]);
            });
            if (field.removable !== false)
                expander.add_row(_removeRow(index));
            return expander;
        }

        const primField = {
            ...itemSchema,
            id: `item-${index}`,
            label: `Item ${index + 1}`,
            fieldType: itemSchema.fieldType ?? (itemSchema.dataType === 'boolean' ? 'switch' : 'text'),
        };
        const liveItem = new Proxy({[primField.id]: item}, {
            set(target, prop, value) {
                target[prop] = value;
                items = items.map((it, i) => i === index ? value : it);
                set([...items]);
                return true;
            },
        });
        const itemRow = _buildRow(primField, liveItem, () => {});
        if (field.removable !== false && itemRow.add_suffix) {
            const removeButton = new Gtk.Button({icon_name: 'list-remove-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
            removeButton.set_sensitive(withinBounds(-1));
            removeButton.connect('clicked', () => {
                items = items.filter((_, i) => i !== index);
                set([...items]);
                rerender();
            });
            itemRow.add_suffix(removeButton);
        }
        return itemRow;
    }

    function _removeRow(index) {
        const removeRow = new Adw.ActionRow({title: 'Remove this item'});
        const removeButton = new Gtk.Button({icon_name: 'list-remove-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
        removeButton.connect('clicked', () => {
            items = items.filter((_, i) => i !== index);
            set([...items]);
            rerender();
        });
        removeRow.add_suffix(removeButton);
        removeRow.set_activatable_widget(removeButton);
        return removeRow;
    }

    rerender();
    return row;
}

function _defaultItem(itemSchema) {
    if (itemSchema.dataType === 'object') {
        const obj = {};
        for (const [key, propField] of Object.entries(itemSchema.properties ?? {}))
            obj[key] = propField.default;
        return obj;
    }
    return itemSchema.default ?? (itemSchema.dataType === 'boolean' ? false : itemSchema.dataType === 'string' ? '' : 0);
}
