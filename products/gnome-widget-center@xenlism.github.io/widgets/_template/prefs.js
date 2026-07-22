// widgets/_template/prefs.js
//
// Optional (see development/docs/WIDGET_API.md §4) - delete this file if your widget
// has no user-facing settings. Runs in the separate prefs (GTK4) process,
// completely apart from widget.js - do NOT import St/Clutter/Meta/Shell
// here, and don't import anything from widget.js either.

import Adw from 'gi://Adw';
// TODO: if you add rows that edit settings, you'll likely also want:
// import Gtk from 'gi://Gtk';

export default class TemplateWidgetPrefs {
    /**
     * @param {WidgetSettingsHandle} settings - scoped to this widget only;
     *   same underlying JSON file as `api.settings` in widget.js, so
     *   reading/writing here shows up live in the running widget (and
     *   vice versa) without a restart.
     */
    constructor(settings) {
        this._settings = settings;
    }

    // Must return a Gtk.Widget - Adw.PreferencesPage is recommended since
    // that's what the Control Center (products/extension/prefs.js) expects to embed.
    buildPrefsWidget() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'Template Widget', // TODO: match metadata.json's "name"
            description: 'This template has no settings yet.',
            // TODO: once getDefaultSettings() in widget.js returns real
            // keys, add one Adw.SwitchRow/Adw.SpinRow/Adw.EntryRow per key
            // here, bound to this._settings, e.g.:
            //
            //   const row = new Adw.SwitchRow({
            //       title: 'Show label',
            //       active: this._settings.showLabel,
            //   });
            //   row.connect('notify::active',
            //       () => { this._settings.showLabel = row.active; });
            //   group.add(row);
        });
        page.add(group);
        return page;
    }
}
