// widgets/geek-week-stat-bay/widget.js
//
// "Geek" week + stat card - a medium `3x1` card (35×11 grid cells),
// see WIDGET_API.md §2) translucent card with two centered lines:
//
//   TOP LINE     e.g. "THURSDAY"   (big, bold, uppercase)
//   BOTTOM LINE  e.g. "CPU 100%  MEM 100%  DISK 100%"   (small, centered)
//
// Shape/shell copied from widgets/geek-date-stat-bar/widget.js (card
// background + inline St `style` rendering - the host does not yet load a
// widget's own stylesheet.css into the Shell's theme context, same note as
// clock-modern/date-modern). CPU/RAM sampling copied from widgets/system-stats/widget.js's use of lib/systemMetricsApi.js; disk usage has no equivalent there yet (same note as widgets/circles-disk and widgets/system-monitor-mini), so it's read directly via Gio here, kept as a local copy per WIDGET_API.md §1 ("a widget only ever imports its own files", lib/ aside).
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
import Gio from 'gi://Gio';
// Imported even though only Clutter.ActorAlign.CENTER is used directly -
// St's typelib depends on Clutter's, and some import orders resolve
// Clutter earlier than others by accident (calendar-modern hit this, see
// SKILL.md "Before writing anything" table / gotchas).
import Clutter from 'gi://Clutter';
import {SystemMetricsService} from '../../lib/systemMetricsApi.js';
import {SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription} from '../../lib/widgetVisualKit.js';

/** Local default settings for the text-shadow (shadow drawn under the
 * text labels themselves) - same shape as SHADOW_DEFAULTS so the
 * angle/distance/blur/opacity math below can mirror
 * widgetVisualKit.js's shadowBoxShadowCss() exactly. */
const TEXT_SHADOW_DEFAULTS = {
    textShadowEnabled: false,
    textShadowColor: '#000000',
    textShadowOpacity: 60,
    textShadowAngle: 90,
    textShadowDistance: 2,
    textShadowBlur: 4,
};

