/**
 * prefs/settingsRenderer.js
 *
 * Turns a widget's settings schema (from settingsApi.js) into real
 * Adw.PreferencesGroup rows inside prefs.js, wired directly to a
 * SettingsStore so changes save + live-reload immediately.
 *
 * Usage from prefs.js:
 *
 *   import {buildGroup} from './lib/settingsRenderer.js';
 *   import {SettingsStore} from './lib/settingsStore.js';
 *
 *   const store = new SettingsStore(widgetId, schema.fields);
 *   for (const group of buildGroup(schema, store, { title: 'Clock Widget' }))
 *       preferencesPage.add(group);
 *
 * Requires GTK 4.10+ / libadwaita 1.4+ for Gtk.ColorDialogButton,
 * Gtk.FontDialogButton and Adw.SwitchRow. Falls back to legacy
 * Gtk.ColorButton / Gtk.FontButton where noted if you're targeting
 * older GNOME.
 *
 * 2026-07-28: converted from the legacy `imports.gi` global style to
 * plain ESM (`import`/`export`) so this can actually be imported by
 * prefs.js — see WIDGET_API.md §6.3.
 */

import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

function _makeActionRow(field) {
    const row = new Adw.ActionRow({
        title: field.label,
        subtitle: field.hint || null,
    });
    return row;
}

