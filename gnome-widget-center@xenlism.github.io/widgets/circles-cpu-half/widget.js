import Clutter from "gi://Clutter";

import St from "gi://St";

import GLib from "gi://GLib";

import { SystemMetricsService } from "../../lib/systemMetricsApi.js";

import { SHADOW_DEFAULTS, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";

import { HalfCircleGauge, CARD_PADDING } from "../../lib/shell/halfCircleGaugeKit.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';

export default class CirclesCpuHalfWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._metrics = new SystemMetricsService;
        this._timerId = null;
        this._fraction = 0;
        this._gauge = new HalfCircleGauge(() => this._actor);
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "circles-cpu-half-root"
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
        const {textBox: textBox} = this._gauge.build(centerBin, () => this._onRepaint());
        this._captionLabel = new St.Label({
            text: "CPU",
            x_align: Clutter.ActorAlign.CENTER
        });
        textBox.add_child(this._captionLabel);
        this._valueLabel = new St.Label({
            text: "0%",
            x_align: Clutter.ActorAlign.CENTER
        });
        textBox.add_child(this._valueLabel);
        this._gauge.layoutChildren(this._settings);
        this._render();
        this._tick();
        return this._actor;
    }
    enable() {
        this._startTimer();
    }
    disable() {
        this._stopTimer();
        this._gauge.destroy();
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
        this._gauge.layoutChildren(this._settings);
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
        this._gauge.layoutChildren(this._settings);
        const {cpu: cpu} = await this._metrics.sample();
        this._fraction = Math.max(0, Math.min(100, cpu.percent ?? 0)) / 100;
        this._render();
    }
    _render() {
        applyLayeredCardStyle(this._layers, this._settings, {
            backgroundColorFallback: "#FFFFFF00",
            cornerRadiusFallback: 18
        }, false);
        const captionColor = _toCssColor(this._settings.captionColor, "#FFFFFFB3");
        const captionFont = _parseFontDescription(this._settings.captionFont ?? "Sans 10", "Sans", 10);
        this._captionLabel.set_text(this._settings.captionText ?? "CPU");
        this._captionLabel.set_style(`color: ${captionColor}; font-family: ${captionFont.family}; ` + `font-size: ${captionFont.size}px; text-align: center;`);
        const valueColor = _toCssColor(this._settings.cpuValueColor, "#FFFFFFFF");
        const valueFont = _parseFontDescription(this._settings.cpuValueFont ?? "Sans Bold 24", "Sans Bold", 24);
        this._valueLabel.set_text(`${Math.round(this._fraction * 100)}%`);
        this._valueLabel.set_style(`color: ${valueColor}; font-family: ${valueFont.family}; ` + `font-size: ${valueFont.size}px; font-weight: bold; text-align: center;`);
        if (this._gauge.ringArea) this._gauge.ringArea.queue_repaint();
    }
    _onRepaint() {
        const color = this._settings.cpuRingColor ?? "#33D17AFF";
        this._gauge.paintRings({
            settings: this._settings,
            rings: [ {
                fraction: this._fraction,
                color: color
            }, {
                fraction: this._fraction,
                color: color
            } ]
        });
    }
}
