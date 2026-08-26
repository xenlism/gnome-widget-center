import Clutter from "gi://Clutter";

import St from "gi://St";

import Gio from "gi://Gio";

import GLib from "gi://GLib";

import Cairo from "cairo";

import { SHADOW_DEFAULTS, hexToRgba as _hexToRgba, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
const RING_SIZE = 128;

const UPOWER_BUS_NAME = "org.freedesktop.UPower";

const UPOWER_DISPLAY_DEVICE_PATH = "/org/freedesktop/UPower/devices/DisplayDevice";

const UPOWER_DEVICE_IFACE = "org.freedesktop.UPower.Device";

const UP_DEVICE_STATE_CHARGING = 1;

const UP_DEVICE_STATE_PENDING_CHARGE = 5;

export default class CirclesBatteryWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._fraction = 0;
        this._upowerProxy = null;
        this._upowerSignalId = null;
        this._timerId = null;
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "circles-battery-root"
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
        this._textBox = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true
        });
        this._captionLabel = new St.Label({
            text: "BATTERY",
            x_align: Clutter.ActorAlign.CENTER
        });
        this._valueLabel = new St.Label({
            text: "0%",
            x_align: Clutter.ActorAlign.CENTER
        });
        this._textBox.add_child(this._captionLabel);
        this._textBox.add_child(this._valueLabel);
        this._stack.add_child(this._textBox);
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
            this._api.logger.error(`circles-battery: could not reach UPower: ${e.message}`);
            this._upowerProxy = null;
        }
        this._readBattery();
    }
    _readBattery() {
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
        const ringColorKey = this._currentRingColorSetting();
        const ringColorDefault = {
            ringColorLow: "#E01B24FF",
            ringColorMid: "#F5C211FF",
            ringColorHigh: "#33D17AFF",
            ringColorCharging: "#3584E4FF"
        }[ringColorKey];
        const ringColorCss = _toCssColor(this._settings[ringColorKey], ringColorDefault);
        if (this._textBox) this._textBox.visible = this._settings.showLabel ?? true;
        if (this._captionLabel) {
            const captionColor = _toCssColor(this._settings.captionColor, "#FFFFFFB3");
            const captionFont = _parseFontDescription(this._settings.captionFont ?? "Sans 10", "Sans", 10);
            this._captionLabel.set_text(this._settings.captionText ?? "BATTERY");
            this._captionLabel.set_style(`color: ${captionColor}; font-family: ${captionFont.family}; ` + `font-size: ${captionFont.size}px; text-align: center;`);
        }
        if (this._valueLabel) {
            const font = _parseFontDescription(this._settings.percentFont ?? "Sans Bold 22", "Sans Bold", 22);
            if (this._charging) {
                this._valueLabel.set_text("⚡");
                this._valueLabel.set_style(`color: ${ringColorCss}; font-family: ${font.family}; ` + `font-size: ${font.size}px; text-align: center;`);
            } else {
                const percentColor = _toCssColor(this._settings.percentColor, "#FFFFFFFF");
                this._valueLabel.set_text(`${Math.round(this._fraction * 100)}%`);
                this._valueLabel.set_style(`color: ${percentColor}; font-family: ${font.family}; ` + `font-size: ${font.size}px; font-weight: bold; text-align: center;`);
            }
        }
        if (this._ringArea) this._ringArea.queue_repaint();
    }
    _onRepaint() {
        const cr = this._ringArea.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        const thickness = Math.max(2, this._settings.ringThickness ?? 10);
        const baseColor = _hexToRgba(this._settings.circleBaseColor ?? "#FFFFFF26");
        const ringColorKey = this._currentRingColorSetting();
        const ringColorDefault = {
            ringColorLow: "#E01B24FF",
            ringColorMid: "#F5C211FF",
            ringColorHigh: "#33D17AFF",
            ringColorCharging: "#3584E4FF"
        }[ringColorKey];
        const ringColor = _hexToRgba(this._settings[ringColorKey] ?? ringColorDefault);
        const cx = RING_SIZE / 2;
        const cy = RING_SIZE / 2;
        const radius = (RING_SIZE - thickness) / 2 - 2;
        const startAngle = -Math.PI / 2;
        const fraction = Math.max(0, Math.min(1, this._fraction));
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
