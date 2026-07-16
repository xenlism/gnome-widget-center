// widgets/clock/widget.js
//
// Task 06 — SDK example #1: a simple widget that only reads its own
// settings and a timer, no external system service (contrast with
// widgets/media-player/widget.js, the second example in this pack, which
// talks to MPRIS2). Shows the current time, updated every second (or
// every minute if `showSeconds` is off) via GLib.timeout_add_seconds —
// removed again in disable() per development/docs/WIDGET_API.md §3's MUST rules.

import St from 'gi://St';
import GLib from 'gi://GLib';

export default class ClockWidget {
    /**
     * @param {WidgetAPI} api - see development/docs/WIDGET_API.md §5.
     */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
    }

    // Must never throw, even with empty settings - getDefaultSettings()
    // below always backfills format24h/showSeconds/showDate/fontSize
    // before this runs, but reading with `??` fallbacks here too costs
    // nothing and keeps this widget robust on its own.
    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: 'clock-widget-root',
            vertical: true,
        });

        this._timeLabel = new St.Label({style_class: 'clock-widget-time'});
        this._dateLabel = new St.Label({style_class: 'clock-widget-date'});

        this._actor.add_child(this._timeLabel);
        this._actor.add_child(this._dateLabel);

        this._render();
        return this._actor;
    }

    enable() {
        const intervalSeconds = this._settings.showSeconds ? 1 : 60;
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, intervalSeconds, () => {
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
            format24h: true,
            showSeconds: false,
            showDate: true,
            fontSize: 32,
        };
    }

    /** @private */
    _render() {
        const now = GLib.DateTime.new_now_local();
        const format24h = this._settings.format24h ?? true;
        const showSeconds = this._settings.showSeconds ?? false;

        let timeFormat;
        if (format24h)
            timeFormat = showSeconds ? '%H:%M:%S' : '%H:%M';
        else
            timeFormat = showSeconds ? '%I:%M:%S %p' : '%I:%M %p';

        this._timeLabel.set_text(now.format(timeFormat) ?? '');
        this._timeLabel.set_style(`font-size: ${this._settings.fontSize ?? 32}px;`);

        if (this._settings.showDate ?? true) {
            this._dateLabel.show();
            this._dateLabel.set_text(now.format('%A, %B %-e') ?? '');
        } else {
            this._dateLabel.hide();
        }
    }
}
