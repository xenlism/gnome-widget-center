// widgets/_template/widget.js
//
// Minimal but complete implementation of the widget.js contract from
// docs/WIDGET_API.md. Copy this whole folder to start a new widget - the
// host never needs to know this file exists ahead of time.

import St from 'gi://St';

export default class TemplateWidget {
    /**
     * @param {WidgetAPI} api - see docs/WIDGET_API.md §5. During task 01
     *   this is a stub object (real settings/position land in task 02/03).
     */
    constructor(api) {
        this._api = api;
    }

    // Must return a Clutter.Actor / St.Widget. Must never throw, even with
    // empty settings - the loader isolates failures but a working widget
    // shouldn't rely on that.
    buildActor() {
        this._actor = new St.Label({text: 'template widget'});
        return this._actor;
    }

    // Called after the actor exists. No timers/signals needed for this
    // template, but this is where a real widget would start them.
    enable() {}

    // Must undo everything enable() did. Nothing to clean up here.
    disable() {}

    // Defaults used the first time this widget's settings file is created.
    getDefaultSettings() {
        return {};
    }
}
