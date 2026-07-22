// widgets/calendar-minimal/prefs.js
//
// Prefs UI for the "Minimal" calendar widget. Runs in the separate prefs
// (GTK4) process - does NOT import St/Clutter/Meta/Shell, same rule
// widgets/clock/prefs.js follows.

import Adw from 'gi://Adw';

export default class CalendarMinimalWidgetPrefs {
    /**
     * @param {WidgetSettingsHandle} settings - scoped to this widget only.
     */
    constructor(settings) {
        this._settings = settings;
    }

    buildPrefsWidget() {
        const page = new Adw.PreferencesPage({title: 'Calendar (Minimal)'});
        const group = new Adw.PreferencesGroup({title: 'Appearance'});
        page.add(group);

        group.add(this._colorRow('textColor', 'Day number color', 'Color of the big day number', '#1a1a1a'));
        group.add(this._colorRow('accentColor', 'Subtitle color', 'Color of the weekday/month line', '#6b6b6b'));

        const showMonthRow = new Adw.SwitchRow({
            title: 'Show month',
            subtitle: 'Display the month next to the weekday',
            active: this._settings.showMonth ?? true,
        });
        showMonthRow.connect('notify::active', () => {
            this._settings.showMonth = showMonthRow.active;
        });
        group.add(showMonthRow);

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
