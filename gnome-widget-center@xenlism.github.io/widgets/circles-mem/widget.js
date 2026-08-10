// widgets/circles-mem/widget.js
//
// 1x1 card: a single ring gauge (base track + memory-usage progress arc)
// with the "MEM" caption and the live percentage centered inside it -
// see the reference mockup this was built from. Pattern is
// widgets/system-monitor-mini's per-metric gauge (Clutter.BinLayout stack:
// St.DrawingArea behind, an St.BoxLayout of labels on top), split out
// into its own full-size 1x1 card the way widgets/cpu-monitor is its own
// card built from the same underlying idea as widgets/system-stats.
//
// Data source: lib/systemMetricsApi.js's SystemMetricsService, which this
// widget is allowed to import because it ships bundled inside this
// extension (WIDGET_API.md §9.2 "bundled widgets only" path
// restriction). One instance per widget instance, as required.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Cairo from 'cairo';

import {SystemMetricsService} from '../../lib/systemMetricsApi.js';
import {
    SHADOW_DEFAULTS, hexToRgba as _hexToRgba,
    toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, BORDER_DEFAULTS, OPACITY_DEFAULTS,} from '../../lib/widgetVisualKit.js';
import {createLayeredCard, applyLayeredCardStyle} from '../../lib/cardLayers.js';

const RING_SIZE = 128; // 1x1 block-type is now 11x11 cells (176px) not 10x10 (160px); scaled 116 * (176/160) = 127.6 -> 128

export default class CirclesMemWidget {
    /** @param {WidgetAPI} api - see WIDGET_API.md §5. */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._metrics = new SystemMetricsService();
        this._timerId = null;
        this._pressId = null;
        this._fraction = 0;
    }

    buildActor() {
        this._layers = createLayeredCard({contentStyleClass: 'circles-mem-root'});
        this._actor = this._layers.root;

        const outerBox = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true});
        this._layers.content.add_child(outerBox);
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
        this._labelLabel = new St.Label({text: 'MEM', style_class: 'circles-mem-label'});
        this._valueLabel = new St.Label({text: '0%', style_class: 'circles-mem-value'});
        textBox.add_child(this._labelLabel);
        textBox.add_child(this._valueLabel);
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

            labelFont: 'Sans 12',
            labelColor: '#FFFFFFB3',
            percentFont: 'Sans Bold 22',
            percentColor: '#FFFFFFFF',

            circleBaseColor: '#FFFFFF26',
            ringColor: '#5AC8FAFF',
            ringThickness: 10,

            refreshRateSeconds: 2,
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
        const seconds = Math.max(1, this._settings.refreshRateSeconds ?? 2);
        this._tick(); // don't wait a full interval for the first real value
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

    /** @private */
    _tick() {
        const {percent} = this._metrics.getMemoryUsage();
        const clamped = Math.max(0, Math.min(100, percent ?? 0));
        this._fraction = clamped / 100;
        this._valueLabel.set_text(`${Math.round(clamped)}%`);
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
                this._api.logger.info(`circles-mem: could not read .desktop file at ${path}`);
        } catch (e) {
            this._api.logger.info(`circles-mem: failed to launch ${path}: ${e}`);
        }
    }

    /** @private */
    _render() {
        const backgroundColor = _toCssColor(this._settings.backgroundColor, '#FFFFFF00');
        const cornerRadius = this._settings.cornerRadius ?? 18;
        applyLayeredCardStyle(this._layers, this._settings, {backgroundColorFallback: '#FFFFFF00', cornerRadiusFallback: 18});

        const labelColor = _toCssColor(this._settings.labelColor, '#FFFFFFB3');
        const percentColor = _toCssColor(this._settings.percentColor, '#FFFFFFFF');
        const labelFont = _parseFontDescription(this._settings.labelFont ?? 'Sans 12', 'Sans', 12);
        const percentFont = _parseFontDescription(this._settings.percentFont ?? 'Sans Bold 22', 'Sans Bold', 22);

        this._labelLabel.set_style(
            `color: ${labelColor}; font-family: ${labelFont.family}; ` +
            `font-size: ${labelFont.size}px; text-align: center;`
        );
        this._valueLabel.set_style(
            `color: ${percentColor}; font-family: ${percentFont.family}; ` +
            `font-size: ${percentFont.size}px; font-weight: bold; text-align: center;`
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
