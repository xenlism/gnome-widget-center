// widgets/clock/prefs.js
//
// Optional prefs UI for the clock widget. Runs in the prefs (GTK4)
// process, completely separate from widget.js — must NOT import
// St/Clutter/Meta/Shell (development/docs/WIDGET_API.md §4).

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

export default class ClockWidgetPrefs {
    /**
     * @param {WidgetSettingsHandle} settings - scoped to this widget only
     */
    constructor(settings) {
        this._settings = settings;
    }

    buildPrefsWidget() {
        const page = new Adw.PreferencesPage({title: 'Clock'});
        const group = new Adw.PreferencesGroup({title: 'Clock settings'});
        page.add(group);

        group.add(this._switchRow('format24h', '24-hour format', 'Show time as 14:30 instead of 2:30 PM'));
        group.add(this._switchRow('showSeconds', 'Show seconds', 'Tick every second instead of every minute'));
        group.add(this._switchRow('showDate', 'Show date', 'Display the date below the time'));

        const fontRow = new Adw.SpinRow({
            title: 'Font size',
            subtitle: 'Size of the time text, in pixels',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 96,
                step_increment: 1,
                page_increment: 4,
                value: this._settings.fontSize ?? 32,
            }),
        });
        fontRow.connect('notify::value', () => {
            this._settings.fontSize = fontRow.value;
        });
        group.add(fontRow);

        return page;
    }

    /** @private */
    _switchRow(key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle, active: !!this._settings[key]});
        row.connect('notify::active', () => {
            this._settings[key] = row.active;
        });
        return row;
    }
}
