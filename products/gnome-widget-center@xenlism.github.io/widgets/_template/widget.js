// widgets/_template/widget.js
//
// Minimal but complete implementation of the widget.js contract from
// development/docs/WIDGET_API.md. Copy this whole folder to start a new widget - the
// host discovers it automatically (bundled: extension/widgets/<id>/,
// user-installed: ~/.local/share/gnome-widget-center/widgets/<id>/), no
// core files need to change. See development/docs/PUBLISHING_A_WIDGET.md for the full
// copy -> edit -> see-it-on-the-desktop walkthrough.
//
// The only 3 files you normally need to touch to make this a real widget:
//   1. metadata.json  - change `id`/`name`/`description` (TODO markers below)
//   2. widget.js       - this file (TODO markers below)
//   3. prefs.js        - only if your widget has settings a user should edit

import St from 'gi://St';
import GLib from 'gi://GLib';

export default class TemplateWidget {
    /**
     * @param {WidgetAPI} api - see development/docs/WIDGET_API.md §5. This is the real
     *   object the host builds for every widget: api.settings is a live
     *   proxy backed by this widget's own JSON file (auto-saved on every
     *   write, see development/docs/SETTINGS_SPEC.md), api.logger is pre-tagged with
     *   this widget's id, api.position/api.bus are described in §5 too.
     */
    constructor(api) {
        this._api = api;
        // TODO: read whatever this widget needs out of api.settings here,
        // e.g. `const {refreshInterval} = api.settings;` — don't assume
        // keys exist beyond what getDefaultSettings() below promises.
    }

    // Must return a Clutter.Actor / St.Widget, and must never throw - even
    // when settings are still empty (first run, before getDefaultSettings()
    // has been merged in). If your widget isn't ready to render real data
    // yet, return a placeholder actor here and update its contents later
    // (e.g. from enable(), once a timer/signal/DBus call resolves) rather
    // than delaying buildActor() itself.
    buildActor() {
        // TODO: replace with your real UI. St.BoxLayout/St.Label/St.Icon
        // etc. behave like a restricted GTK - see existing widgets
        // (products/extension/widgets/clock, products/extension/widgets/media-player) for
        // realistic examples of layout + a settings-driven label.
        this._actor = new St.Label({
            style_class: 'template-widget-label', // TODO: rename the CSS class (see stylesheet.css) and add one if you need it
            text: 'template widget',
        });
        return this._actor;
    }

    // Called once, right after buildActor()'s result has been added to the
    // Widget Layer. This is where you start anything that needs cleanup
    // later: timers, signal connections, DBus proxies/subscriptions (see
    // development/docs/WIDGET_API.md §8 for the DBus/MPRIS pattern specifically).
    enable() {
        // TODO: delete this example timer if your widget doesn't need one.
        // Keeping the source id around is required so disable() can remove
        // it - an untracked GLib.timeout_add is a resource leak the review
        // guidelines (linked from development/docs/WIDGET_API.md §3) explicitly flag.
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._api.logger.info('template widget tick');
            return GLib.SOURCE_CONTINUE; // return SOURCE_REMOVE to stop after one run
        });
    }

    // Must undo everything enable() started - every signal connected, every
    // GLib.timeout_add/idle_add, every Gio.DBusProxy - or GNOME Shell will
    // warn/leak on every enable/disable cycle (screen lock included, since
    // that also calls disable()/enable() - see development/docs/WIDGET_API.md §3).
    disable() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        // TODO: disconnect any signals / Gio.DBusProxy subscriptions you
        // added in enable() here too.
    }

    // Defaults used the first time this widget's settings file is created
    // (merged in automatically for any key an existing settings file is
    // missing - see development/docs/SETTINGS_SPEC.md). Keep every key your widget.js
    // or prefs.js reads listed here so a fresh install never sees
    // `undefined`.
    getDefaultSettings() {
        // TODO: replace with this widget's real settings, e.g.
        // `return {refreshInterval: 60, showLabel: true};`
        return {};
    }
}
