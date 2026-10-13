import Adw from "gi://Adw";

export default class CalendarHeaderWidgetPrefs {
    constructor(settings) {
        this._settings = settings;
    }
    buildPrefsWidget() {
        const page = new Adw.PreferencesPage({
            title: "Calendar (Header)"
        });
        const group = new Adw.PreferencesGroup({
            title: "Colors"
        });
        page.add(group);
        group.add(this._colorRow("headerColor", "Header background", "Band behind month/weekday", "#2563eb"));
        group.add(this._colorRow("headerTextColor", "Header text", "Month/weekday text color", "#ffffff"));
        group.add(this._colorRow("bodyColor", "Body background", "Panel behind the day number", "#ffffff"));
        group.add(this._colorRow("dayColor", "Day number color", "Color of the day number", "#1a1a1a"));
        return page;
    }
    _colorRow(key, title, subtitle, fallback) {
        const row = new Adw.EntryRow({
            title: `${title} (${subtitle})`,
            text: this._settings[key] ?? fallback
        });
        row.connect("notify::text", () => {
            this._settings[key] = row.text;
        });
        return row;
    }
}