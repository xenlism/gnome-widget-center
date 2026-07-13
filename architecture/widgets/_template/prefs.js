// widgets/_template/prefs.js
//
// Optional. Runs in the prefs (GTK4) process, completely separate from
// widget.js - must NOT import St/Clutter/Meta/Shell here.

import Adw from 'gi://Adw';

export default class TemplateWidgetPrefs {
    /**
     * @param {WidgetSettingsHandle} settings - scoped to this widget only
     */
    constructor(settings) {
        this._settings = settings;
    }

    buildPrefsWidget() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'Template Widget',
            description: 'This template has no settings yet.',
        });
        page.add(group);
        return page;
    }
}
