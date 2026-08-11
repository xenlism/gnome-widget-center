import Adw from "gi://Adw";

import Gtk from "gi://Gtk";

import Gdk from "gi://Gdk";

import Pango from "gi://Pango";

import GLib from "gi://GLib";

function _esc(text) {
    return GLib.markup_escape_text(String(text ?? ""), -1);
}

export function buildSettingsPage(schema, settingsProxy, title) {
    const page = new Adw.PreferencesPage({
        title: title
    });
    const group = new Adw.PreferencesGroup;
    page.add(group);
    for (const field of schema) group.add(_buildRow(field, settingsProxy));
    return page;
}

function _buildRow(field, settingsProxy) {
    const current = field.id in settingsProxy ? settingsProxy[field.id] : field.default;
    switch (field.type) {
      case "string":
        return _stringRow(field, settingsProxy, current);

      case "number":
        return _numberRow(field, settingsProxy, current);

      case "range":
        return _rangeRow(field, settingsProxy, current);

      case "boolean":
        return _booleanRow(field, settingsProxy, current);

      case "dropdown":
        return _dropdownRow(field, settingsProxy, current);

      case "color":
        return _colorRow(field, settingsProxy, current);

      case "size":
        return _sizeRow(field, settingsProxy, current);

      case "font":
        return _fontRow(field, settingsProxy, current);

      default:
        return new Adw.ActionRow({
            title: _esc(field.label ?? field.id),
            subtitle: `Unknown setting type "${field.type}"`,
            sensitive: false
        });
    }
}

function _stringRow(field, settingsProxy, current) {
    const row = new Adw.EntryRow({
        title: _esc(field.label),
        text: String(current ?? "")
    });
    if (field.description) row.set_tooltip_text(field.description);
    row.connect("notify::text", () => {
        settingsProxy[field.id] = row.text;
    });
    return row;
}

function _numberRow(field, settingsProxy, current) {
    const adjustment = new Gtk.Adjustment({
        lower: -Number.MAX_SAFE_INTEGER,
        upper: Number.MAX_SAFE_INTEGER,
        step_increment: 1,
        value: current
    });
    const row = new Adw.SpinRow({
        title: _esc(field.label),
        adjustment: adjustment
    });
    if (field.description) row.set_tooltip_text(field.description);
    row.connect("notify::value", () => {
        settingsProxy[field.id] = row.value;
    });
    return row;
}

function _rangeRow(field, settingsProxy, current) {
    const step = field.step ?? 1;
    const adjustment = new Gtk.Adjustment({
        lower: field.min,
        upper: field.max,
        step_increment: step,
        value: current
    });
    const row = new Adw.SpinRow({
        title: _esc(field.label),
        subtitle: `${field.min}–${field.max}`,
        adjustment: adjustment,
        digits: Number.isInteger(step) ? 0 : 2
    });
    if (field.description) row.set_tooltip_text(field.description);
    row.connect("notify::value", () => {
        settingsProxy[field.id] = row.value;
    });
    return row;
}

function _booleanRow(field, settingsProxy, current) {
    const row = new Adw.SwitchRow({
        title: _esc(field.label),
        active: Boolean(current)
    });
    if (field.description) row.set_subtitle(_esc(field.description));
    row.connect("notify::active", () => {
        settingsProxy[field.id] = row.active;
    });
    return row;
}

function _dropdownRow(field, settingsProxy, current) {
    const options = field.options.map(opt => typeof opt === "string" ? {
        value: opt,
        label: opt
    } : opt);
    const model = new Gtk.StringList({
        strings: options.map(opt => opt.label)
    });
    const row = new Adw.ComboRow({
        title: _esc(field.label),
        model: model
    });
    if (field.description) row.set_tooltip_text(field.description);
    const currentIndex = options.findIndex(opt => opt.value === current);
    row.selected = currentIndex >= 0 ? currentIndex : 0;
    row.connect("notify::selected", () => {
        settingsProxy[field.id] = options[row.selected]?.value;
    });
    return row;
}

function _colorRow(field, settingsProxy, current) {
    const row = new Adw.ActionRow({
        title: _esc(field.label)
    });
    if (field.description) row.set_subtitle(_esc(field.description));
    const rgba = new Gdk.RGBA;
    rgba.parse(typeof current === "string" ? current : String(field.default));
    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog,
        rgba: rgba,
        valign: Gtk.Align.CENTER
    });
    button.connect("notify::rgba", () => {
        settingsProxy[field.id] = button.rgba.to_string();
    });
    row.add_suffix(button);
    row.set_activatable_widget(button);
    return row;
}

function _sizeRow(field, settingsProxy, current) {
    const hasBounds = typeof field.min === "number" && typeof field.max === "number";
    const adjustment = new Gtk.Adjustment({
        lower: hasBounds ? field.min : 0,
        upper: hasBounds ? field.max : 1e4,
        step_increment: field.step ?? 1,
        value: current
    });
    const row = new Adw.SpinRow({
        title: _esc(field.label),
        subtitle: hasBounds ? `${field.min}–${field.max} px` : "px",
        adjustment: adjustment,
        digits: Number.isInteger(field.step ?? 1) ? 0 : 2
    });
    if (field.description) row.set_tooltip_text(field.description);
    row.connect("notify::value", () => {
        settingsProxy[field.id] = row.value;
    });
    return row;
}

function _fontRow(field, settingsProxy, current) {
    const row = new Adw.ActionRow({
        title: _esc(field.label)
    });
    if (field.description) row.set_subtitle(_esc(field.description));
    const button = new Gtk.FontDialogButton({
        dialog: new Gtk.FontDialog,
        valign: Gtk.Align.CENTER
    });
    const fallback = typeof field.default === "string" && field.default.length > 0 ? field.default : "Sans 10";
    const initial = typeof current === "string" && current.length > 0 ? current : fallback;
    try {
        button.set_font_desc(Pango.FontDescription.from_string(initial));
    } catch (e) {
        button.set_font_desc(Pango.FontDescription.from_string(fallback));
    }
    button.connect("notify::font-desc", () => {
        const desc = button.get_font_desc();
        if (!desc) return;
        settingsProxy[field.id] = desc.to_string();
    });
    row.add_suffix(button);
    row.set_activatable_widget(button);
    return row;
}