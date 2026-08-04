// widgets/geek-clock-date-bay/widget.js
//
// "Geek" clock + date card - a medium `3x1` card (35×11 grid cells),
// see WIDGET_API.md §2) translucent card with two centered lines:
//
//   CLOCK LINE   e.g. "14:30" or "02:30:05 PM"   (big, bold)
//   DATE LINE    e.g. "02-12-2026"                (small, optional)
//
// Shape/shell copied from widgets/geek-date-stat-bar/widget.js (card
// background + inline St `style` rendering - the host does not yet load a
// widget's own stylesheet.css into the Shell's theme context, same note as
// clock-modern/date-modern).
//
// Clock formatting uses GLib.DateTime's own %H/%I/%M/%S/%p directives
// rather than hand-rolled arithmetic, so 12/24-hour and AM/PM all come
// from the same locale-safe formatter. Date formatting is numeric
// (MM-DD-YYYY or DD-MM-YYYY) rather than a spelled-out month name, with an
// "auto" mode that guesses the convention from the system's country code
// via GLib.get_language_names() (e.g. "en_US" -> MM-DD-YYYY, everything
// else -> DD-MM-YYYY) - a widget can always override this with an
// explicit dateFormat setting.
//
// Widget-shadow (the drop shadow behind the whole card) reuses
// lib/widgetVisualKit.js's SHADOW_DEFAULTS/shadowBoxShadowCss, same as
// every other card widget. Text-shadow (the shadow drawn *under the text*
// inside the card) has no shared helper yet, so this widget builds its own
// small `text-shadow: Xpx Ypx Bpx rgba(...);` CSS fragment the same way
// (angle+distance+blur+color+opacity), just without box-shadow's spread/
// inset parameters, which text-shadow doesn't have.

import St from 'gi://St';
import GLib from 'gi://GLib';
// Imported even though only Clutter.ActorAlign.CENTER is used directly -
// St's typelib depends on Clutter's, and some import orders resolve
// Clutter earlier than others by accident (calendar-modern hit this, see
// SKILL.md "Before writing anything" table / gotchas).
import Clutter from 'gi://Clutter';
import {
    SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, toCssColor as _toCssColor,
    parseFontDescription as _parseFontDescription, TEXT_SHADOW_DEFAULTS, textShadowCss as _textShadowCss,
} from '../../lib/widgetVisualKit.js';

