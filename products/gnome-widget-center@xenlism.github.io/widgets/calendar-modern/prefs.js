// widgets/calendar-modern/prefs.js
//
// Prefs UI for the "Modern" calendar widget. Runs in the separate prefs
// (GTK4) process - does NOT import St/Clutter/Meta/Shell, same rule
// widgets/clock/prefs.js follows.

import Adw from 'gi://Adw';

export default class CalendarModernWidgetPrefs {
    /**
     * @param {WidgetSettingsHandle} settings - scoped to this widget only.
     */
    constructor(settings) {
        this._settings = settings;
    }

    buildPrefsWidget() {
        const page = new Adw.PreferencesPage({title: 'Calendar (Modern)'});
        const group = new Adw.PreferencesGroup({title: 'Colors'});
        page.add(group);

        group.add(this._colorRow('cardColor', 'Card color', 'Background of the calendar card', '#ffffff'));
        group.add(this._colorRow('accentColor', 'Weekday color', 'Color of the day-of-week text', '#d81f26'));
        group.add(this._colorRow('textColor', 'Text color', 'Color of the month and day number', '#1a1a1a'));

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
