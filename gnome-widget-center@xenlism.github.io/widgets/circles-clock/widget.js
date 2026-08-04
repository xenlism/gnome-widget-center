// widgets/circles-clock/widget.js
//
// 1x1 card: three concentric "activity ring"-style sweep rings (HH
// outermost, MM middle, SS innermost), each drawn as a base-color track
// with a colored progress arc on top, and the HH:MM:SS text floating
// centered on top of the rings. Built from the same pieces already used
// elsewhere in this project:
//   - card shell + inline St `style` rendering: widgets/clock-modern
//   - St.DrawingArea + Cairo ring-gauge painting: widgets/system-monitor-mini
//   - Clutter.BinLayout stack (canvas behind, labels on top): widgets/system-monitor-mini
//   - timer/enable()/disable()/onSettingsChanged() ticking on a
//     configurable interval (refreshRateSeconds, default 1s): widgets/clock
//
// Self-contained per WIDGET_API.md §1 (a widget only ever imports its own
// files + lib/) - the small hex-color/font-splitting helpers below are
// duplicated rather than shared, same convention every other bundled
// widget in this project already follows.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Cairo from 'cairo';
import {
    SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, hexToRgba as _hexToRgba,
    toCssColor as _toCssColor, parseFontDescription as _parseFontDescription,
} from '../../lib/widgetVisualKit.js';

const STACK_SIZE = 148; // 1x1 block-type is now 11x11 cells (176px) not 10x10 (160px); previously exactly filled the padded card (132 = 160 - 2*14), so keep that: 176 - 2*14 = 148
const RING_GAP = 4; // px between adjacent ring bands