/** font: setFont() */
function _buildFontRow(field, store) {
    const row = _makeActionRow(field);

    const button = new Gtk.FontDialogButton({
        dialog: new Gtk.FontDialog({ title: `Choose font — ${field.label}` }),
        valign: Gtk.Align.CENTER,
    });

    const initial = store.get(field.key) || field.default;
    button.set_font_desc(Pango.FontDescription.from_string(initial));

    button.connect('notify::font-desc', () => {
        const desc = button.get_font_desc();
        store.set(field.key, desc.to_string());
    });

    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

/** color: setColor() */
function _buildColorRow(field, store) {
    const row = _makeActionRow(field);

    const dialog = new Gtk.ColorDialog({
        title: `Choose color — ${field.label}`,
        with_alpha: !!field.useAlpha,
    });
    const button = new Gtk.ColorDialogButton({
        dialog,
        valign: Gtk.Align.CENTER,
    });

    const initial = store.get(field.key) || field.default;
    const rgba = new Gdk.RGBA();
    rgba.parse(initial);
    button.set_rgba(rgba);

    button.connect('notify::rgba', () => {
        const c = button.get_rgba();
        const hex = field.useAlpha
            ? _rgbaToHex8(c)
            : _rgbaToHex6(c);
        store.set(field.key, hex);
    });

    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

function _channelToHex(v) {
    return Math.round(v * 255).toString(16).padStart(2, '0');
}

function _rgbaToHex6(rgba) {
    return `#${_channelToHex(rgba.red)}${_channelToHex(rgba.green)}${_channelToHex(rgba.blue)}`;
}

function _rgbaToHex8(rgba) {
    return `${_rgbaToHex6(rgba)}${_channelToHex(rgba.alpha)}`;
}

/** date: setDate() — GTK4 has no built-in date button, so we pair a
 *  label + button that opens a Gtk.Calendar in a popover. */
function _buildDateRow(field, store) {
    const row = _makeActionRow(field);

    const initial = store.get(field.key); // ISO string or null
    const button = new Gtk.MenuButton({
        valign: Gtk.Align.CENTER,
        label: initial ? _formatIsoDate(initial) : 'Not set',
    });

    const calendar = new Gtk.Calendar();
    if (initial) {
        const dt = GLib.DateTime.new_from_iso8601(initial, null);
        if (dt) calendar.select_day(dt);
    }

    const popover = new Gtk.Popover({ child: calendar });
    button.set_popover(popover);

    calendar.connect('day-selected', () => {
        const dt = calendar.get_date();
        const iso = dt.format('%Y-%m-%d');
        store.set(field.key, iso);
        button.label = _formatIsoDate(iso);
        popover.popdown();
    });

    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

function _formatIsoDate(iso) {
    const dt = GLib.DateTime.new_from_iso8601(`${iso}T00:00:00Z`, null);
    return dt ? dt.format('%Y-%m-%d') : iso;
}

/** number: setNumber() — precise input with steppers */
function _buildNumberRow(field, store) {
    const row = new Adw.SpinRow({
        title: field.label,
        subtitle: field.hint || null,
        digits: field.digits ?? 0,
        adjustment: new Gtk.Adjustment({
            lower: field.min,
            upper: field.max,
            step_increment: field.step,
            value: store.get(field.key) ?? field.default,
        }),
    });

    row.connect('notify::value', () => {
        store.set(field.key, row.value);
    });

    return row;
}

/** range: setRange() — slider, for "feel"-based values */
function _buildRangeRow(field, store) {
    const initial = store.get(field.key) ?? field.default;
    const row = _makeActionRow(field);

    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        adjustment: new Gtk.Adjustment({
            lower: field.min,
            upper: field.max,
            step_increment: field.step,
            value: initial,
        }),
        digits: field.digits ?? 0,
        width_request: 160,
        valign: Gtk.Align.CENTER,
        hexpand: false,
    });
    scale.set_draw_value(true);

    scale.connect('value-changed', () => {
        store.set(field.key, scale.get_value());
    });

    row.add_suffix(scale);
    return row;
}

/** text: setText() */
function _buildTextRow(field, store) {
    const row = new Adw.EntryRow({
        title: field.label,
        text: store.get(field.key) ?? field.default ?? '',
    });
    if (field.hint) {
        row.set_tooltip_text(field.hint);
    }

    row.connect('changed', () => {
        store.set(field.key, row.text);
    });

    return row;
}

/** action: setAction() — triggers a callback, stores nothing itself */
function _buildActionRow(field, store) {
    const row = _makeActionRow(field);

    const button = new Gtk.Button({
        label: field.buttonLabel,
        valign: Gtk.Align.CENTER,
    });
    if (field.destructive) {
        button.add_css_class('destructive-action');
    }

    button.connect('clicked', () => {
        field.onActivate(store);
    });

    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

/** icon: setIcon() — text entry + live icon preview */
function _buildIconRow(field, store) {
    const initial = store.get(field.key) || field.default;

    const row = new Adw.EntryRow({
        title: field.label,
        text: initial,
    });
    if (field.hint) {
        row.set_tooltip_text(field.hint);
    }

    const preview = new Gtk.Image({
        icon_name: initial,
        pixel_size: 24,
        valign: Gtk.Align.CENTER,
    });
    row.add_prefix(preview);

    row.connect('changed', () => {
        const name = row.text.trim();
        preview.set_from_icon_name(name || null);
        store.set(field.key, name);
    });

    return row;
}

/** multiOption: setMultiOption() — checklist inside an expander */
function _buildMultiOptionRow(field, store) {
    const selected = new Set(store.get(field.key) || field.default || []);

    const expander = new Adw.ExpanderRow({
        title: field.label,
        subtitle: field.hint || _summarizeSelection(selected, field.choices),
    });

    for (const choiceKey of Object.keys(field.choices)) {
        const checkRow = new Adw.ActionRow({ title: field.choices[choiceKey] });
        const check = new Gtk.CheckButton({
            active: selected.has(choiceKey),
            valign: Gtk.Align.CENTER,
        });

        check.connect('toggled', () => {
            if (check.active) {
                selected.add(choiceKey);
            } else {
                selected.delete(choiceKey);
            }
            store.set(field.key, Array.from(selected));
            expander.subtitle = _summarizeSelection(selected, field.choices);
        });

        checkRow.add_suffix(check);
        checkRow.activatable_widget = check;
        expander.add_row(checkRow);
    }

    return expander;
}

function _summarizeSelection(selectedSet, choices) {
    if (selectedSet.size === 0) {
        return 'None selected';
    }
    return Array.from(selectedSet).map((k) => choices[k]).join(', ');
}

/** boolean: setBoolean() */
function _buildBooleanRow(field, store) {
    const row = new Adw.SwitchRow({
        title: field.label,
        subtitle: field.hint || null,
        active: !!store.get(field.key),
    });

    row.connect('notify::active', () => {
        store.set(field.key, row.active);
    });

    return row;
}

/** option: option() dropdown */
function _buildOptionRow(field, store) {
    const keys = Object.keys(field.choices);
    const labels = keys.map((k) => field.choices[k]);

    const row = new Adw.ComboRow({
        title: field.label,
        subtitle: field.hint || null,
        model: Gtk.StringList.new(labels),
    });

    const currentValue = String(store.get(field.key));
    const initialIndex = keys.indexOf(currentValue);
    row.selected = initialIndex >= 0 ? initialIndex : 0;

    row.connect('notify::selected', () => {
        const selectedKey = keys[row.selected];
        store.set(field.key, selectedKey);
    });

    return row;
}

const BUILDERS = {
    font: _buildFontRow,
    color: _buildColorRow,
    date: _buildDateRow,
    boolean: _buildBooleanRow,
    option: _buildOptionRow,
    number: _buildNumberRow,
    range: _buildRangeRow,
    text: _buildTextRow,
    action: _buildActionRow,
    icon: _buildIconRow,
    multiOption: _buildMultiOptionRow,
};

/**
 * Builds fully-wired Adw.PreferencesGroup(s) for a widget's settings schema.
 *
 * Fields declared under the same `.group('Title')` are rendered together
 * in one Adw.PreferencesGroup; fields with no group fall back to
 * `opts.title` (or the widget id). Fields using `.showIf(key, value)`
 * automatically show/hide as `key`'s value changes, via store.subscribe().
 *
 * NOTE: returns an ARRAY of groups (not a single group), since a widget's
 * settings may now be split into multiple sections. Add each one to the
 * preferences page:
 *
 *   for (const group of GwcSettingsRenderer.buildGroup(schema, store, opts)) {
 *       preferencesPage.add(group);
 *   }
 *
 * @param {{widgetId: string, fields: SettingField[]}} schema
 * @param {SettingsStore} store
 * @param {{title?: string, description?: string}} [opts]
 * @returns {Adw.PreferencesGroup[]}
 */
export function buildGroup(schema, store, opts = {}) {
    const fallbackTitle = opts.title || schema.widgetId;
    const groupsByTitle = new Map();
    const groupsInOrder = [];
    const conditionalRows = []; // [{ field, row }]

    for (const field of schema.fields) {
        const build = BUILDERS[field.type];
        if (!build) {
            logError(new Error(`[gwc.settingsRenderer] No renderer for field type "${field.type}"`));
            continue;
        }

        const row = build(field, store);
        const groupTitle = field.group || fallbackTitle;

        if (!groupsByTitle.has(groupTitle)) {
            const adwGroup = new Adw.PreferencesGroup({
                title: groupTitle,
                // Only show the top-level description on the fallback
                // group, so it doesn't repeat under every custom section.
                description: field.group ? null : (opts.description || null),
            });
            groupsByTitle.set(groupTitle, adwGroup);
            groupsInOrder.push(adwGroup);
        }

        groupsByTitle.get(groupTitle).add(row);

        if (field.showIf) {
            conditionalRows.push({ field, row });
        }
    }

    if (conditionalRows.length > 0) {
        store.subscribe((values) => {
            for (const { field, row } of conditionalRows) {
                row.visible = values[field.showIf.key] === field.showIf.value;
            }
        });
    }

    return groupsInOrder;
}
