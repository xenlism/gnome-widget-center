// widgets/circles-system/widget.js
//
// 1x1 card: three small ring gauges side by side - CPU, Memory, Disk -
// each with its own progress color, its own value-text color/font, and
// a shared caption ("CPU"/"MEM"/"HDD") row underneath. Same underlying
// gauge idea as widgets/system-monitor-mini and widgets/circles-cpu
// (Clutter.BinLayout stack: St.DrawingArea behind, an St.Label on top),
// just three of them scaled down to fit one 1x1 card instead of one
// gauge per card (circles-cpu/circles-mem/circles-disk) or three wide
// gauges in a 2x1 card (system-monitor-mini).
//
// Unlike system-monitor-mini (one shared activeColor for all three
// rings), this widget gives CPU/Memory/Disk each their own ring color
// AND their own value-text color/font, per the mockup this was built
// from - see config.json's "rings"/"text" groups.
//
// Data source: CPU + Memory come from lib/systemMetricsApi.js's
// SystemMetricsService (bundled-widgets-only import, WIDGET_API.md
// §9.2). Disk usage has no equivalent there, so - same as
// widgets/circles-disk and widgets/system-monitor-mini - it's read
// directly via Gio.File's query_filesystem_info().

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Cairo from 'cairo';

import {SystemMetricsService} from '../../lib/systemMetricsApi.js';
import {SHADOW_DEFAULTS, hexToRgba as _hexToRgba, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, BORDER_DEFAULTS, OPACITY_DEFAULTS,} from '../../lib/widgetVisualKit.js';
import {createLayeredCard, applyLayeredCardStyle} from '../../lib/cardLayers.js';

// 1x1 block-type is 11x11 cells (176x176px). Card padding is 12px a
// side, leaving ~152px of content width for three rings + two gaps:
// 3*44 + 2*8 = 148, comfortably inside 152.
const RING_SIZE = 44;
const RING_SPACING = 8;
const CARD_PADDING = 12;

const METRICS = [
    {key: 'cpu', caption: 'CPU', ringColorKey: 'cpuRingColor', valueColorKey: 'cpuValueColor', valueFontKey: 'cpuValueFont', ringColorDefault: '#33D17AFF', valueColorDefault: '#FFFFFFFF', valueFontDefault: 'Sans Bold 11'},
    {key: 'mem', caption: 'MEM', ringColorKey: 'memRingColor', valueColorKey: 'memValueColor', valueFontKey: 'memValueFont', ringColorDefault: '#3584E4FF', valueColorDefault: '#FFFFFFFF', valueFontDefault: 'Sans Bold 11'},
    {key: 'hdd', caption: 'HDD', ringColorKey: 'hddRingColor', valueColorKey: 'hddValueColor', valueFontKey: 'hddValueFont', ringColorDefault: '#F5C211FF', valueColorDefault: '#FFFFFFFF', valueFontDefault: 'Sans Bold 11'},
];

