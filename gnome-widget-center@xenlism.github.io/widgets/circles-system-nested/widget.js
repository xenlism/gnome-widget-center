import Clutter from "gi://Clutter";

import St from "gi://St";

import GLib from "gi://GLib";

import Gio from "gi://Gio";

import Cairo from "cairo";

import { SystemMetricsService } from "../../lib/systemMetricsApi.js";

import { SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, hexToRgba as _hexToRgba, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
const RING_SIZE = 128;

const METRICS = [ {
    key: "cpu",
    caption: "CPU",
    ringColorKey: "cpuRingColor",
    ringColorDefault: "#33D17AFF"
}, {
    key: "mem",
    caption: "MEM",
    ringColorKey: "memRingColor",
    ringColorDefault: "#3584E4FF"
}, {
    key: "hdd",
    caption: "DSK",
    ringColorKey: "hddRingColor",
    ringColorDefault: "#F5C211FF"
} ];

export default class CirclesSystemNestedWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._metrics = new SystemMetricsService;
        this._timerId = null;
        this._fractions = {
            cpu: 0,
            mem: 0,
            hdd: 0
        };
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "circles-system-nested-root"
        });
        this._actor = this._layers.root;
        const outerBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true
        });
        this._layers.content.add_child(outerBox);
        outerBox.set_style("padding: 14px;");
        this._stack = new St.Widget({
            layout_manager: new Clutter.BinLayout,
            width: RING_SIZE,
            height: RING_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true
        });
        outerBox.add_child(this._stack);
        this._ringArea = new St.DrawingArea({
            width: RING_SIZE,
            height: RING_SIZE
        });
        this._stack.add_child(this._ringArea);
        this._repaintId = this._ringArea.connect("repaint", () => this._onRepaint());
        this._centerBox = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true
        });
        this._stack.add_child(this._centerBox);
        this._centerLabels = {};
        for (const metric of METRICS) {
            const label = new St.Label({
                text: `${metric.caption} 0%`,
                x_align: Clutter.ActorAlign.CENTER
            });
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
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
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
    async _tick() {
        const {cpu: cpu, memory: memory} = await this._metrics.sample();
        const disk = this._getDiskUsage("/");
        this._fractions.cpu = Math.max(0, Math.min(100, cpu.percent ?? 0)) / 100;
        this._fractions.mem = Math.max(0, Math.min(100, memory.percent ?? 0)) / 100;
        this._fractions.hdd = Math.max(0, Math.min(100, disk.percent ?? 0)) / 100;
        this._render();
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
            this._api.logger.info(`circles-system-nested: could not read disk usage for ${path}: ${e}`);
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
        const showCenterText = this._settings.showCenterText ?? true;
        this._centerBox.visible = showCenterText;
        if (showCenterText) {
            const font = _parseFontDescription(this._settings.centerFont ?? "Sans Bold 10", "Sans Bold", 10);
            for (const metric of METRICS) {
                const color = _toCssColor(this._settings[metric.ringColorKey], metric.ringColorDefault);
                const label = this._centerLabels[metric.key];
                label.set_text(`${metric.caption} ${Math.round(this._fractions[metric.key] * 100)}%`);
                label.set_style(`color: ${color}; font-family: ${font.family}; ` + `font-size: ${font.size}px; font-weight: bold; text-align: center;`);
            }
        }
        if (this._ringArea) this._ringArea.queue_repaint();
    }
    _onRepaint() {
        const cr = this._ringArea.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        const thickness = Math.max(2, this._settings.ringThickness ?? 9);
        const gap = Math.max(0, this._settings.ringGap ?? 3);
        const baseColor = _hexToRgba(this._settings.circleBaseColor ?? "#FFFFFF26");
        const cx = RING_SIZE / 2;
        const cy = RING_SIZE / 2;
        const startAngle = -Math.PI / 2;
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(thickness);
        let radius = RING_SIZE / 2 - thickness / 2 - 2;
        for (const metric of METRICS) {
            const fraction = Math.max(0, Math.min(1, this._fractions[metric.key]));
            const ringColor = _hexToRgba(this._settings[metric.ringColorKey] ?? metric.ringColorDefault);
            cr.setSourceRGBA(baseColor.r, baseColor.g, baseColor.b, baseColor.a);
            cr.arc(cx, cy, radius, 0, 2 * Math.PI);
            cr.stroke();
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