import Adw from "gi://Adw";

export default class CalendarModernWidgetPrefs {
    constructor(settings) {
        this._settings = settings;
    }
    buildPrefsWidget() {
        const page = new Adw.PreferencesPage({
            title: "Calendar (Modern)"
        });
        const group = new Adw.PreferencesGroup({
            title: "Colors"
        });
        page.add(group);
        group.add(this._colorRow("cardColor", "Card color", "Background of the calendar card", "#ffffff"));
        group.add(this._colorRow("accentColor", "Weekday color", "Color of the day-of-week text", "#d81f26"));
        group.add(this._colorRow("textColor", "Text color", "Color of the month and day number", "#1a1a1a"));
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