import Clutter from "gi://Clutter";

import St from "gi://St";

import GLib from "gi://GLib";

import Gio from "gi://Gio";

import Cairo from "cairo";

import { SystemMetricsService } from "../../lib/systemMetricsApi.js";

import { SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, hexToRgba as _hexToRgba, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, cardStyleCss as _cardStyleCss, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/cardLayers.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
const RING_SIZE = 84;

const RING_THICKNESS = 8;

const RING_SPACING = 16;

const CARD_PADDING = 12;

export default class SystemMonitorMiniWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._metrics = new SystemMetricsService;
        this._timerId = null;
        this._buttonPressId = null;
        this._gauges = [];
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "system-monitor-mini-root"
        });
        this._actor = this._layers.root;
        this._content = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER
        });
        this._layers.content.add_child(this._content);
        const ringsRow = new St.BoxLayout({
            vertical: false,
            x_align: Clutter.ActorAlign.CENTER
        });
        this._gauges.push(this._buildGauge(ringsRow, "CPU"));
        ringsRow.add_child(new St.Widget({
            width: RING_SPACING,
            height: 1
        }));
        this._gauges.push(this._buildGauge(ringsRow, "Memory"));
        ringsRow.add_child(new St.Widget({
            width: RING_SPACING,
            height: 1
        }));
        this._gauges.push(this._buildGauge(ringsRow, "Disk"));
        this._content.add_child(ringsRow);
        this._networkLabel = new St.Label({
            style_class: "system-monitor-mini-net-caption"
        });
        this._networkLabel.set_style("margin-top: 10px; text-align: center;");
        this._content.add_child(this._networkLabel);
        this._networkValue = new St.Label({
            style_class: "system-monitor-mini-net-value"
        });
        this._networkValue.set_style("text-align: center;");
        this._content.add_child(this._networkValue);
        this._render();
        this._applyClickHandler();
        return this._actor;
    }
    _buildGauge(parentRow, caption) {
        const stack = new St.Widget({
            layout_manager: new Clutter.BinLayout,
            width: RING_SIZE,
            height: RING_SIZE
        });
        const area = new St.DrawingArea({
            width: RING_SIZE,
            height: RING_SIZE
        });
        stack.add_child(area);
        const textBox = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true
        });
        const captionLabel = new St.Label({
            text: caption
        });
        const valueLabel = new St.Label({
            text: "0%"
        });
        textBox.add_child(captionLabel);
        textBox.add_child(valueLabel);
        stack.add_child(textBox);
        parentRow.add_child(stack);
        const gauge = {
            area: area,
            fraction: 0,
            captionLabel: captionLabel,
            valueLabel: valueLabel
        };
        area.connect("repaint", () => this._repaintGauge(gauge));
        return gauge;
    }
    _repaintGauge(gauge) {
        const cr = gauge.area.get_context();
        const activeColor = _hexToRgba(this._settings.activeColor ?? "#33C7F5");
        const baseColor = _hexToRgba(this._settings.baseColor ?? "#33383D");
        const cx = RING_SIZE / 2;
        const cy = RING_SIZE / 2;
        const radius = (RING_SIZE - RING_THICKNESS) / 2;
        const startAngle = -Math.PI / 2;
        const fraction = Math.max(0, Math.min(1, gauge.fraction));
        const endAngle = startAngle + fraction * 2 * Math.PI;
        cr.setLineWidth(RING_THICKNESS);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setSourceRGBA(baseColor.r, baseColor.g, baseColor.b, baseColor.a);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();
        if (fraction > 0) {
            cr.setSourceRGBA(activeColor.r, activeColor.g, activeColor.b, activeColor.a);
            cr.arc(cx, cy, radius, startAngle, endAngle);
            cr.stroke();
        }
        cr.$dispose();
    }
    enable() {
        this._startTimer();
    }
    disable() {
        this._destroyTimer();
        this._removeClickHandler();
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
        this._applyClickHandler();
        this._startTimer();
    }
    _startTimer() {
        this._destroyTimer();
        const refreshRateSec = Math.max(1, this._settings.refreshRateSec ?? 3);
        this._updateStats();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, refreshRateSec, () => {
            this._updateStats();
            return GLib.SOURCE_CONTINUE;
        });
    }
    _destroyTimer() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }
    _updateStats() {
        const {cpu: cpu, memory: memory, network: network} = this._metrics.sample();
        const disk = this._getDiskUsage("/");
        this._setGauge(this._gauges[0], cpu.percent);
        this._setGauge(this._gauges[1], memory.percent);
        this._setGauge(this._gauges[2], disk.percent);
        this._networkValue.set_text(`↓ ${this._formatBytesPerSec(network.totalRxBytesPerSec)}   ` + `↑ ${this._formatBytesPerSec(network.totalTxBytesPerSec)}`);
    }
    _setGauge(gauge, percent) {
        const clamped = Math.max(0, Math.min(100, percent ?? 0));
        gauge.fraction = clamped / 100;
        gauge.valueLabel.set_text(`${Math.round(clamped)}%`);
        gauge.area.queue_repaint();
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
            this._api.logger.info(`system-monitor-mini: could not read disk usage for ${path}: ${e}`);
            return {
                totalBytes: 0,
                freeBytes: 0,
                usedBytes: 0,
                percent: 0
            };
        }
    }
    _formatBytesPerSec(bytesPerSec) {
        const units = [ "B/s", "KB/s", "MB/s", "GB/s" ];
        let value = bytesPerSec;
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex += 1;
        }
        const formatted = unitIndex === 0 ? String(Math.round(value)) : value.toFixed(1);
        return `${formatted} ${units[unitIndex]}`;
    }
    _render() {
        applyLayeredCardStyle(this._layers, this._settings, {
            cornerRadiusFallback: 18
        }, false);
        this._content.set_style(`padding: ${CARD_PADDING}px;`);
        const {family: family, size: size} = _parseFontDescription(this._settings.font ?? "Sans Bold 18", "Sans Bold", 18);
        const captionSize = Math.max(8, Math.round(size * .5));
        for (const gauge of this._gauges) {
            gauge.captionLabel.set_style(`color: rgba(255,255,255,0.65); font-family: ${family}; ` + `font-size: ${captionSize}px; font-weight: normal; text-align: center;`);
            gauge.valueLabel.set_style(`color: #ffffff; font-family: ${family}; ` + `font-size: ${size}px; font-weight: bold; text-align: center;`);
            gauge.area.queue_repaint();
        }
        this._networkLabel.set_text("Network");
        this._networkLabel.set_style(`color: rgba(255,255,255,0.65); font-family: ${family}; ` + `font-size: ${captionSize}px; font-weight: normal; text-align: center; margin-top: 10px;`);
        this._networkValue.set_style(`color: #ffffff; font-family: ${family}; ` + `font-size: ${captionSize}px; font-weight: normal; text-align: center;`);
    }
    _applyClickHandler() {
        this._removeClickHandler();
        const launchOnClick = this._settings.launchOnClick ?? false;
        const desktopFilePath = this._settings.desktopFilePath ?? "";
        if (!launchOnClick || !desktopFilePath) return;
        this._actor.reactive = true;
        this._buttonPressId = this._actor.connect("button-press-event", (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
            if (event.get_state() & Clutter.ModifierType.MOD4_MASK) return Clutter.EVENT_PROPAGATE;
            this._launchApp(desktopFilePath);
            return Clutter.EVENT_STOP;
        });
    }
    _removeClickHandler() {
        if (this._buttonPressId !== null) {
            this._actor.disconnect(this._buttonPressId);
            this._buttonPressId = null;
        }
    }
    _launchApp(path) {
        try {
            const appInfo = Gio.DesktopAppInfo.new_from_filename(path);
            if (!appInfo) {
                this._api.logger.info(`system-monitor-mini: could not read .desktop file at ${path}`);
                return;
            }
            appInfo.launch([], null);
        } catch (e) {
            this._api.logger.info(`system-monitor-mini: failed to launch ${path}: ${e}`);
        }
    }
}