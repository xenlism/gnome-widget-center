import Clutter from "gi://Clutter";

import St from "gi://St";

import Gio from "gi://Gio";

import GLib from "gi://GLib";

import { SHADOW_DEFAULTS, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/cardLayers.js";

import { HalfCircleGauge, CARD_PADDING } from "../../lib/halfCircleGaugeKit.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
const UPOWER_BUS_NAME = "org.freedesktop.UPower";

const UPOWER_DISPLAY_DEVICE_PATH = "/org/freedesktop/UPower/devices/DisplayDevice";

const UPOWER_DEVICE_IFACE = "org.freedesktop.UPower.Device";

const UP_DEVICE_STATE_CHARGING = 1;

const UP_DEVICE_STATE_PENDING_CHARGE = 5;

const RING_COLOR_DEFAULTS = {
    ringColorLow: "#E01B24FF",
    ringColorMid: "#F5C211FF",
    ringColorHigh: "#33D17AFF",
    ringColorCharging: "#3584E4FF"
};

export default class CirclesBatteryHalfWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._fraction = 0;
        this._charging = false;
        this._upowerProxy = null;
        this._upowerSignalId = null;
        this._timerId = null;
        this._gauge = new HalfCircleGauge(() => this._actor);
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "circles-battery-half-root"
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
            text: "BATTERY",
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
        return this._actor;
    }
    enable() {
        this._connectUPower();
        this._startTimer();
    }
    disable() {
        this._stopTimer();
        if (this._upowerProxy && this._upowerSignalId !== null) {
            try {
                this._upowerProxy.disconnect(this._upowerSignalId);
            } catch (e) {}
        }
        this._upowerProxy = null;
        this._upowerSignalId = null;
        this._gauge.destroy();
    }
    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
            ...RING_COLOR_DEFAULTS,
        };
    }
    onSettingsChanged() {
        this._gauge.layoutChildren(this._settings);
        this._render();
        this._startTimer();
    }
    _startTimer() {
        this._stopTimer();
        const seconds = Math.max(1, this._settings.refreshRateSeconds ?? 5);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._readBattery();
            return GLib.SOURCE_CONTINUE;
        });
    }
    _stopTimer() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }
    _connectUPower() {
        try {
            this._upowerProxy = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null, UPOWER_BUS_NAME, UPOWER_DISPLAY_DEVICE_PATH, UPOWER_DEVICE_IFACE, null);
            this._upowerSignalId = this._upowerProxy.connect("g-properties-changed", () => this._readBattery());
        } catch (e) {
            this._api.logger.error(`circles-battery-half: could not reach UPower: ${e.message}`);
            this._upowerProxy = null;
        }
        this._readBattery();
    }
    _readBattery() {
        this._gauge.layoutChildren(this._settings);
        const isPresent = this._upowerProxy?.get_cached_property("IsPresent")?.unpack() ?? false;
        const percent = this._upowerProxy?.get_cached_property("Percentage")?.unpack() ?? 0;
        const state = this._upowerProxy?.get_cached_property("State")?.unpack() ?? 0;
        const clamped = isPresent ? Math.max(0, Math.min(100, percent)) : 0;
        const charging = isPresent && (state === UP_DEVICE_STATE_CHARGING || state === UP_DEVICE_STATE_PENDING_CHARGE);
        this._fraction = clamped / 100;
        this._charging = charging;
        this._render();
    }
    _currentRingColorSetting() {
        if (this._charging) return "ringColorCharging";
        if (this._fraction * 100 <= 20) return "ringColorLow";
        if (this._fraction * 100 < 50) return "ringColorMid";
        return "ringColorHigh";
    }
    _render() {
        applyLayeredCardStyle(this._layers, this._settings, {
            backgroundColorFallback: "#FFFFFF00",
            cornerRadiusFallback: 18
        }, false);
        const captionColor = _toCssColor(this._settings.captionColor, "#FFFFFFB3");
        const captionFont = _parseFontDescription(this._settings.captionFont ?? "Sans 10", "Sans", 10);
        this._captionLabel.set_text(this._settings.captionText ?? "BATTERY");
        this._captionLabel.set_style(`color: ${captionColor}; font-family: ${captionFont.family}; ` + `font-size: ${captionFont.size}px; text-align: center;`);
        const ringColorKey = this._currentRingColorSetting();
        const ringColorCss = _toCssColor(this._settings[ringColorKey], RING_COLOR_DEFAULTS[ringColorKey]);
        const font = _parseFontDescription(this._settings.percentFont ?? "Sans Bold 24", "Sans Bold", 24);
        if (this._charging) {
            this._valueLabel.set_text("⚡");
            this._valueLabel.set_style(`color: ${ringColorCss}; font-family: ${font.family}; ` + `font-size: ${font.size}px; text-align: center;`);
        } else {
            const percentColor = _toCssColor(this._settings.percentColor, "#FFFFFFFF");
            this._valueLabel.set_text(`${Math.round(this._fraction * 100)}%`);
            this._valueLabel.set_style(`color: ${percentColor}; font-family: ${font.family}; ` + `font-size: ${font.size}px; font-weight: bold; text-align: center;`);
        }
        if (this._gauge.ringArea) this._gauge.ringArea.queue_repaint();
    }
    _onRepaint() {
        // Two concentric half-rings, both showing the same battery value.
        // This mirrors circles-net-half's two-ring look; unlike net (which
        // has two distinct metrics, download+upload), battery only has one
        // metric, so both ring entries share the same fraction/color.
        const ringColorKey = this._currentRingColorSetting();
        const color = this._settings[ringColorKey] ?? RING_COLOR_DEFAULTS[ringColorKey];
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
