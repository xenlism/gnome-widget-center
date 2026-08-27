import Clutter from "gi://Clutter";

import St from "gi://St";

import GLib from "gi://GLib";

import { SystemMetricsService } from "../../lib/systemMetricsApi.js";

import { SHADOW_DEFAULTS, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";

import { HalfCircleGauge, CARD_PADDING } from "../../lib/shell/halfCircleGaugeKit.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
const MIN_DYNAMIC_SCALE_BYTES_PER_SEC = 8 * 1024;

const SCALE_HEADROOM = 1.25;

const SCALE_DECAY = .85;

function _formatRate(bytesPerSec) {
    const units = [ "B/s", "KB/s", "MB/s", "GB/s" ];
    let value = Math.max(0, bytesPerSec);
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }
    const decimals = i > 0 && value < 10 ? 1 : 0;
    return `${value.toFixed(decimals)} ${units[i]}`;
}

function _adaptiveFraction(bytesPerSec, previousScale) {
    const rate = Math.max(0, Number.isFinite(bytesPerSec) ? bytesPerSec : 0);
    const scale = Math.max(MIN_DYNAMIC_SCALE_BYTES_PER_SEC, rate * SCALE_HEADROOM, (Number.isFinite(previousScale) ? previousScale : 0) * SCALE_DECAY);
    return {
        scale: scale,
        fraction: Math.min(1, rate / scale)
    };
}

export default class CirclesNetHalfWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._metrics = new SystemMetricsService;
        this._timerId = null;
        this._downloadFraction = 0;
        this._uploadFraction = 0;
        this._downloadScale = MIN_DYNAMIC_SCALE_BYTES_PER_SEC;
        this._uploadScale = MIN_DYNAMIC_SCALE_BYTES_PER_SEC;
        this._gauge = new HalfCircleGauge(() => this._actor);
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "circles-net-half-root"
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
            text: "NET",
            x_align: Clutter.ActorAlign.CENTER
        });
        textBox.add_child(this._captionLabel);
        this._downloadLabel = new St.Label({
            x_align: Clutter.ActorAlign.CENTER
        });
        textBox.add_child(this._downloadLabel);
        this._uploadLabel = new St.Label({
            x_align: Clutter.ActorAlign.CENTER
        });
        textBox.add_child(this._uploadLabel);
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
        const {totalRxBytesPerSec: totalRxBytesPerSec, totalTxBytesPerSec: totalTxBytesPerSec} = await this._metrics.getNetworkUsage();
        const download = _adaptiveFraction(totalRxBytesPerSec, this._downloadScale);
        const upload = _adaptiveFraction(totalTxBytesPerSec, this._uploadScale);
        this._downloadScale = download.scale;
        this._uploadScale = upload.scale;
        this._downloadFraction = download.fraction;
        this._uploadFraction = upload.fraction;
        this._downloadLabel.set_text(`↓ ${_formatRate(totalRxBytesPerSec)}`);
        this._uploadLabel.set_text(`↑ ${_formatRate(totalTxBytesPerSec)}`);
        if (this._gauge.ringArea) this._gauge.ringArea.queue_repaint();
    }
    _render() {
        applyLayeredCardStyle(this._layers, this._settings, {
            backgroundColorFallback: "#FFFFFF00",
            cornerRadiusFallback: 18
        }, false);
        const captionColor = _toCssColor(this._settings.captionColor, "#FFFFFFB3");
        const captionFont = _parseFontDescription(this._settings.captionFont ?? "Sans 10", "Sans", 10);
        this._captionLabel.set_text(this._settings.captionText ?? "NET");
        this._captionLabel.set_style(`color: ${captionColor}; font-family: ${captionFont.family}; ` + `font-size: ${captionFont.size}px; text-align: center;`);
        const downloadColor = _toCssColor(this._settings.downloadColor, "#5AC8FAFF");
        const uploadColor = _toCssColor(this._settings.uploadColor, "#FF9F0AFF");
        const valueFont = _parseFontDescription(this._settings.valueFont ?? "Sans Bold 13", "Sans Bold", 13);
        this._downloadLabel.set_style(`color: ${downloadColor}; font-family: ${valueFont.family}; ` + `font-size: ${valueFont.size}px; font-weight: bold; text-align: center;`);
        this._uploadLabel.set_style(`color: ${uploadColor}; font-family: ${valueFont.family}; ` + `font-size: ${valueFont.size}px; font-weight: bold; text-align: center;`);
        if (this._gauge.ringArea) this._gauge.ringArea.queue_repaint();
    }
    _onRepaint() {
        this._gauge.paintRings({
            settings: this._settings,
            rings: [ {
                fraction: this._downloadFraction,
                color: this._settings.downloadColor ?? "#5AC8FAFF"
            }, {
                fraction: this._uploadFraction,
                color: this._settings.uploadColor ?? "#FF9F0AFF"
            } ]
        });
    }
}
