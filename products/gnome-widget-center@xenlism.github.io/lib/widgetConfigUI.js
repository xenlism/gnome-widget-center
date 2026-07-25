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

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Pango from 'gi://Pango';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

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
 * @returns {Adw.PreferencesPage}
 */
export function buildConfigPage(config, settingsProxy, title, widgetPath) {
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

    for (const tab of config.tabs) {
        for (const group of tab.groups) {
            const adwGroup = new Adw.PreferencesGroup({
                title: multiTab ? `${tab.label} — ${group.label}` : group.label,
                description: group.description || '',
            });
            page.add(adwGroup);

            for (const field of group.fields) {
                const row = _buildRow(field, settingsProxy, notifyChange, autocompleteCtx);
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

// "autocomplete" — Handover.md's generic Autocomplete Field: an
// Adw.EntryRow + Gtk.Popover suggestion list. This function contains NO
// business logic of its own — it only debounces keystrokes, calls the
// named export from the widget's own autocomplete.js (via `ctx`,
// see buildConfigPage()), renders whatever {label, value, subtitle?,
// icon?, image?, badge?, data?} objects come back, and on selection
// stores ONLY `value` while displaying `label` (per the spec's Display
// vs Value section) — never a hidden Gtk.Entry, just the one EntryRow.
//
// Cross-field fill (the Location Picker's "selecting a Place updates
// Location too" behavior): a search-result item may include a `fields`
// map ({siblingFieldId: value, ...}). Each entry is written to that
// sibling's own setting AND, if a sibling autocomplete row is present in
// the same config, its displayed text too — via ctx.fillSibling(), fed by
// ctx.registerRow() below. See widgets/weather-minimal/autocomplete.js
// for a concrete example (searchPlace()'s results include
// `fields: {location: "lat,lon"}`, and vice versa).
//
// KNOWN LIMITATION: on first open, the row shows the raw stored `value`
// (e.g. "13.756331,100.501762") rather than a resolved `label`, since only
// `value` is persisted — a fresh label is only shown after the user
// searches/selects again in this session. Good enough for a coordinate
// pair; a future version could persist the label alongside the value if
// this becomes a problem for less self-describing values.
function _autocompleteRow(field, current, set, ctx) {
    const row = new Adw.EntryRow({
        title: field.label,
        text: String(current ?? ''),
    });
    if (field.description)
        row.set_tooltip_text(field.description);

    const validate = () => {
        if (!field.pattern)
            return true;
        const ok = new RegExp(field.pattern).test(row.text);
        row[ok ? 'remove_css_class' : 'add_css_class']('error');
        return ok;
    };
    validate();

    const listBox = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE});
    listBox.add_css_class('boxed-list');
    const popover = new Gtk.Popover({autohide: true, has_arrow: false});
    popover.set_parent(row);
    popover.set_child(listBox);

    // True while WE are changing row.text programmatically (a selection,
    // or a sibling field filling us in) so notify::text doesn't treat our
    // own write as a fresh keystroke and fire another search.
    let suppressSearch = false;
    let debounceId = null;

    const clearSuggestions = () => {
        let child;
        while ((child = listBox.get_first_child()))
            listBox.remove(child);
    };

    const runSearch = keyword => {
        clearSuggestions();
        if (!keyword || !ctx) {
            popover.popdown();
            return;
        }

        ctx.loadAutocompleteFn(field.autocomplete)
            .then(fn => fn(keyword))
            .then(results => {
                clearSuggestions();
                if (!Array.isArray(results) || results.length === 0) {
                    popover.popdown();
                    return;
                }
                for (const item of results) {
                    const itemRow = new Adw.ActionRow({
                        title: item.label ?? String(item.value),
                        subtitle: item.subtitle ?? '',
                        activatable: true,
                    });
                    itemRow.connect('activated', () => {
                        suppressSearch = true;
                        row.text = item.label ?? String(item.value);
                        suppressSearch = false;
                        validate();
                        set(item.value);
                        popover.popdown();

                        if (item.fields && typeof item.fields === 'object') {
                            for (const [siblingId, siblingValue] of Object.entries(item.fields))
                                ctx.fillSibling(siblingId, siblingValue);
                        }
                    });
                    listBox.append(itemRow);
                }
                popover.popup();
            })
            .catch(e => {
                logError?.(e, `autocomplete "${field.autocomplete}" failed`);
                clearSuggestions();
                popover.popdown();
            });
    };

    row.connect('notify::text', () => {
        if (suppressSearch)
            return;
        validate();

        if (debounceId !== null)
            GLib.source_remove(debounceId);
        debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            debounceId = null;
            runSearch(row.text.trim());
            return GLib.SOURCE_REMOVE;
        });
    });

    row.connect('apply', () => validate());

    // So a SIBLING autocomplete field's selection can update our own
    // displayed text (see this function's header comment).
    ctx?.registerRow(field.id, value => {
        suppressSearch = true;
        row.text = String(value ?? '');
        suppressSearch = false;
        validate();
    });

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

// `fontpicker` — Gtk.FontDialogButton (GTK 4.10+'s replacement for the
// deprecated Gtk.FontButton). Two failure modes previously crashed
// prefs.js here and both are guarded below rather than avoiding
// FontDialogButton/Pango altogether:
//   1. An empty/missing current value or `field.default` fed straight
//      into Pango.FontDescription.from_string() — now falls back to a
//      safe "Sans 10" default instead.
//   2. `button.get_font_desc()` can return null (observed when the
//      dialog is dismissed without a selection) — calling `.to_string()`
//      on that null was the actual crash. Now just skipped: no selection
//      means nothing new to persist.
function _fontRow(field, current, set) {
    const row = new Adw.ActionRow({title: field.label, subtitle: field.description || ''});

    const button = new Gtk.FontDialogButton({dialog: new Gtk.FontDialog(), valign: Gtk.Align.CENTER});

    const fallback = typeof field.default === 'string' && field.default.length > 0 ? field.default : 'Sans 10';
    const initial = typeof current === 'string' && current.length > 0 ? current : fallback;
    try {
        button.set_font_desc(Pango.FontDescription.from_string(initial));
    } catch (e) {
        button.set_font_desc(Pango.FontDescription.from_string(fallback));
    }

    button.connect('notify::font-desc', () => {
        const desc = button.get_font_desc();
        if (!desc)
            return;
        set(desc.to_string());
    });

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

// `list` — an add/remove-able array of items, stored as a whole array
// under this field's id (same whole-value-reassignment reasoning as
// _objectRow() above, for the same Proxy-only-triggers-on-top-level-set
// reason). Two distinct "add" flows depending on `item.format`:
//
//   - `item.format: "app"` (item stays a plain `dataType: "string"` —
//     this is a FORMAT hint, not a separate field type) — reference:
//     xenlism's own `URL-Chooser` app's `settings.js` "browser_list"
//     panel (a real, working, non-declarative implementation of exactly
//     this pattern). Each item is an installed app's `.desktop` path,
//     shown as an Adw.ActionRow with the app's real icon/display name
//     (via `Gio.DesktopAppInfo`) and the path as a dim subtitle, plus a
//     red trash-icon remove button (`.add_css_class('error')` on a flat
//     button - the exact trick URL-Chooser's own `btnRemove` uses to get
//     a red icon without a whole custom style). No inline text field
//     makes sense for "type a .desktop path by hand", so the row before
//     "+" is skipped for this one item kind - instead "+" itself opens a
//     `Gtk.FileDialog` scoped to `item.scanDirectory` (default
//     `/usr/share/applications`), and a second button next to it
//     (`find-location-symbolic`, the same icon URL-Chooser's own
//     "auto-detect" button uses) bulk-adds every `.desktop` entry in that
//     directory not already in the list, optionally narrowed by
//     `item.scanPattern` (a case-insensitive regex matched against the
//     filename) - a generic stand-in for URL-Chooser's own
//     hardcoded-to-browsers `Core.autoDetectBrowsers()`, since a
//     declarative config.json has no way to ship that kind of per-widget
//     detection logic itself.
//   - anything else (string/number/boolean/dropdown/etc) — existing items
//     stay individually inline-editable exactly as before (each one's own
//     _buildRow() field renderer + remove button), AND an inline staging
//     input control matching the item's type sits directly before "+"
//     (built by _buildStagingControl() below) so clicking "+" appends
//     whatever's currently in that control and clears it for the next
//     entry, rather than only being able to add a blank item and edit it
//     in place after the fact.
//
// `object` items are unaffected by either of the above: still one nested
// Adw.ExpanderRow per item (reusing _objectRow()'s field renderer), added
// via a plain "Add item" button with no staging control of its own since
// there's no single input that could represent a whole object's worth of
// fields at once.
function _listRow(field, current, set) {
    const row = new Adw.ExpanderRow({title: field.label, subtitle: field.description || ''});
    let items = Array.isArray(current) ? [...current] : [];
    const isApplicationList = field.item?.dataType !== 'object' && field.item?.format === 'app';

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
        items.forEach((item, index) => row.add_row(_buildItemRow(item, index)));
        if (field.addable !== false)
            row.add_row(isApplicationList ? _applicationAddRow() : _staticAddRow());
    };

    function _buildItemRow(item, index) {
        const itemSchema = field.item;

        if (itemSchema.format === 'app')
            return _applicationItemRow(item, index);

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

    // `.desktop` path item -> icon + display name + path, matching
    // URL-Chooser's own "browser_list" row layout exactly.
    function _applicationItemRow(path, index) {
        const itemRow = new Adw.ActionRow();

        let displayName = GLib.path_get_basename(path);
        let gicon = null;
        try {
            if (path.endsWith('.desktop')) {
                const appInfo = Gio.DesktopAppInfo.new_from_filename(path);
                if (appInfo) {
                    displayName = appInfo.get_display_name();
                    gicon = appInfo.get_icon();
                }
            }
        } catch (e) {
            // Missing/unreadable .desktop file - fall back to the bare path.
        }

        itemRow.title = displayName;
        itemRow.subtitle = path;

        const icon = new Gtk.Image({pixel_size: 24, valign: Gtk.Align.CENTER});
        if (gicon)
            icon.set_from_gicon(gicon);
        else
            icon.set_from_icon_name('application-x-executable-symbolic');
        itemRow.add_prefix(icon);

        if (field.removable !== false) {
            const removeButton = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
            removeButton.add_css_class('error');
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

    // "+" (browse one `.desktop` file) and a scan/auto-detect button
    // (bulk-add every not-yet-present `.desktop` entry in
    // item.scanDirectory, optionally narrowed by item.scanPattern).
    function _applicationAddRow() {
        const scanDirectory = field.item.scanDirectory ?? '/usr/share/applications';
        const addRow = new Adw.ActionRow({title: 'Add application', subtitle: scanDirectory});
        const buttonBox = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, valign: Gtk.Align.CENTER});

        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
            tooltip_text: 'Browse for an application',
            sensitive: withinBounds(1),
        });
        addButton.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: field.label ?? 'Add application'});
            dialog.set_initial_folder(Gio.File.new_for_path(scanDirectory));

            const filterStore = new Gio.ListStore({item_type: Gtk.FileFilter});
            const filter = new Gtk.FileFilter();
            filter.set_name('Desktop entries');
            filter.add_pattern('*.desktop');
            filterStore.append(filter);
            dialog.set_filters(filterStore);
            dialog.set_default_filter(filter);

            dialog.open(addButton.get_root(), null, (_dialog, result) => {
                try {
                    const file = dialog.open_finish(result);
                    const path = file?.get_path();
                    if (path && !items.includes(path)) {
                        items = [...items, path];
                        set([...items]);
                        rerender();
                    }
                } catch (e) {
                    // User cancelled the dialog - nothing to add.
                }
            });
        });

        const scanButton = new Gtk.Button({
            icon_name: 'find-location-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
            tooltip_text: `Scan ${scanDirectory} for matching apps`,
        });
        scanButton.connect('clicked', () => {
            const found = _scanApplications(scanDirectory, field.item.scanPattern);
            const additions = found.filter(path => !items.includes(path));
            if (additions.length === 0)
                return;
            items = [...items, ...additions];
            set([...items]);
            rerender();
        });

        buttonBox.append(addButton);
        buttonBox.append(scanButton);
        addRow.add_suffix(buttonBox);
        return addRow;
    }

    // Every other item kind: an inline input control for the value to
    // add, sitting directly to the left of "+".
    function _staticAddRow() {
        const addRow = new Adw.ActionRow({title: 'Add item'});
        const staging = _buildStagingControl(field.item);

        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
            sensitive: withinBounds(1),
        });
        addButton.connect('clicked', () => {
            if (!withinBounds(1))
                return;
            items = [...items, staging.getValue()];
            set([...items]);
            staging.reset();
            rerender();
        });

        addRow.add_suffix(staging.widget);
        addRow.add_suffix(addButton);
        return addRow;
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