export default class GeekWeekStatBayWidget {
    /**
     * @param {WidgetAPI} api - see development/docs/WIDGET_API.md §5.
     */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._logger = api.logger;
        this._timeoutId = null;
        // One instance per widget instance, same note as
        // widgets/system-stats/widget.js's constructor - CPU%/network
        // deltas are tracked on THIS object only.
        this._metrics = new SystemMetricsService();
    }

    // Must never throw, even with empty settings - getDefaultSettings()
    // below always backfills every key this widget reads before this runs,
    // but the `??` fallbacks in _render() cost nothing and keep this
    // widget robust on its own too.
    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: 'geek-week-stat-bay-widget-root',
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._topLabel = new St.Label({style_class: 'geek-week-stat-bay-widget-top', x_expand: true});
        this._bottomLabel = new St.Label({style_class: 'geek-week-stat-bay-widget-bottom', x_expand: true});

        this._actor.add_child(this._topLabel);
        this._actor.add_child(this._bottomLabel);

        this._render();
        return this._actor;
    }

    enable() {
        this._logger.info('geek-week-stat-bay enabled');
        this._render();
        this._setupTimer();
    }

    disable() {
        this._logger.info('geek-week-stat-bay disabled');
        this._destroyTimer();
    }

    getDefaultSettings() {
        return {
            ...SHADOW_DEFAULTS,
            ...TEXT_SHADOW_DEFAULTS,

            updateInterval: 2,
            diskPath: '/',

            weekFont: 'Sans Bold 32',
            weekColor: '#ffffff',
            systemFont: 'Sans Bold 16',
            systemColor: '#e6e6e6',

            backgroundColor: '#1a2a33b3',
            textAlign: 'center',
            cornerRadius: 18,
        };
    }

    // Cross-process live update (same hook as date-modern/clock-modern):
    // re-render immediately so a font/color/interval change made in the
    // Control Center shows up right away, and restart the poll timer in case updateInterval just changed.
    onSettingsChanged() {
        this._render();
        this._destroyTimer();
        this._setupTimer();
    }

    /** @private */
    _setupTimer() {
        const interval = Math.max(1, this._settings.updateInterval ?? 2);
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

    /** @private free/total space for `path`'s filesystem, same approach as
     * widgets/system-monitor-mini/widget.js's _getDiskUsage() - kept as its
     * own local copy per WIDGET_API.md §1. */
    _getDiskUsage(path) {
        try {
            const file = Gio.File.new_for_path(path);
            const info = file.query_filesystem_info('filesystem::size,filesystem::free', null);
            const totalBytes = info.get_attribute_uint64('filesystem::size');
            const freeBytes = info.get_attribute_uint64('filesystem::free');
            const usedBytes = Math.max(0, totalBytes - freeBytes);
            const percent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
            return {percent};
        } catch (e) {
            this._logger.info(`geek-week-stat-bay: could not read disk usage for ${path}: ${e}`);
            return {percent: 0};
        }
    }

    /** @private mirrors lib/widgetVisualKit.js's shadowBoxShadowCss(), just
     * emitting `text-shadow:` instead of `box-shadow:` (text-shadow has no
     * spread/inset parameters, so those are simply omitted). Kept local
     * since text-shadow isn't in widgetVisualKit.js yet. */
    _textShadowCss() {
        const s = this._settings;
        if (!(s.textShadowEnabled ?? TEXT_SHADOW_DEFAULTS.textShadowEnabled))
            return '';

        const opacityPercent = Number.isFinite(s.textShadowOpacity) ? s.textShadowOpacity : TEXT_SHADOW_DEFAULTS.textShadowOpacity;
        const angleDeg = Number.isFinite(s.textShadowAngle) ? s.textShadowAngle : TEXT_SHADOW_DEFAULTS.textShadowAngle;
        const distance = Number.isFinite(s.textShadowDistance) ? s.textShadowDistance : TEXT_SHADOW_DEFAULTS.textShadowDistance;
        const blur = Number.isFinite(s.textShadowBlur) ? Math.max(0, s.textShadowBlur) : TEXT_SHADOW_DEFAULTS.textShadowBlur;

        const rad = (angleDeg * Math.PI) / 180;
        const offsetX = Math.round(Math.cos(rad) * distance * 100) / 100;
        const offsetY = Math.round(Math.sin(rad) * distance * 100) / 100;

        let hex = (s.textShadowColor ?? TEXT_SHADOW_DEFAULTS.textShadowColor).trim().replace(/^#/, '');
        if (hex.length === 3)
            hex = hex.split('').map(c => c + c).join('');
        if (!/^[0-9a-fA-F]{6}$/.test(hex))
            hex = '000000';
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        const a = Math.min(1, Math.max(0, opacityPercent / 100));

        return `text-shadow: ${offsetX}px ${offsetY}px ${blur}px rgba(${r}, ${g}, ${b}, ${a});`;
    }

    /** @private */
    _render() {
        const now = GLib.DateTime.new_now_local();

        const {family: weekFontFamily, size: weekFontSize} =
            _parseFontDescription(this._settings.weekFont ?? 'Sans Bold 32', 'Sans Bold', 32);
        const {family: systemFontFamily, size: systemFontSize} =
            _parseFontDescription(this._settings.systemFont ?? 'Sans Bold 16', 'Sans Bold', 16);

        const weekColor = this._settings.weekColor ?? '#ffffff';
        const systemColor = this._settings.systemColor ?? '#e6e6e6';
        const backgroundColor = _toCssColor(this._settings.backgroundColor ?? '#1a2a33b3', '#1a2a33b3');
        const cornerRadius = this._settings.cornerRadius ?? 18;
        const textAlign = ['left', 'center', 'right'].includes(this._settings.textAlign) ? this._settings.textAlign : 'center';
        const textShadowCss = this._textShadowCss();

        const {cpu, memory} = this._metrics.sample();
        const disk = this._getDiskUsage(this._settings.diskPath ?? '/');
        const statsText =
            `CPU ${Math.round(cpu.percent)}%   ` +
            `MEM ${Math.round(memory.percent)}%   ` +
            `DISK ${Math.round(disk.percent)}%`;
        this._actor.set_style(
            `background-color: ${backgroundColor}; ` +
            `border-radius: ${cornerRadius}px; ` +
            'padding: 14px 24px; ' +
            'spacing: 5px;' +
            _shadowBoxShadowCss(this._settings)
        );

        const topText = (now.format('%A') ?? '').toUpperCase();
        this._topLabel.set_text(topText);
        this._topLabel.set_style(
            `color: ${weekColor}; font-family: ${weekFontFamily}; ` +
            `font-size: ${weekFontSize}px; font-weight: bold; text-align: ${textAlign}; ` +
            `${textShadowCss}`
        );

        this._bottomLabel.set_text(statsText);
        this._bottomLabel.set_style(
            `color: ${systemColor}; font-family: ${systemFontFamily}; ` +
            `font-size: ${systemFontSize}px; text-align: ${textAlign}; ` +
            `${textShadowCss}`
        );
    }
}