export default class CirclesClockWidget {
    /** @param {WidgetAPI} api - see WIDGET_API.md §5. */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timerId = null;
        this._pressId = null;
        this._fractions = {hh: 0, mm: 0, ss: 0};
    }

    // Must never throw, even with empty settings.
    buildActor() {
        this._actor = new St.Bin({
            style_class: 'circles-clock-root',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const outerBox = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true});
        this._actor.set_child(outerBox);

        this._stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: STACK_SIZE,
            height: STACK_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        outerBox.add_child(this._stack);
        outerBox.set_style('padding: 14px;');

        this._ringArea = new St.DrawingArea({width: STACK_SIZE, height: STACK_SIZE});
        this._stack.add_child(this._ringArea);
        this._repaintId = this._ringArea.connect('repaint', () => this._onRepaint());

        const textBox = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._timeLabel = new St.Label({style_class: 'circles-clock-time'});
        textBox.add_child(this._timeLabel);
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
            backgroundColor: '#00000000',
            cornerRadius: 18,

            format24h: true,
            timeFont: 'Sans Bold 20',
            timeColor: '#FFFFFFFF',

            circleBaseColor: '#FFFFFF26',
            colorHH: '#7A2E3DFF',
            colorMM: '#E2373DFF',
            colorSS: '#33D17AFF',
            ringThickness: 10,

            refreshRateSeconds: 1,
            launchAppPath: '',
        };
    }

    // Cross-process live update: re-render immediately so a font/color/
    // format change made in the Control Center shows up right away, and
    // restart the timer in case refreshRateSeconds itself just changed
    // (same "restart the timer with the new interval" pattern as
    // widgets/circles-cpu/widget.js's _startTimer()).
    onSettingsChanged() {
        this._render();
        this._startTimer();
        this._applyClickHandler();
    }

    /** @private (re)starts the tick timer at the current
     * refreshRateSeconds, replacing any existing one - safe to call from
     * enable() or from a settings change. */
    _startTimer() {
        this._stopTimer();
        const seconds = Math.max(1, this._settings.refreshRateSeconds ?? 1);
        this._tick(); // don't wait a full interval for the first paint
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /** @private */
    _stopTimer() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    /** @private recomputes HH/MM/SS sweep fractions + the displayed text
     * and queues a repaint. Runs once immediately in buildActor() and
     * again every second from enable()'s timer. */
    _tick() {
        const now = GLib.DateTime.new_now_local();
        const format24h = this._settings.format24h ?? true;

        const hour = now.get_hour();
        const minute = now.get_minute();
        const second = now.get_second();

        const hourSpan = format24h ? 24 : 12;
        const hourInSpan = format24h ? hour : (hour % 12);
        this._fractions.hh = (hourInSpan + minute / 60) / hourSpan;
        this._fractions.mm = (minute + second / 60) / 60;
        this._fractions.ss = second / 60;

        this._timeLabel.set_text(format24h ? (now.format('%H:%M:%S') ?? '') : (now.format('%I:%M:%S') ?? ''));

        if (this._ringArea)
            this._ringArea.queue_repaint();
    }

    /** @private */
    _applyClickHandler() {
        this._removeClickHandler();

        const desktopFilePath = this._settings.launchAppPath ?? '';
        if (!desktopFilePath) {
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
                this._api.logger.info(`circles-clock: could not read .desktop file at ${path}`);
        } catch (e) {
            this._api.logger.info(`circles-clock: failed to launch ${path}: ${e}`);
        }
    }

    /** @private */
    _render() {
        const backgroundColor = _toCssColor(this._settings.backgroundColor, '#00000000');
        const cornerRadius = this._settings.cornerRadius ?? 18;
        this._actor.set_style(_cardStyleCss(this._settings, {cornerRadiusFallback: 18}));

        const timeColor = _toCssColor(this._settings.timeColor, '#FFFFFFFF');
        const {family, size} = _parseFontDescription(this._settings.timeFont ?? 'Sans Bold 20', 'Sans Bold', 20);
        this._timeLabel.set_style(
            `color: ${timeColor}; font-family: ${family}; ` +
            `font-size: ${size}px; font-weight: bold; text-align: center;`
        );

        if (this._ringArea)
            this._ringArea.queue_repaint();
    }

    /** @private draws the three concentric sweep rings. Never throws on
     * missing settings - every read has a `?? fallback`. */
    _onRepaint() {
        const cr = this._ringArea.get_context();

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const thickness = Math.max(2, this._settings.ringThickness ?? 10);
        const baseColor = _hexToRgba(this._settings.circleBaseColor ?? '#FFFFFF26');
        const cx = STACK_SIZE / 2;
        const cy = STACK_SIZE / 2;
        const startAngle = -Math.PI / 2; // 12 o'clock

        const outerRadius = STACK_SIZE / 2 - thickness / 2 - 2;
        const rings = [
            {radius: outerRadius, fraction: this._fractions.hh, color: this._settings.colorHH ?? '#7A2E3DFF'},
            {radius: outerRadius - (thickness + RING_GAP), fraction: this._fractions.mm, color: this._settings.colorMM ?? '#E2373DFF'},
            {radius: outerRadius - 2 * (thickness + RING_GAP), fraction: this._fractions.ss, color: this._settings.colorSS ?? '#33D17AFF'},
        ];

        cr.setLineWidth(thickness);
        cr.setLineCap(Cairo.LineCap.ROUND);

        for (const ring of rings) {
            if (ring.radius <= 0)
                continue;

            // Base track - always a full circle.
            cr.setSourceRGBA(baseColor.r, baseColor.g, baseColor.b, baseColor.a);
            cr.arc(cx, cy, ring.radius, 0, 2 * Math.PI);
            cr.stroke();

            // Progress arc - skip a zero-length arc (round caps still
            // paint a stray dot otherwise).
            const fraction = Math.max(0, Math.min(1, ring.fraction));
            if (fraction > 0) {
                const {r, g, b, a} = _hexToRgba(ring.color);
                cr.setSourceRGBA(r, g, b, a);
                cr.arc(cx, cy, ring.radius, startAngle, startAngle + fraction * 2 * Math.PI);
                cr.stroke();
            }
        }

        cr.$dispose();
    }
}
