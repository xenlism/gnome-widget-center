import Adw from "gi://Adw";

import Gtk from "gi://Gtk";

import Gio from "gi://Gio";

import GLib from "gi://GLib";

export default class ClockModernWidgetPrefs {
    constructor(settings) {
        this._settings = settings;
    }
    buildPrefsWidget() {
        const page = new Adw.PreferencesPage({
            title: "Clock (Modern)"
        });
        const formatGroup = new Adw.PreferencesGroup({
            title: "Format"
        });
        page.add(formatGroup);
        formatGroup.add(this._switchRow("format24h", "24-hour format", "Off shows 12-hour time with an am/pm line above HH"));
        const fontGroup = new Adw.PreferencesGroup({
            title: "Font",
            description: "HH, MM and SS always share the same face and size below. am/pm has its own separate face and size."
        });
        page.add(fontGroup);
        fontGroup.add(this._textRow("fontFamily", "HH / MM / SS font face", "Sans Bold"));
        fontGroup.add(this._spinRow("fontSize", "HH / MM / SS font size", 8, 200, 26));
        fontGroup.add(this._textRow("ampmFontFamily", "am/pm font face", "Sans Bold"));
        fontGroup.add(this._spinRow("ampmFontSize", "am/pm font size", 6, 96, 10));
        const colorGroup = new Adw.PreferencesGroup({
            title: "Colors",
            description: "HH, MM and SS each have their own separate color."
        });
        page.add(colorGroup);
        colorGroup.add(this._colorRow("colorHH", "HH color", "#1a1a1a"));
        colorGroup.add(this._colorRow("colorMM", "MM color", "#1a1a1a"));
        colorGroup.add(this._colorRow("colorSS", "SS color", "#1a1a1a"));
        colorGroup.add(this._colorRow("colorAmPm", "am/pm color", "#d81f26"));
        colorGroup.add(this._colorRow("cardColor", "Card background color", "#ffffff"));
        const launchGroup = new Adw.PreferencesGroup({
            title: "Launch on click",
            description: "Clicking the clock (without holding Super) launches the chosen app."
        });
        page.add(launchGroup);
        launchGroup.add(this._switchRow("launchOnClick", "Launch app on click", "Requires an app to be chosen below"));
        launchGroup.add(this._desktopFileRow());
        return page;
    }
    _switchRow(key, title, subtitle) {
        const row = new Adw.SwitchRow({
            title: title,
            subtitle: subtitle,
            active: !!this._settings[key]
        });
        row.connect("notify::active", () => {
            this._settings[key] = row.active;
        });
        return row;
    }
    _textRow(key, title, fallback) {
        const row = new Adw.EntryRow({
            title: title,
            text: this._settings[key] ?? fallback
        });
        row.connect("notify::text", () => {
            this._settings[key] = row.text;
        });
        return row;
    }
    _spinRow(key, title, min, max, fallback) {
        const row = new Adw.SpinRow({
            title: title,
            adjustment: new Gtk.Adjustment({
                lower: min,
                upper: max,
                step_increment: 1,
                page_increment: 4,
                value: this._settings[key] ?? fallback
            })
        });
        row.connect("notify::value", () => {
            this._settings[key] = row.value;
        });
        return row;
    }
    _colorRow(key, title, fallback) {
        const row = new Adw.ActionRow({
            title: title
        });
        const colorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({
                with_alpha: false
            }),
            valign: Gtk.Align.CENTER
        });
        const rgba = new Gtk.RGBA;
        rgba.parse(this._settings[key] ?? fallback);
        colorButton.set_rgba(rgba);
        colorButton.connect("notify::rgba", () => {
            const c = colorButton.get_rgba();
            const toHex = v => Math.round(v * 255).toString(16).padStart(2, "0");
            this._settings[key] = `#${toHex(c.red)}${toHex(c.green)}${toHex(c.blue)}`;
        });
        row.add_suffix(colorButton);
        row.activatable_widget = colorButton;
        return row;
    }
    _desktopFileRow() {
        const currentPath = this._settings.desktopFilePath ?? "";
        const row = new Adw.ActionRow({
            title: "App to launch",
            subtitle: currentPath || "No app selected"
        });
        const browseButton = new Gtk.Button({
            label: "Browse…",
            valign: Gtk.Align.CENTER
        });
        browseButton.connect("clicked", () => {
            const dialog = new Gtk.FileDialog({
                title: "Choose an application (.desktop file)"
            });
            const desktopFilter = new Gtk.FileFilter;
            desktopFilter.set_name("Desktop entries (*.desktop)");
            desktopFilter.add_pattern("*.desktop");
            desktopFilter.add_mime_type("application/x-desktop");
            const filters = new Gio.ListStore({
                item_type: Gtk.FileFilter
            });
            filters.append(desktopFilter);
            dialog.set_filters(filters);
            dialog.set_default_filter(desktopFilter);
            const appDirs = [ GLib.build_filenamev([ GLib.get_home_dir(), ".local/share/applications" ]), "/usr/share/applications" ];
            const startDir = appDirs.find(d => Gio.File.new_for_path(d).query_exists(null));
            if (startDir) dialog.set_initial_folder(Gio.File.new_for_path(startDir));
            const parentWindow = browseButton.get_root();
            dialog.open(parentWindow, null, (_dialog, result) => {
                try {
                    const file = dialog.open_finish(result);
                    if (file) {
                        const path = file.get_path();
                        this._settings.desktopFilePath = path;
                        row.subtitle = path;
                    }
                } catch (e) {}
            });
        });
        row.add_suffix(browseButton);
        row.activatable_widget = browseButton;
        return row;
    }
}