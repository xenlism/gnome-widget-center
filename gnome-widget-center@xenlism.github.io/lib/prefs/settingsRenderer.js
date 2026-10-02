import Gtk from "gi://Gtk";

import Gdk from "gi://Gdk";

import Adw from "gi://Adw";

import GLib from "gi://GLib";

import Pango from "gi://Pango";

function _esc(text) {
    return GLib.markup_escape_text(String(text ?? ""), -1);
}

function _makeActionRow(field) {
    const row = new Adw.ActionRow({
        title: _esc(field.label),
        subtitle: _esc(field.hint || "")
    });
    return row;
}

function _buildFontRow(field, store) {
    const row = _makeActionRow(field);
    const button = new Gtk.FontDialogButton({
        dialog: new Gtk.FontDialog({
            title: `Choose font — ${_esc(field.label)}`
        }),
        valign: Gtk.Align.CENTER
    });
    const initial = store.get(field.key) || field.default;
    button.set_font_desc(Pango.FontDescription.from_string(initial));
    button.connect("notify::font-desc", () => {
        const desc = button.get_font_desc();
        store.set(field.key, desc.to_string());
    });
    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

function _buildColorRow(field, store) {
    const row = _makeActionRow(field);
    const dialog = new Gtk.ColorDialog({
        title: `Choose color — ${_esc(field.label)}`,
        with_alpha: !!field.useAlpha
    });
    const button = new Gtk.ColorDialogButton({
        dialog: dialog,
        valign: Gtk.Align.CENTER
    });
    const initial = store.get(field.key) || field.default;
    const rgba = new Gdk.RGBA;
    rgba.parse(initial);
    button.set_rgba(rgba);
    button.connect("notify::rgba", () => {
        const c = button.get_rgba();
        const hex = field.useAlpha ? _rgbaToHex8(c) : _rgbaToHex6(c);
        store.set(field.key, hex);
    });
    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

function _channelToHex(v) {
    return Math.round(v * 255).toString(16).padStart(2, "0");
}

function _rgbaToHex6(rgba) {
    return `#${_channelToHex(rgba.red)}${_channelToHex(rgba.green)}${_channelToHex(rgba.blue)}`;
}

function _rgbaToHex8(rgba) {
    return `${_rgbaToHex6(rgba)}${_channelToHex(rgba.alpha)}`;
}

function _buildDateRow(field, store) {
    const row = _makeActionRow(field);
    const initial = store.get(field.key);
    const button = new Gtk.MenuButton({
        valign: Gtk.Align.CENTER,
        label: initial ? _formatIsoDate(initial) : "Not set"
    });
    const calendar = new Gtk.Calendar;
    if (initial) {
        const dt = GLib.DateTime.new_from_iso8601(initial, null);
        if (dt) calendar.select_day(dt);
    }
    const popover = new Gtk.Popover({
        child: calendar
    });
    button.set_popover(popover);
    calendar.connect("day-selected", () => {
        const dt = calendar.get_date();
        const iso = dt.format("%Y-%m-%d");
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
    return dt ? dt.format("%Y-%m-%d") : iso;
}

function _buildNumberRow(field, store) {
    const row = new Adw.SpinRow({
        title: _esc(field.label),
        subtitle: _esc(field.hint || ""),
        digits: field.digits ?? 0,
        adjustment: new Gtk.Adjustment({
            lower: field.min,
            upper: field.max,
            step_increment: field.step,
            value: store.get(field.key) ?? field.default
        })
    });
    row.connect("notify::value", () => {
        store.set(field.key, row.value);
    });
    return row;
}

function _buildRangeRow(field, store) {
    const initial = store.get(field.key) ?? field.default;
    const row = _makeActionRow(field);
    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        adjustment: new Gtk.Adjustment({
            lower: field.min,
            upper: field.max,
            step_increment: field.step,
            value: initial
        }),
        digits: field.digits ?? 0,
        width_request: 160,
        valign: Gtk.Align.CENTER,
        hexpand: false
    });
    scale.set_draw_value(true);
    scale.connect("value-changed", () => {
        store.set(field.key, scale.get_value());
    });
    row.add_suffix(scale);
    return row;
}

function _buildTextRow(field, store) {
    const row = new Adw.EntryRow({
        title: _esc(field.label),
        text: store.get(field.key) ?? field.default ?? ""
    });
    if (field.hint) {
        row.set_tooltip_text(field.hint);
    }
    row.connect("changed", () => {
        store.set(field.key, row.text);
    });
    return row;
}

function _buildActionRow(field, store) {
    const row = _makeActionRow(field);
    const button = new Gtk.Button({
        label: field.buttonLabel,
        valign: Gtk.Align.CENTER
    });
    if (field.destructive) {
        button.add_css_class("destructive-action");
    }
    button.connect("clicked", () => {
        field.onActivate(store);
    });
    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

function _buildIconRow(field, store) {
    const initial = store.get(field.key) || field.default;
    const row = new Adw.EntryRow({
        title: _esc(field.label),
        text: initial
    });
    if (field.hint) {
        row.set_tooltip_text(field.hint);
    }
    const preview = new Gtk.Image({
        icon_name: initial,
        pixel_size: 24,
        valign: Gtk.Align.CENTER
    });
    row.add_prefix(preview);
    row.connect("changed", () => {
        const name = row.text.trim();
        preview.set_from_icon_name(name || null);
        store.set(field.key, name);
    });
    return row;
}

function _buildMultiOptionRow(field, store) {
    const selected = new Set(store.get(field.key) || field.default || []);
    const expander = new Adw.ExpanderRow({
        title: _esc(field.label),
        subtitle: _esc(field.hint || _summarizeSelection(selected, field.choices))
    });
    for (const choiceKey of Object.keys(field.choices)) {
        const checkRow = new Adw.ActionRow({
            title: _esc(field.choices[choiceKey])
        });
        const check = new Gtk.CheckButton({
            active: selected.has(choiceKey),
            valign: Gtk.Align.CENTER
        });
        check.connect("toggled", () => {
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
        return "None selected";
    }
    return Array.from(selectedSet).map(k => choices[k]).join(", ");
}

function _buildBooleanRow(field, store) {
    const row = new Adw.SwitchRow({
        title: _esc(field.label),
        subtitle: _esc(field.hint || ""),
        active: !!store.get(field.key)
    });
    row.connect("notify::active", () => {
        store.set(field.key, row.active);
    });
    return row;
}

function _buildOptionRow(field, store) {
    const keys = Object.keys(field.choices);
    const labels = keys.map(k => field.choices[k]);
    const row = new Adw.ComboRow({
        title: _esc(field.label),
        subtitle: _esc(field.hint || ""),
        model: Gtk.StringList.new(labels)
    });
    const currentValue = String(store.get(field.key));
    const initialIndex = keys.indexOf(currentValue);
    row.selected = initialIndex >= 0 ? initialIndex : 0;
    row.connect("notify::selected", () => {
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
    multiOption: _buildMultiOptionRow
};

export function buildGroup(schema, store, opts = {}) {
    const fallbackTitle = opts.title || schema.widgetId;
    const groupsByTitle = new Map;
    const groupsInOrder = [];
    const conditionalRows = [];
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
                title: _esc(groupTitle),
                description: field.group ? null : opts.description || null
            });
            groupsByTitle.set(groupTitle, adwGroup);
            groupsInOrder.push(adwGroup);
        }
        groupsByTitle.get(groupTitle).add(row);
        if (field.showIf) {
            conditionalRows.push({
                field: field,
                row: row
            });
        }
    }
    if (conditionalRows.length > 0) {
        store.subscribe(values => {
            for (const {field: field, row: row} of conditionalRows) {
                row.visible = values[field.showIf.key] === field.showIf.value;
            }
        });
    }
    return groupsInOrder;
}