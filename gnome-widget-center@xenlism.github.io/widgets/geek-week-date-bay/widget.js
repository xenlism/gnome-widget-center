// widgets/geek-week-date-bay/widget.js
//
// "Geek" week + date card - a medium `3x1` card (35×11 grid cells),
// see WIDGET_API.md §2) translucent card with two centered lines:
//
//   TOP LINE     e.g. "THURSDAY"   (big, bold, uppercase)
//   BOTTOM LINE  e.g. "02 DECEMBER 2026"   (small, centered)
//
// Shape/shell copied from widgets/geek-date-stat-bar/widget.js (card
// background + inline St `style` rendering - the host does not yet load a
// widget's own stylesheet.css into the Shell's theme context, same note as
// clock-modern/date-modern).
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
    cardStyleCss as _cardStyleCss, BORDER_DEFAULTS, OPACITY_DEFAULTS,
} from '../../lib/widgetVisualKit.js';

export default class GeekWeekDateBayWidget {
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
            style_class: 'geek-week-date-bay-widget-root',
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._topLabel = new St.Label({style_class: 'geek-week-date-bay-widget-top', x_expand: true});
        this._bottomLabel = new St.Label({style_class: 'geek-week-date-bay-widget-bottom', x_expand: true});

        this._actor.add_child(this._topLabel);
        this._actor.add_child(this._bottomLabel);

        this._render();
        return this._actor;
    }

    enable() {
        this._logger.info('geek-week-date-bay enabled');
        this._render();
        this._setupTimer();
    }

    disable() {
        this._logger.info('geek-week-date-bay disabled');
        this._destroyTimer();
    }

    getDefaultSettings() {
        return {
            ...SHADOW_DEFAULTS,
            ...TEXT_SHADOW_DEFAULTS,
            textShadowEnabled: true, textShadowDistance: 2, textShadowBlur: 4,

            weekFont: 'Sans Bold 32',
            weekColor: '#ffffff',
            dateFont: 'Sans Bold 16',
            dateColor: '#e6e6e6',

            backgroundColor: '#FFFFFF00',
            textAlign: 'center',
            cornerRadius: 18,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
        };
    }

    // Cross-process live update (same hook as date-modern/clock-modern):
    // re-render immediately so a font/color change made in the
    // Control Center shows up right away.
    onSettingsChanged() {
        this._render();
        this._destroyTimer();
        this._setupTimer();
    }

    /** @private fixed 60s refresh (no configurable interval - there's no
     * fast-changing data here, just catching the date/weekday rollover at
     * midnight, same fixed interval as widgets/date-modern/widget.js). */
    _setupTimer() {
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
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

    /** @private */
    _render() {
        const now = GLib.DateTime.new_now_local();

        const {family: weekFontFamily, size: weekFontSize} =
            _parseFontDescription(this._settings.weekFont ?? 'Sans Bold 32', 'Sans Bold', 32);
        const {family: dateFontFamily, size: dateFontSize} =
            _parseFontDescription(this._settings.dateFont ?? 'Sans Bold 16', 'Sans Bold', 16);

        const weekColor = this._settings.weekColor ?? '#ffffff';
        const dateColor = this._settings.dateColor ?? '#e6e6e6';
        const textAlign = ['left', 'center', 'right'].includes(this._settings.textAlign) ? this._settings.textAlign : 'center';
        const textShadowCss = _textShadowCss(this._settings);

        this._actor.set_style(
            _cardStyleCss(this._settings, {cornerRadiusFallback: 18}) +
            'padding: 14px 24px; ' +
            'spacing: 5px;'
        );

        const topText = (now.format('%A') ?? '').toUpperCase();
        this._topLabel.set_text(topText);
        this._topLabel.set_style(
            `color: ${weekColor}; font-family: ${weekFontFamily}; ` +
            `font-size: ${weekFontSize}px; font-weight: bold; text-align: ${textAlign}; ` +
            `${textShadowCss}`
        );

        const bottomText = (now.format('%d %B %Y') ?? '').toUpperCase();
        this._bottomLabel.set_text(bottomText);
        this._bottomLabel.set_style(
            `color: ${dateColor}; font-family: ${dateFontFamily}; ` +
            `font-size: ${dateFontSize}px; text-align: ${textAlign}; ` +
            `${textShadowCss}`
        );
    }
}