export default class CirclesSystemWidget {
    /** @param {WidgetAPI} api - see WIDGET_API.md §5. */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._metrics = new SystemMetricsService(); // one instance per widget instance
        this._timerId = null;
        this._gauges = []; // one entry per METRICS[i]: {area, fraction, valueLabel, captionLabel}
    }

    buildActor() {
        this._layers = createLayeredCard({contentStyleClass: 'circles-system-root'});
        this._actor = this._layers.root;

        const outerBox = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true});
        this._layers.content.add_child(outerBox);
        outerBox.set_style(`padding: ${CARD_PADDING}px;`);

        const centerBin = new St.Bin({x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        outerBox.add_child(centerBin);

        const content = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.CENTER});
        centerBin.set_child(content);

        const ringsRow = new St.BoxLayout({vertical: false, x_align: Clutter.ActorAlign.CENTER});
        content.add_child(ringsRow);

        const captionsRow = new St.BoxLayout({vertical: false, x_align: Clutter.ActorAlign.CENTER});
        captionsRow.set_style('margin-top: 4px;');
        content.add_child(captionsRow);

        this._gauges = [];
        METRICS.forEach((metric, index) => {
            if (index > 0) {
                ringsRow.add_child(new St.Widget({width: RING_SPACING, height: 1}));
                captionsRow.add_child(new St.Widget({width: RING_SPACING, height: 1}));
            }
            this._gauges.push(this._buildGauge(ringsRow, captionsRow, metric));
        });

        this._render();
        this._tick();
        return this._actor;
    }

    /** @private builds one ring-gauge stack (drawing area + centered value
     * label) in `ringsRow`, plus its caption label in `captionsRow`. */
    _buildGauge(ringsRow, captionsRow, metric) {
        const stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: RING_SIZE,
            height: RING_SIZE,
        });
        ringsRow.add_child(stack);

        const area = new St.DrawingArea({width: RING_SIZE, height: RING_SIZE});
        stack.add_child(area);

        const valueLabel = new St.Label({
            text: '0%',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        stack.add_child(valueLabel);

        const captionLabel = new St.Label({text: metric.caption});
        captionLabel.set_width(RING_SIZE);
        captionsRow.add_child(captionLabel);

        const gauge = {metric, area, fraction: 0, valueLabel, captionLabel};
        area.connect('repaint', () => this._repaintGauge(gauge));
        return gauge;
    }

    enable() {
        this._startTimer();
    }

    disable() {
        this._stopTimer();
    }

    getDefaultSettings() {
        return {
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
            backgroundColor: '#FFFFFF00',
            cornerRadius: 18,

            circleBaseColor: '#FFFFFF26',
            cpuRingColor: '#33D17AFF',
            memRingColor: '#3584E4FF',
            hddRingColor: '#F5C211FF',
            ringThickness: 6,

            captionFont: 'Sans 8',
            captionColor: '#FFFFFFB3',
            cpuValueFont: 'Sans Bold 11',
            cpuValueColor: '#FFFFFFFF',
            memValueFont: 'Sans Bold 11',
            memValueColor: '#FFFFFFFF',
            hddValueFont: 'Sans Bold 11',
            hddValueColor: '#FFFFFFFF',

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
     * disk usage locally, updates each gauge's fraction/label, and
     * queues a repaint. */
    _tick() {
        const {cpu, memory} = this._metrics.sample();
        const disk = this._getDiskUsage('/');

        this._setGauge(this._gauges[0], cpu.percent);
        this._setGauge(this._gauges[1], memory.percent);
        this._setGauge(this._gauges[2], disk.percent);
    }

    /** @private */
    _setGauge(gauge, percent) {
        const clamped = Math.max(0, Math.min(100, percent ?? 0));
        gauge.fraction = clamped / 100;
        gauge.valueLabel.set_text(`${Math.round(clamped)}%`);
        if (gauge.area)
            gauge.area.queue_repaint();
    }

    /** @private free/total space for `path`'s filesystem via
     * Gio.File.query_filesystem_info() - same approach as
     * widgets/circles-disk and widgets/system-monitor-mini, since disk
     * usage has no equivalent in systemMetricsApi.js. */
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
            this._api.logger.info(`circles-system: could not read disk usage for ${path}: ${e}`);
            return {totalBytes: 0, freeBytes: 0, usedBytes: 0, percent: 0};
        }
    }

    /** @private */
    _render() {
        applyLayeredCardStyle(this._layers, this._settings, {backgroundColorFallback: '#FFFFFF00', cornerRadiusFallback: 18});

        const captionColor = _toCssColor(this._settings.captionColor, '#FFFFFFB3');
        const captionFont = _parseFontDescription(this._settings.captionFont ?? 'Sans 8', 'Sans', 8);

        for (const gauge of this._gauges) {
            const {metric} = gauge;
            const valueColor = _toCssColor(this._settings[metric.valueColorKey], metric.valueColorDefault);
            const valueFont = _parseFontDescription(this._settings[metric.valueFontKey] ?? metric.valueFontDefault, 'Sans Bold', 11);

            gauge.valueLabel.set_style(
                `color: ${valueColor}; font-family: ${valueFont.family}; ` +
                `font-size: ${valueFont.size}px; font-weight: bold; text-align: center;`
            );
            gauge.captionLabel.set_style(
                `color: ${captionColor}; font-family: ${captionFont.family}; ` +
                `font-size: ${captionFont.size}px; text-align: center;`
            );

            if (gauge.area)
                gauge.area.queue_repaint();
        }
    }

    /** @private StDrawingArea::repaint handler for one gauge - only
     * touches Cairo via area.get_context() from inside here, and calls
     * cr.$dispose() before returning (GJS-specific requirement). */
    _repaintGauge(gauge) {
        const cr = gauge.area.get_context();

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const thickness = Math.max(2, this._settings.ringThickness ?? 6);
        const baseColor = _hexToRgba(this._settings.circleBaseColor ?? '#FFFFFF26');
        const ringColor = _hexToRgba(this._settings[gauge.metric.ringColorKey] ?? gauge.metric.ringColorDefault);

        const cx = RING_SIZE / 2;
        const cy = RING_SIZE / 2;
        const radius = (RING_SIZE - thickness) / 2 - 1;
        const startAngle = -Math.PI / 2; // 12 o'clock
        const fraction = Math.max(0, Math.min(1, gauge.fraction));
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
