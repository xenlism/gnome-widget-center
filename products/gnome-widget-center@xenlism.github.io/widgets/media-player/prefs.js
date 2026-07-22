// widgets/media-player/prefs.js
//
// Optional prefs UI for the media-player widget. Runs in the prefs
// (GTK4) process, completely separate from widget.js — must NOT import
// St/Clutter/Meta/Shell (development/docs/WIDGET_API.md §4).

import Adw from 'gi://Adw';

export default class MediaPlayerWidgetPrefs {
    /**
     * @param {WidgetSettingsHandle} settings - scoped to this widget only
     */
    constructor(settings) {
        this._settings = settings;
    }

    buildPrefsWidget() {
        const page = new Adw.PreferencesPage({title: 'Media Player'});
        const group = new Adw.PreferencesGroup({title: 'Media Player settings'});
        page.add(group);

        group.add(this._switchRow('showArtwork', 'Show artwork',
            'Display the album/track art reported by the media player'));
        group.add(this._switchRow('compactMode', 'Compact mode',
            'Hide the Previous/Next buttons, keep only Play/Pause'));

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
