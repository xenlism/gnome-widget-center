import Clutter from "gi://Clutter";

import St from "gi://St";

import GLib from "gi://GLib";

import Gio from "gi://Gio";

import Cairo from "cairo";

import { SystemMetricsService } from "../../lib/systemMetricsApi.js";

import { SHADOW_DEFAULTS, hexToRgba as _hexToRgba, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/cardLayers.js";

const RING_SIZE = 44;

const RING_SPACING = 8;

const CARD_PADDING = 12;

const METRICS = [ {
    key: "cpu",
    caption: "CPU",
    ringColorKey: "cpuRingColor",
    valueColorKey: "cpuValueColor",
    valueFontKey: "cpuValueFont",
    ringColorDefault: "#33D17AFF",
    valueColorDefault: "#FFFFFFFF",
    valueFontDefault: "Sans Bold 11"
}, {
    key: "mem",
    caption: "MEM",
    ringColorKey: "memRingColor",
    valueColorKey: "memValueColor",
    valueFontKey: "memValueFont",
    ringColorDefault: "#3584E4FF",
    valueColorDefault: "#FFFFFFFF",
    valueFontDefault: "Sans Bold 11"
}, {
    key: "hdd",
    caption: "HDD",
    ringColorKey: "hddRingColor",
    valueColorKey: "hddValueColor",
    valueFontKey: "hddValueFont",
    ringColorDefault: "#F5C211FF",
    valueColorDefault: "#FFFFFFFF",
    valueFontDefault: "Sans Bold 11"
} ];

export default class CirclesSystemWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._metrics = new SystemMetricsService;
        this._timerId = null;
        this._gauges = [];
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "circles-system-root"
        });
        this._actor = this._layers.root;
        const outerBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true
        });
        this._layers.content.add_child(outerBox);
        outerBox.set_style(`padding: ${CARD_PADDING}px;`);
        const centerBin = new St.Bin({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        outerBox.add_child(centerBin);
        const content = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER
        });
        centerBin.set_child(content);
        const ringsRow = new St.BoxLayout({
            vertical: false,
            x_align: Clutter.ActorAlign.CENTER
        });
        content.add_child(ringsRow);
        const captionsRow = new St.BoxLayout({
            vertical: false,
            x_align: Clutter.ActorAlign.CENTER
        });
        captionsRow.set_style("margin-top: 4px;");
        content.add_child(captionsRow);
        this._gauges = [];
        METRICS.forEach((metric, index) => {
            if (index > 0) {
                ringsRow.add_child(new St.Widget({
                    width: RING_SPACING,
                    height: 1
                }));
                captionsRow.add_child(new St.Widget({
                    width: RING_SPACING,
                    height: 1
                }));
            }
            this._gauges.push(this._buildGauge(ringsRow, captionsRow, metric));
        });
        this._render();
        this._tick();
        return this._actor;
    }
    _buildGauge(ringsRow, captionsRow, metric) {
        const stack = new St.Widget({
            layout_manager: new Clutter.BinLayout,
            width: RING_SIZE,
            height: RING_SIZE
        });
        ringsRow.add_child(stack);
        const area = new St.DrawingArea({
            width: RING_SIZE,
            height: RING_SIZE
        });
        stack.add_child(area);
        const valueLabel = new St.Label({
            text: "0%",
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true
        });
        stack.add_child(valueLabel);
        const captionLabel = new St.Label({
            text: metric.caption
        });
        captionLabel.set_width(RING_SIZE);
        captionsRow.add_child(captionLabel);
        const gauge = {
            metric: metric,
            area: area,
            fraction: 0,
            valueLabel: valueLabel,
            captionLabel: captionLabel
        };
        area.connect("repaint", () => this._repaintGauge(gauge));
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
            backgroundColor: "#FFFFFF00",
            cornerRadius: 18,
            circleBaseColor: "#FFFFFF26",
            cpuRingColor: "#33D17AFF",
            memRingColor: "#3584E4FF",
            hddRingColor: "#F5C211FF",
            ringThickness: 6,
            captionFont: "Sans 8",
            captionColor: "#FFFFFFB3",
            cpuValueFont: "Sans Bold 11",
            cpuValueColor: "#FFFFFFFF",
            memValueFont: "Sans Bold 11",
            memValueColor: "#FFFFFFFF",
            hddValueFont: "Sans Bold 11",
            hddValueColor: "#FFFFFFFF",
            refreshRateSeconds: 2
        };
    }
    onSettingsChanged() {
        this._render();
        this._startTimer();
    }
    _startTimer() {
        this._stopTimer();
        const seconds = Math.max(1, this._settings.refreshRateSeconds ?? 2);
        this._tick();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }
    _stopTimer() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }
    _tick() {
        const {cpu: cpu, memory: memory} = this._metrics.sample();
        const disk = this._getDiskUsage("/");
        this._setGauge(this._gauges[0], cpu.percent);
        this._setGauge(this._gauges[1], memory.percent);
        this._setGauge(this._gauges[2], disk.percent);
    }
    _setGauge(gauge, percent) {
        const clamped = Math.max(0, Math.min(100, percent ?? 0));
        gauge.fraction = clamped / 100;
        gauge.valueLabel.set_text(`${Math.round(clamped)}%`);
        if (gauge.area) gauge.area.queue_repaint();
    }
    _getDiskUsage(path) {
        try {
            const file = Gio.File.new_for_path(path);
            const info = file.query_filesystem_info("filesystem::size,filesystem::free", null);
            const totalBytes = info.get_attribute_uint64("filesystem::size");
            const freeBytes = info.get_attribute_uint64("filesystem::free");
            const usedBytes = Math.max(0, totalBytes - freeBytes);
            const percent = totalBytes > 0 ? usedBytes / totalBytes * 100 : 0;
            return {
                totalBytes: totalBytes,
                freeBytes: freeBytes,
                usedBytes: usedBytes,
                percent: percent
            };
        } catch (e) {
            this._api.logger.info(`circles-system: could not read disk usage for ${path}: ${e}`);
            return {
                totalBytes: 0,
                freeBytes: 0,
                usedBytes: 0,
                percent: 0
            };
        }
    }
    _render() {
        applyLayeredCardStyle(this._layers, this._settings, {
            backgroundColorFallback: "#FFFFFF00",
            cornerRadiusFallback: 18
        }, false);
        const captionColor = _toCssColor(this._settings.captionColor, "#FFFFFFB3");
        const captionFont = _parseFontDescription(this._settings.captionFont ?? "Sans 8", "Sans", 8);
        for (const gauge of this._gauges) {
            const {metric: metric} = gauge;
            const valueColor = _toCssColor(this._settings[metric.valueColorKey], metric.valueColorDefault);
            const valueFont = _parseFontDescription(this._settings[metric.valueFontKey] ?? metric.valueFontDefault, "Sans Bold", 11);
            gauge.valueLabel.set_style(`color: ${valueColor}; font-family: ${valueFont.family}; ` + `font-size: ${valueFont.size}px; font-weight: bold; text-align: center;`);
            gauge.captionLabel.set_style(`color: ${captionColor}; font-family: ${captionFont.family}; ` + `font-size: ${captionFont.size}px; text-align: center;`);
            if (gauge.area) gauge.area.queue_repaint();
        }
    }
    _repaintGauge(gauge) {
        const cr = gauge.area.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        const thickness = Math.max(2, this._settings.ringThickness ?? 6);
        const baseColor = _hexToRgba(this._settings.circleBaseColor ?? "#FFFFFF26");
        const ringColor = _hexToRgba(this._settings[gauge.metric.ringColorKey] ?? gauge.metric.ringColorDefault);
        const cx = RING_SIZE / 2;
        const cy = RING_SIZE / 2;
        const radius = (RING_SIZE - thickness) / 2 - 1;
        const startAngle = -Math.PI / 2;
        const fraction = Math.max(0, Math.min(1, gauge.fraction));
        const endAngle = startAngle + fraction * 2 * Math.PI;
        cr.setLineWidth(thickness);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setSourceRGBA(baseColor.r, baseColor.g, baseColor.b, baseColor.a);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();
        if (fraction > 0) {
            cr.setSourceRGBA(ringColor.r, ringColor.g, ringColor.b, ringColor.a);
            cr.arc(cx, cy, radius, startAngle, endAngle);
            cr.stroke();
        }
        cr.$dispose();
    }
}