// The inline "value to add" control that sits before "+" for every list
// item kind except `application` (see _listRow() header comment) -
// deliberately built from plain Gtk controls rather than routed through
// _buildRow(), since _buildRow()'s rows all write straight through to a
// settings proxy on every keystroke/toggle (see this file's own header
// comment) and a staging value must NOT persist anywhere until "+" is
// actually clicked.
function _buildStagingControl(itemSchema) {
    const dataType = itemSchema.dataType ?? 'string';
    const fieldType = itemSchema.fieldType ??
        (dataType === 'boolean' ? 'switch' : (dataType === 'integer' || dataType === 'number') ? 'spinbutton' : 'text');

    if (fieldType === 'dropdown' || fieldType === 'radio') {
        const options = (itemSchema.options ?? []).map(opt =>
            typeof opt === 'string' ? {value: opt, label: opt} : opt);
        const model = new Gtk.StringList({strings: options.map(opt => opt.label)});
        const dropDown = new Gtk.DropDown({model, valign: Gtk.Align.CENTER});
        return {
            widget: dropDown,
            getValue: () => options[dropDown.selected]?.value,
            reset: () => {
                dropDown.selected = 0;
            },
        };
    }

    if (fieldType === 'switch' || fieldType === 'checkbox') {
        const check = new Gtk.CheckButton({valign: Gtk.Align.CENTER, active: Boolean(itemSchema.default)});
        return {
            widget: check,
            getValue: () => check.active,
            reset: () => {
                check.active = Boolean(itemSchema.default);
            },
        };
    }

    if (fieldType === 'spinbutton' || fieldType === 'slider') {
        const step = itemSchema.step ?? 1;
        const adjustment = new Gtk.Adjustment({
            value: itemSchema.default ?? 0,
            lower: itemSchema.min ?? -Number.MAX_SAFE_INTEGER,
            upper: itemSchema.max ?? Number.MAX_SAFE_INTEGER,
            step_increment: step,
        });
        // digits: explicit item.decimals wins; otherwise dataType:"integer"
        // always forces 0 (whole numbers only), and dataType:"number" falls
        // back to guessing from `step` — this is the actual per-dataType
        // behavior the input control needs, not just a step heuristic.
        const digits = itemSchema.decimals ?? (dataType === 'integer' ? 0 : Number.isInteger(step) ? 0 : 2);
        const spin = new Gtk.SpinButton({adjustment, valign: Gtk.Align.CENTER, digits});
        return {
            widget: spin,
            getValue: () => dataType === 'integer' ? Math.round(spin.get_value()) : spin.get_value(),
            reset: () => {
                spin.set_value(itemSchema.default ?? 0);
            },
        };
    }

    // text (default fallback for any other/unrecognized item fieldType)
    const entry = new Gtk.Entry({
        placeholder_text: itemSchema.placeholder ?? '',
        valign: Gtk.Align.CENTER,
    });
    return {
        widget: entry,
        getValue: () => entry.get_text(),
        reset: () => {
            entry.set_text('');
        },
    };
}

// Enumerates `directory` for `.desktop` entries, optionally narrowed to
// filenames matching `pattern` (a case-insensitive regex string) - the
// generic, declarative stand-in for URL-Chooser's own hardcoded
// `Core.autoDetectBrowsers()`. Fails soft (empty array) on a
// missing/unreadable directory or a malformed `pattern` rather than
// throwing, since this only ever runs from a button click.
function _scanApplications(directory, pattern) {
    const results = [];
    let regex = null;
    if (pattern) {
        try {
            regex = new RegExp(pattern, 'i');
        } catch (e) {
            regex = null;
        }
    }

    try {
        const dir = Gio.File.new_for_path(directory);
        const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!name.endsWith('.desktop'))
                continue;
            if (regex && !regex.test(name))
                continue;
            results.push(GLib.build_filenamev([directory, name]));
        }
    } catch (e) {
        // Directory missing/unreadable - nothing found, not an error the
        // user needs to see (the button just won't add anything).
    }

    return results;
}
