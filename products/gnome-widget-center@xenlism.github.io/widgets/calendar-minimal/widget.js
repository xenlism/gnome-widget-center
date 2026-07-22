// widgets/calendar-minimal/widget.js
//
// "Minimal" theme calendar widget built from the widgets/_template
// contract (see widgets/_template/widget.js), reusing widgets/clock's
// timer/render split. Block type is fixed at 10x10 per the current task
// spec.
//
// No card background, no border, no chrome at all - just the day number
// (dominant), with weekday + month as a small subtitle. Deliberately no
// full date, no day-of-year, no week number, no progress indicator.
// `showMonth` lets the month line be hidden entirely for an even more
// minimal look.
//
// NOTE: same stylesheet.css caveat as widgets/clock and
// widgets/_template - the host does not (yet) load a widget's own
// stylesheet.css into the Shell's theme context, so the actual look here
// comes from inline St `style` strings, not stylesheet.css.

// 2026-07-22: explicit Clutter import added after a reported
// "constructor threw: Clutter is not defined" runtime error when this
// widget was loaded via widgetLoader.js's dynamic import(). St's own
// typelib depends on Clutter's; this import forces Clutter's GI
// repository to be registered before St is touched in this module's own
// dynamic-import scope, which existing bundled widgets never hit
// because they were already resolved earlier in the same process.
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';

export default class CalendarMinimalWidget {
    /**
     * @param {WidgetAPI} api - see development/docs/WIDGET_API.md §5.
     */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
    }

    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: 'calendar-minimal-widget-root',
            vertical: true,
        });

        this._dayLabel = new St.Label({style_class: 'calendar-minimal-widget-day'});
        this._subtitleLabel = new St.Label({style_class: 'calendar-minimal-widget-subtitle'});

        this._actor.add_child(this._dayLabel);
        this._actor.add_child(this._subtitleLabel);

        this._render();
        return this._actor;
    }

    enable() {
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._render();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }

    getDefaultSettings() {
        return {
            cardColor: '#ffffff',
            textColor: '#1a1a1a',
            accentColor: '#d81f26',
            showMonth: true,
        };
    }

    onSettingsChanged() {
        this._render();
    }

    /** @private */
    _render() {
        const now = GLib.DateTime.new_now_local();
        const cardColor = this._settings.cardColor ?? '#ffffff';
        const textColor = this._settings.textColor ?? '#1a1a1a';
        const accentColor = this._settings.accentColor ?? '#6b6b6b';
        const showMonth = this._settings.showMonth ?? true;

        this._actor.set_style(
            'border-radius: 22px; ' +
            'padding: 18px 12px; ' +
            'spacing: 4px;'
        );

        this._dayLabel.set_text(`${now.get_day_of_month()}`);
        this._dayLabel.set_style(
            `color: ${textColor}; font-weight: 300; font-size: 64px; ` +
            'text-align: center;'
        );

        const weekday = (now.format('%A') ?? '').toUpperCase();
        const month = (now.format('%B') ?? '').toUpperCase();
        this._subtitleLabel.set_text(showMonth ? `${weekday} · ${month}` : weekday);
        this._subtitleLabel.set_style(
            `color: ${accentColor}; font-weight: bold; font-size: 12px; ` +
            'text-align: center;'
        );
    }
}
