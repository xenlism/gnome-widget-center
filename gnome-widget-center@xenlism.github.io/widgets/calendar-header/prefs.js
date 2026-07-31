// widgets/calendar-header/prefs.js
//
// Prefs UI for the "Header" calendar widget. Runs in the separate prefs
// (GTK4) process - does NOT import St/Clutter/Meta/Shell, same rule
// widgets/clock/prefs.js follows.

import Adw from 'gi://Adw';

export default class CalendarHeaderWidgetPrefs {
    /**
     * @param {WidgetSettingsHandle} settings - scoped to this widget only.
     */
    constructor(settings) {
        this._settings = settings;
    }

    buildPrefsWidget() {
        const page = new Adw.PreferencesPage({title: 'Calendar (Header)'});
        const group = new Adw.PreferencesGroup({title: 'Colors'});
        page.add(group);

        group.add(this._colorRow('headerColor', 'Header background', 'Band behind month/weekday', '#2563eb'));
        group.add(this._colorRow('headerTextColor', 'Header text', 'Month/weekday text color', '#ffffff'));
        group.add(this._colorRow('bodyColor', 'Body background', 'Panel behind the day number', '#ffffff'));
        group.add(this._colorRow('dayColor', 'Day number color', 'Color of the day number', '#1a1a1a'));

        return page;
    }

    /** @private */
    _colorRow(key, title, subtitle, fallback) {
        const row = new Adw.EntryRow({
            title: `${title} (${subtitle})`,
            text: this._settings[key] ?? fallback,
        });
        row.connect('notify::text', () => {
            this._settings[key] = row.text;
        });
        return row;
    }
}