export default class GeekClockDateBayWidget {
    /**
     * @param {WidgetAPI} api - see development/docs/WIDGET_API.md §5.
     */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._logger = api.logger;
        this._timeoutId = null;
    }

    // Must never throw, even with empty settings - getDefaultSettings()
    // below always backfills every key this widget reads before this runs,
    // but the `??` fallbacks in _render() cost nothing and keep this
    // widget robust on its own too.
    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: 'geek-clock-date-bay-widget-root',
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._clockLabel = new St.Label({style_class: 'geek-clock-date-bay-widget-clock', x_expand: true});
        this._dateLabel = new St.Label({style_class: 'geek-clock-date-bay-widget-date', x_expand: true});

        this._actor.add_child(this._clockLabel);
        this._actor.add_child(this._dateLabel);

        this._render();
        return this._actor;
    }

    enable() {
        this._logger.info('geek-clock-date-bay enabled');
        this._render();
        this._setupTimer();
    }

    disable() {
        this._logger.info('geek-clock-date-bay disabled');
        this._destroyTimer();
    }

    getDefaultSettings() {
        return {
            ...SHADOW_DEFAULTS,
            ...TEXT_SHADOW_DEFAULTS,
            textShadowEnabled: true, textShadowDistance: 2, textShadowBlur: 4,

            clockFont: 'Sans Bold 40',
            clockColor: '#ffffff',
            clock24Hour: true,
            clockShowSeconds: false,

            dateTextEnabled: true,
            dateFont: 'Sans Bold 18',
            dateColor: '#e6e6e6',
            dateFormat: 'auto',

            textAlign: 'center',

            backgroundColor: '#1a2a33b3',
            cornerRadius: 18,
        };
    }

    // Cross-process live update (same hook as date-modern/clock-modern):
    // re-render immediately so a font/color/format change made in the
    // Control Center shows up right away, and restart the poll timer in
    // case clockShowSeconds just changed (1s tick vs 30s tick).
    onSettingsChanged() {
        this._render();
        this._destroyTimer();
        this._setupTimer();
    }

    /** @private ticks every 1s when seconds are shown, otherwise every 30s
     * (just needs to catch the minute/date rollover) - same idea as
     * widgets/clock/widget.js's showSeconds handling. */
    _setupTimer() {
        const showSeconds = this._settings.clockShowSeconds ?? false;
        const interval = showSeconds ? 1 : 30;
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._render();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /** @private */
    _destroyTimer() {
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }

    /** @private builds the GLib.DateTime format string for the clock line
     * from the 24-hour/seconds switches. %H/%I/%M/%S/%p are all
     * locale-safe GLib directives - no manual hour math needed. */
    _clockFormat() {
        const is24Hour = this._settings.clock24Hour ?? true;
        const showSeconds = this._settings.clockShowSeconds ?? false;
        if (is24Hour)
            return showSeconds ? '%H:%M:%S' : '%H:%M';
        return showSeconds ? '%I:%M:%S %p' : '%I:%M %p';
    }

    /** @private resolves 'auto' to a concrete mm-dd-yyyy/dd-mm-yyyy format
     * by checking the system's country code (the part after the
     * underscore in a locale tag like "en_US") via
     * GLib.get_language_names() - the same locale info GNOME Shell itself
     * uses. "US"-style month-first dates are the exception; everything
     * else defaults to day-first, same as most of the world. Falls back
     * to dd-mm-yyyy if the locale can't be parsed. */
    _resolveDateFormat() {
        const setting = this._settings.dateFormat ?? 'auto';
        if (setting === 'mm-dd-yyyy' || setting === 'dd-mm-yyyy')
            return setting;

        try {
            const names = GLib.get_language_names();
            for (const name of names) {
                const match = /^[a-z]{2,3}_([A-Z]{2})/.exec(name);
                if (match) {
                    const country = match[1];
                    return country === 'US' ? 'mm-dd-yyyy' : 'dd-mm-yyyy';
                }
            }
        } catch (e) {
            this._logger.info(`geek-clock-date-bay: could not detect locale country: ${e}`);
        }
        return 'dd-mm-yyyy';
    }

    /** @private */
    _render() {
        const now = GLib.DateTime.new_now_local();

        const {family: clockFontFamily, size: clockFontSize} =
            _parseFontDescription(this._settings.clockFont ?? 'Sans Bold 40', 'Sans Bold', 40);
        const {family: dateFontFamily, size: dateFontSize} =
            _parseFontDescription(this._settings.dateFont ?? 'Sans Bold 18', 'Sans Bold', 18);

        const clockColor = this._settings.clockColor ?? '#ffffff';
        const dateColor = this._settings.dateColor ?? '#e6e6e6';
        const backgroundColor = _toCssColor(this._settings.backgroundColor ?? '#1a2a33b3', '#1a2a33b3');
        const cornerRadius = this._settings.cornerRadius ?? 18;
        const textAlign = ['left', 'center', 'right'].includes(this._settings.textAlign) ? this._settings.textAlign : 'center';
        const textShadowCss = _textShadowCss(this._settings);
        const dateTextEnabled = this._settings.dateTextEnabled ?? true;

        this._actor.set_style(
            `background-color: ${backgroundColor}; ` +
            `border-radius: ${cornerRadius}px; ` +
            'padding: 14px 24px; ' +
            'spacing: 6px;' +
            _shadowBoxShadowCss(this._settings)
        );

        // Clock line, e.g. "14:30" / "02:30:05 PM" depending on the
        // 24-hour and seconds switches.
        const clockText = now.format(this._clockFormat()) ?? '';
        this._clockLabel.set_text(clockText);
        this._clockLabel.set_style(
            `color: ${clockColor}; font-family: ${clockFontFamily}; ` +
            `font-size: ${clockFontSize}px; font-weight: bold; text-align: ${textAlign}; ` +
            `${textShadowCss}`
        );

        // Date line, e.g. "02-12-2026" - numeric MM-DD-YYYY or DD-MM-YYYY,
        // resolved from the dateFormat setting ('auto' picks by country).
        // Hidden entirely (not just blanked) when dateTextEnabled is off,
        // so it doesn't reserve empty vertical space in the card.
        this._dateLabel.visible = dateTextEnabled;
        if (dateTextEnabled) {
            const dateFormat = this._resolveDateFormat();
            const dateText = dateFormat === 'mm-dd-yyyy'
                ? (now.format('%m-%d-%Y') ?? '')
                : (now.format('%d-%m-%Y') ?? '');
            this._dateLabel.set_text(dateText);
            this._dateLabel.set_style(
                `color: ${dateColor}; font-family: ${dateFontFamily}; ` +
                `font-size: ${dateFontSize}px; text-align: ${textAlign}; ` +
                `${textShadowCss}`
            );
        }
    }
}
