// widgets/circles-system-nested/widget.js
//
// 1x1 card: ONE circle containing three concentric ring gauges - CPU
// (outermost), Memory (middle), Disk (innermost) - each independently
// colored, like Apple Watch Activity rings. This is a different layout
// from widgets/circles-system (which draws three separate small circles
// side by side): here all three share one center point at different
// radii, drawn in a single St.DrawingArea/Cairo pass.
//
// Data source: same as widgets/circles-system - CPU + Memory from
// lib/systemMetricsApi.js's SystemMetricsService (bundled-widgets-only
// import, WIDGET_API.md §9.2), Disk read directly via
// Gio.File.query_filesystem_info() (no equivalent in systemMetricsApi.js,
// same as widgets/circles-disk).

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Cairo from 'cairo';

import {SystemMetricsService} from '../../lib/systemMetricsApi.js';
import {SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, hexToRgba as _hexToRgba, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription} from '../../lib/widgetVisualKit.js';

const RING_SIZE = 128; // 1x1 block-type is 11x11 cells = 176px; matches widgets/circles-cpu's own sizing note.

// Outer-to-inner order, matched to the config.json field names.
const METRICS = [
    {key: 'cpu', caption: 'CPU', ringColorKey: 'cpuRingColor', ringColorDefault: '#33D17AFF'},
    {key: 'mem', caption: 'MEM', ringColorKey: 'memRingColor', ringColorDefault: '#3584E4FF'},
    {key: 'hdd', caption: 'DSK', ringColorKey: 'hddRingColor', ringColorDefault: '#F5C211FF'},
];

export default class CirclesSystemNestedWidget {
    /** @param {WidgetAPI} api - see WIDGET_API.md §5. */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._metrics = new SystemMetricsService();
        this._timerId = null;
        this._fractions = {cpu: 0, mem: 0, hdd: 0};
    }

    buildActor() {
        this._actor = new St.Bin({
            style_class: 'circles-system-nested-root',
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

        // Small stacked legend in the very center - one line per metric.
        this._centerBox = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._stack.add_child(this._centerBox);

        this._centerLabels = {};
        for (const metric of METRICS) {
            const label = new St.Label({text: `${metric.caption} 0%`, x_align: Clutter.ActorAlign.CENTER});
            this._centerBox.add_child(label);
            this._centerLabels[metric.key] = label;
        }

        this._render();
        this._tick();
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
    }

    getDefaultSettings() {
        return {
            ...SHADOW_DEFAULTS,
            backgroundColor: '#000000a9',
            cornerRadius: 18,

            circleBaseColor: '#FFFFFF26',
            cpuRingColor: '#33D17AFF',
            memRingColor: '#3584E4FF',
            hddRingColor: '#F5C211FF',
            ringThickness: 9,
            ringGap: 3,

            showCenterText: true,
            centerFont: 'Sans Bold 10',

            refreshRateSeconds: 2,
        };
    }

    onSettingsChanged() {
        this._render();
        this._startTimer(); // picks up a changed refreshRateSeconds too
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
    }

    /** @private */
    _stopTimer() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    /** @private reads CPU/Memory via SystemMetricsService.sample() plus
     * disk usage locally, then re-renders. */
    _tick() {
        const {cpu, memory} = this._metrics.sample();
        const disk = this._getDiskUsage('/');

        this._fractions.cpu = Math.max(0, Math.min(100, cpu.percent ?? 0)) / 100;
        this._fractions.mem = Math.max(0, Math.min(100, memory.percent ?? 0)) / 100;
        this._fractions.hdd = Math.max(0, Math.min(100, disk.percent ?? 0)) / 100;

        this._render();
    }

    /** @private free/total space for `path`'s filesystem - same
     * approach as widgets/circles-disk and widgets/circles-system. */
    _getDiskUsage(path) {
        try {
            const file = Gio.File.new_for_path(path);
            const info = file.query_filesystem_info('filesystem::size,filesystem::free', null);
            const totalBytes = info.get_attribute_uint64('filesystem::size');
            const freeBytes = info.get_attribute_uint64('filesystem::free');
            const usedBytes = Math.max(0, totalBytes - freeBytes);
            const percent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
            return {totalBytes, freeBytes, usedBytes, percent};
        } catch (e) {
            this._api.logger.info(`circles-system-nested: could not read disk usage for ${path}: ${e}`);
            return {totalBytes: 0, freeBytes: 0, usedBytes: 0, percent: 0};
        }
    }

    /** @private */
    _render() {
        this._actor.set_style(_cardStyleCss(this._settings, {backgroundColorFallback: '#000000a9', cornerRadiusFallback: 18}));

        const showCenterText = this._settings.showCenterText ?? true;
        this._centerBox.visible = showCenterText;
        if (showCenterText) {
            const font = _parseFontDescription(this._settings.centerFont ?? 'Sans Bold 10', 'Sans Bold', 10);
            for (const metric of METRICS) {
                const color = _toCssColor(this._settings[metric.ringColorKey], metric.ringColorDefault);
                const label = this._centerLabels[metric.key];
                label.set_text(`${metric.caption} ${Math.round(this._fractions[metric.key] * 100)}%`);
                label.set_style(
                    `color: ${color}; font-family: ${font.family}; ` +
                    `font-size: ${font.size}px; font-weight: bold; text-align: center;`
                );
            }
        }

        if (this._ringArea)
            this._ringArea.queue_repaint();
    }

    /** @private StDrawingArea::repaint handler - draws the base track
     * and progress arc for each of the three concentric rings, from
     * outermost (CPU) to innermost (Disk). Only touches Cairo via
     * area.get_context() from inside here, and disposes the context
     * before returning (GJS-specific requirement). */
    _onRepaint() {
        const cr = this._ringArea.get_context();

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const thickness = Math.max(2, this._settings.ringThickness ?? 9);
        const gap = Math.max(0, this._settings.ringGap ?? 3);
        const baseColor = _hexToRgba(this._settings.circleBaseColor ?? '#FFFFFF26');

        const cx = RING_SIZE / 2;
        const cy = RING_SIZE / 2;
        const startAngle = -Math.PI / 2; // 12 o'clock

        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(thickness);

        let radius = RING_SIZE / 2 - thickness / 2 - 2;
        for (const metric of METRICS) {
            const fraction = Math.max(0, Math.min(1, this._fractions[metric.key]));
            const ringColor = _hexToRgba(this._settings[metric.ringColorKey] ?? metric.ringColorDefault);

            // Base track - always a full circle.
            cr.setSourceRGBA(baseColor.r, baseColor.g, baseColor.b, baseColor.a);
            cr.arc(cx, cy, radius, 0, 2 * Math.PI);
            cr.stroke();

            // Progress arc - skip a zero-length arc (round caps still
            // paint a stray dot otherwise).
            if (fraction > 0) {
                const endAngle = startAngle + fraction * 2 * Math.PI;
                cr.setSourceRGBA(ringColor.r, ringColor.g, ringColor.b, ringColor.a);
                cr.arc(cx, cy, radius, startAngle, endAngle);
                cr.stroke();
            }

            radius -= thickness + gap;
        }

        cr.$dispose();
    }
}
