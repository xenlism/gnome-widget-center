// widgets/calendar-header/widget.js
//
// "Header" theme calendar widget built from the widgets/_template
// contract (see widgets/_template/widget.js), reusing widgets/clock's
// timer/render split. Block type is fixed at 10x10 per the current task
// spec.
//
// Layout: a colored header band holds Month + Day of week, and a plain
// body section below holds the (large) Day number. Deliberately no full
// date, no day-of-year, no week number, no progress indicator.
//
// NOTE: same stylesheet.css caveat as widgets/clock and
// widgets/_template - the host does not (yet) load a widget's own
// stylesheet.css into the Shell's theme context, so the actual two-tone
// look here comes from inline St `style` strings, not stylesheet.css.
//
// Built on GjsKit (lib/gjskit) rather than raw St - see
// development/docs/WIDGET_API.md and development/widgetapi-handover.md.
// This widget used to hardcode its own WIDGET_WIDTH/HEIGHT + clip_to_
// allocation to fix an overflow bug (2026-07-22, see screenshot in that
// handover), but that pattern doesn't scale: every widget author would
// have to remember to do it correctly themselves. WidgetLoader now
// enforces the metadata.json `block-type` -> pixel size (and clipping)
// on every widget's root actor centrally, right after buildActor()
// returns, using the exact same GjsKit size()/clip() methods - so
// nothing widget-specific needs to happen here anymore.

// 2026-07-22: explicit Clutter import kept after a reported
// "constructor threw: Clutter is not defined" runtime error when this
// widget was loaded via widgetLoader.js's dynamic import(). St's own
// typelib depends on Clutter's; this import forces Clutter's GI
// repository to be registered before St is touched in this module's own
// dynamic-import scope (including inside GjsKit's own st/index.js),
// which existing bundled widgets never hit because they were already
// resolved earlier in the same process.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import {$} from '../../lib/gjskit/st/index.js';

export default class CalendarHeaderWidget {
    /**
     * @param {WidgetAPI} api - see development/docs/WIDGET_API.md §5.
     */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
    }

    buildActor() {
        const root = $.box({style_class: 'calendar-header-widget-root', vertical: true});

        const header = $.box({style_class: 'calendar-header-widget-header', vertical: true});
        const monthLabel = $.label({style_class: 'calendar-header-widget-month'});
        const weekdayLabel = $.label({style_class: 'calendar-header-widget-weekday'});
        header.append(monthLabel).append(weekdayLabel);

        const body = $.box({style_class: 'calendar-header-widget-body', vertical: true});
        const dayLabel = $.label({style_class: 'calendar-header-widget-day'});
        body.append(dayLabel);

        root.append(header).append(body);

        // .raw: keep plain St actor refs around for _render()'s inline
        // set_style()/set_text() calls - GjsKit's fluent wrappers cover
        // construction/composition, not arbitrary CSS strings.
        this._actor = root.raw;
        this._header = header.raw;
        this._monthLabel = monthLabel.raw;
        this._weekdayLabel = weekdayLabel.raw;
        this._body = body.raw;
        this._dayLabel = dayLabel.raw;

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
            headerColor: '#2563eb',
            headerTextColor: '#ffffff',
            bodyColor: '#ffffff',
            dayColor: '#1a1a1a',
        };
    }

    onSettingsChanged() {
        this._render();
    }

    /** @private */
    _render() {
        const now = GLib.DateTime.new_now_local();

        const headerColor = this._settings.headerColor ?? '#2563eb';
        const headerTextColor = this._settings.headerTextColor ?? '#ffffff';
        const bodyColor = this._settings.bodyColor ?? '#ffffff';
        const dayColor = this._settings.dayColor ?? '#1a1a1a';

        this._actor.set_style(
            'border-radius: 22px; ' +
            'spacing: 0px;'
        );

        this._header.set_style(
            `background-color: ${headerColor}; ` +
            'border-radius: 22px 22px 0 0; ' +
            'padding: 14px 12px 10px 12px; ' +
            'spacing: 2px;'
        );

        this._monthLabel.set_text((now.format('%B') ?? '').toUpperCase());
        this._monthLabel.set_style(
            `color: ${headerTextColor}; font-weight: bold; font-size: 14px; ` +
            'text-align: center;'
        );

        this._weekdayLabel.set_text((now.format('%A') ?? '').toUpperCase());
        this._weekdayLabel.set_style(
            `color: ${headerTextColor}; font-weight: bold; font-size: 18px; ` +
            'text-align: center;'
        );

        this._body.set_style(
            `background-color: ${bodyColor}; ` +
            'border-radius: 0 0 22px 22px; ' +
            'padding: 14px 12px;'
        );

        this._dayLabel.set_text(`${now.get_day_of_month()}`);
        this._dayLabel.set_style(
            `color: ${dayColor}; font-weight: bold; font-size: 56px; ` +
            'text-align: center;'
        );
    }
}
