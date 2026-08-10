// widgets/circles-year/widget.js
//
// 1x1 card: a single ring gauge (base track + year-progress arc) with
// the current year number floating centered inside it, and an optional
// "day X / Y" line underneath showing day-of-year over days-in-year.
// Same Clutter.BinLayout stack (St.DrawingArea behind, St.BoxLayout of
// labels on top) as widgets/circles-cpu, just fed from the system clock
// (GLib.DateTime) instead of lib/systemMetricsApi.js.
//
// The date only changes once a day, so unlike the CPU/MEM/Disk/NET
// gauges this widget defaults to a much slower refresh interval
// (refreshRateSeconds, default 300s) - see getDefaultSettings() below -
// while still recomputing immediately on enable()/onSettingsChanged() so
// a change never waits a full interval to show up.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Cairo from 'cairo';
import {
    SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, hexToRgba as _hexToRgba,
    toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, BORDER_DEFAULTS, OPACITY_DEFAULTS,} from '../../lib/widgetVisualKit.js';

const RING_SIZE = 128; // 1x1 block-type is now 11x11 cells (176px) not 10x10 (160px); scaled 116 * (176/160) = 127.6 -> 128

/** @private true if `year` is a Gregorian leap year. */
function _isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export default class CirclesYearWidget {
    /** @param {WidgetAPI} api - see WIDGET_API.md §5. */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timerId = null;
        this._pressId = null;
        this._fraction = 0;
    }

    buildActor() {
        this._actor = new St.Bin({
            style_class: 'circles-year-root',
            x_expand: true,
            y_expand: true,
        });

        const outerBox = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true});
        this._actor.set_child(outerBox);
        outerBox.set_style('padding: 14px;');

        this._stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: RING_SIZE,
            height: RING_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        outerBox.add_child(this._stack);

        this._ringArea = new St.DrawingArea({width: RING_SIZE, height: RING_SIZE});
        this._stack.add_child(this._ringArea);
        this._repaintId = this._ringArea.connect('repaint', () => this._onRepaint());

        const textBox = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._yearLabel = new St.Label({style_class: 'circles-year-value'});
        this._dayLabel = new St.Label({style_class: 'circles-year-day'});
        textBox.add_child(this._yearLabel);
        textBox.add_child(this._dayLabel);
        this._stack.add_child(textBox);

        this._render();
        this._tick();
        this._applyClickHandler();
        return this._actor;
    }

    enable() {
        this._startTimer();
    }

    disable() {
        this._stopTimer();
        if (this._repaintId !== null && this._ringArea) {
            this._ringArea.disconnect(this._repaintId);
            this._repaintId = null;
        }
        this._removeClickHandler();
    }

    getDefaultSettings() {
        return {
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
            backgroundColor: '#FFFFFF00',
            cornerRadius: 18,

            yearFont: 'Sans Bold 26',
            yearColor: '#FFFFFFFF',
            showDayCount: true,
            dayFont: 'Sans 11',
            dayColor: '#FFFFFFB3',

            circleBaseColor: '#FFFFFF26',
            ringColor: '#33D17AFF',
            ringThickness: 10,

            refreshRateSeconds: 300,
            launchAppPath: '',
        };
    }

    onSettingsChanged() {
        this._render();
        this._startTimer(); // also re-wires the click handler, see below
    }

    /** @private */
    _startTimer() {
        this._stopTimer();
        const seconds = Math.max(5, this._settings.refreshRateSeconds ?? 300);
        this._tick(); // don't wait a full interval for the first paint
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        this._applyClickHandler();
    }

    /** @private */
    _stopTimer() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    /** @private recomputes the year-progress fraction + labels and
     * queues a repaint. */
    _tick() {
        const now = GLib.DateTime.new_now_local();
        const year = now.get_year();
        const dayOfYear = now.get_day_of_year();
        const daysInYear = _isLeapYear(year) ? 366 : 365;

        this._fraction = Math.max(0, Math.min(1, dayOfYear / daysInYear));

        this._yearLabel.set_text(String(year));

        const showDayCount = this._settings.showDayCount ?? true;
        if (showDayCount) {
            this._dayLabel.show();
            this._dayLabel.set_text(`day ${dayOfYear} / ${daysInYear}`);
        } else {
            this._dayLabel.hide();
        }

        if (this._ringArea)
            this._ringArea.queue_repaint();
    }

    /** @private */
    _applyClickHandler() {
        this._removeClickHandler();

        const path = this._settings.launchAppPath ?? '';
        if (!path) {
            this._actor.reactive = false;
            return;
        }

        this._actor.reactive = true;
        this._pressId = this._actor.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            if (event.get_state() & Clutter.ModifierType.MOD4_MASK)
                return Clutter.EVENT_PROPAGATE; // Super held - drag, not a click

            this._launchApp();
            return Clutter.EVENT_STOP;
        });
    }

    /** @private */
    _removeClickHandler() {
        if (this._pressId !== null && this._actor) {
            this._actor.disconnect(this._pressId);
            this._pressId = null;
        }
    }

    /** @private */
    _launchApp() {
        const path = this._settings.launchAppPath ?? '';
        if (!path)
            return;
        try {
            const appInfo = Gio.DesktopAppInfo.new_from_filename(path);
            if (appInfo)
                appInfo.launch([], null);
            else
                this._api.logger.info(`circles-year: could not read .desktop file at ${path}`);
        } catch (e) {
            this._api.logger.info(`circles-year: failed to launch ${path}: ${e}`);
        }
    }

    /** @private */
    _render() {
        const backgroundColor = _toCssColor(this._settings.backgroundColor, '#FFFFFF00');
        const cornerRadius = this._settings.cornerRadius ?? 18;
        this._actor.set_style(_cardStyleCss(this._settings, {cornerRadiusFallback: 18}));

        const yearColor = _toCssColor(this._settings.yearColor, '#FFFFFFFF');
        const dayColor = _toCssColor(this._settings.dayColor, '#FFFFFFB3');
        const yearFont = _parseFontDescription(this._settings.yearFont ?? 'Sans Bold 26', 'Sans Bold', 26);
        const dayFont = _parseFontDescription(this._settings.dayFont ?? 'Sans 11', 'Sans', 11);

        this._yearLabel.set_style(
            `color: ${yearColor}; font-family: ${yearFont.family}; ` +
            `font-size: ${yearFont.size}px; font-weight: bold; text-align: center;`
        );
        this._dayLabel.set_style(
            `color: ${dayColor}; font-family: ${dayFont.family}; ` +
            `font-size: ${dayFont.size}px; text-align: center;`
        );

        if (this._ringArea)
            this._ringArea.queue_repaint();
    }

    /** @private StDrawingArea::repaint handler - only touches Cairo via
     * area.get_context() from inside here, disposes the context before
     * returning (GJS-specific requirement). */
    _onRepaint() {
        const cr = this._ringArea.get_context();

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const thickness = Math.max(2, this._settings.ringThickness ?? 10);
        const baseColor = _hexToRgba(this._settings.circleBaseColor ?? '#FFFFFF26');
        const ringColor = _hexToRgba(this._settings.ringColor ?? '#33D17AFF');

        const cx = RING_SIZE / 2;
        const cy = RING_SIZE / 2;
        const radius = (RING_SIZE - thickness) / 2 - 2;
        const startAngle = -Math.PI / 2; // 12 o'clock
        const fraction = Math.max(0, Math.min(1, this._fraction));
        const endAngle = startAngle + fraction * 2 * Math.PI;

        cr.setLineWidth(thickness);
        cr.setLineCap(Cairo.LineCap.ROUND);

        // Base track - always a full circle.
        cr.setSourceRGBA(baseColor.r, baseColor.g, baseColor.b, baseColor.a);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();

        // Progress arc - skip a zero-length arc (round caps still paint
        // a stray dot otherwise).
        if (fraction > 0) {
            cr.setSourceRGBA(ringColor.r, ringColor.g, ringColor.b, ringColor.a);
            cr.arc(cx, cy, radius, startAngle, endAngle);
            cr.stroke();
        }

        cr.$dispose();
    }
}
