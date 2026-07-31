// widgets/calendar-modern/widget.js
//
// "Modern" theme calendar widget built from the widgets/_template contract
// (see widgets/_template/widget.js) using widgets/clock/widget.js's
// timer/render pattern as a reference for the enable()/disable()/_render()
// split. Block type is fixed at 10x10 per the current task spec.
//
// Shows only: Month, Day of week, Day number - deliberately no full date,
// no day-of-year, no week number, no progress indicator.
//
// NOTE: as documented in widgets/_template/stylesheet.css and
// widgets/clock/stylesheet.css, the host does not (yet) load a widget's
// own stylesheet.css into the Shell's theme context, so the actual card
// look here comes from inline St `style` strings (a small CSS-like subset
// St understands directly), not from stylesheet.css. stylesheet.css is
// still shipped as documentation/hooks per that same convention.

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

export default class CalendarModernWidget {
    /**
     * @param {WidgetAPI} api - see development/docs/WIDGET_API.md §5.
     */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
    }

    // Must never throw, even with empty settings - getDefaultSettings()
    // below always backfills cardColor/accentColor/textColor before this
    // runs, but reading with `??` fallbacks here too costs nothing.
    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: 'calendar-modern-widget-root',
            vertical: true,
        });

        this._monthLabel = new St.Label({style_class: 'calendar-modern-widget-month'});
        this._weekdayLabel = new St.Label({style_class: 'calendar-modern-widget-weekday'});
        this._dayLabel = new St.Label({style_class: 'calendar-modern-widget-day'});

        this._actor.add_child(this._monthLabel);
        this._actor.add_child(this._weekdayLabel);
        this._actor.add_child(this._dayLabel);

        this._render();
        return this._actor;
    }

    enable() {
        // Only the day number can change while the widget is alive, and
        // only at most once a minute - a 30s tick keeps that snappy
        // without polling harder than the clock widget does.
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
            accentColor: '#d81f26',
            textColor: '#1a1a1a',
        };
    }

    // Cross-process live update (see widgets/clock/widget.js for the same
    // hook): re-render immediately so a color change made in the Control
    // Center shows up right away instead of waiting for the next tick.
    onSettingsChanged() {
        this._render();
    }

    /** @private */
    _render() {
        const now = GLib.DateTime.new_now_local();

        const cardColor = this._settings.cardColor ?? '#ffffff';
        const accentColor = this._settings.accentColor ?? '#d81f26';
        const textColor = this._settings.textColor ?? '#1a1a1a';

        this._actor.set_style(
            `background-color: ${cardColor}; ` +
            'border-radius: 22px; ' +
            'padding: 18px 12px; ' +
            'spacing: 4px;'
        );

        this._monthLabel.set_text((now.format('%B') ?? '').toUpperCase());
        this._monthLabel.set_style(
            `color: ${textColor}; font-weight: bold; font-size: 20px; ` +
            'text-align: center;'
        );

        this._weekdayLabel.set_text((now.format('%A') ?? '').toUpperCase());
        this._weekdayLabel.set_style(
            `color: ${accentColor}; font-weight: bold; font-size: 14px; ` +
            'text-align: center;'
        );

        this._dayLabel.set_text(`${now.get_day_of_month()}`);
        this._dayLabel.set_style(
            `color: ${textColor}; font-weight: bold; font-size: 56px; ` +
            'text-align: center;'
        );
    }
}
