import Clutter from "gi://Clutter";

import St from "gi://St";

import Gio from "gi://Gio";

import GLib from "gi://GLib";

import Meta from "gi://Meta";

import Cairo from "cairo";

import { SHADOW_DEFAULTS, hexToRgba as _hexToRgba, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/cardLayers.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
const EDGE_SNAP_DISTANCE = 250;

const RING_COLUMN_WIDTH = 74;

const CONTENT_HEIGHT = 148;

const COLUMN_GAP = 10;

const CARD_PADDING = 14;

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
        this._row = new St.BoxLayout({
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER
        });
        centerBin.set_child(this._row);
        this._ringArea = new St.DrawingArea({
            width: RING_COLUMN_WIDTH,
            height: CONTENT_HEIGHT,
            clip_to_allocation: true
        });
        this._repaintId = this._ringArea.connect("repaint", () => this._onRepaint());
        this._textBox = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._textBox.set_width(CONTENT_HEIGHT - RING_COLUMN_WIDTH - COLUMN_GAP > 0 ? CONTENT_HEIGHT - RING_COLUMN_WIDTH - COLUMN_GAP : 60);
        this._captionLabel = new St.Label({
            text: "BATTERY",
            x_align: Clutter.ActorAlign.CENTER
        });
        this._textBox.add_child(this._captionLabel);
        this._valueLabel = new St.Label({
            text: "0%",
            x_align: Clutter.ActorAlign.CENTER
        });
        this._textBox.add_child(this._valueLabel);
        this._layoutChildren();
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
            ...RING_COLOR_DEFAULTS,
        };
    }
    onSettingsChanged() {
        this._layoutChildren();
        this._render();
        this._startTimer();
    }
    _detectEdgeSide() {
        try {
            if (!this._actor || !this._actor.get_stage()) return null;
            const [x] = this._actor.get_transformed_position();
            const [width] = this._actor.get_transformed_size();
            if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return null;
            const monitorIndex = global.display.get_monitor_index_for_rect(new Meta.Rectangle({
                x: Math.round(x),
                y: 0,
                width: Math.max(1, Math.round(width)),
                height: 1
            }));
            const geometry = global.display.get_monitor_geometry(monitorIndex);
            if (!geometry) return null;
            const distLeft = x - geometry.x;
            const distRight = geometry.x + geometry.width - (x + width);
            if (distLeft <= EDGE_SNAP_DISTANCE && distLeft <= distRight) return "left";
            if (distRight <= EDGE_SNAP_DISTANCE) return "right";
        } catch (e) {}
        return null;
    }
    _layoutChildren() {
        const manual = this._settings.ringSide === "left" ? "left" : "right";
        const detected = this._detectEdgeSide();
        if (detected !== null && detected !== manual) this._settings.ringSide = detected;
        const side = detected ?? manual;
        this._row.remove_all_children();
        if (side === "left") {
            this._row.add_child(this._ringArea);
            this._row.add_child(new St.Widget({
                width: COLUMN_GAP,
                height: 1
            }));
            this._row.add_child(this._textBox);
        } else {
            this._row.add_child(this._textBox);
            this._row.add_child(new St.Widget({
                width: COLUMN_GAP,
                height: 1
            }));
            this._row.add_child(this._ringArea);
        }
        const push = side === "left" ? -CARD_PADDING : CARD_PADDING;
        this._ringArea.set_translation(push, 0, 0);
        if (this._ringArea) this._ringArea.queue_repaint();
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
        this._layoutChildren();
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
        if (this._ringArea) this._ringArea.queue_repaint();
    }
    _onRepaint() {
        const cr = this._ringArea.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        const side = this._settings.ringSide === "left" ? "left" : "right";
        const thickness = Math.max(2, this._settings.ringThickness ?? 10);
        const baseColor = _hexToRgba(this._settings.circleBaseColor ?? "#FFFFFF26");
        const ringColorKey = this._currentRingColorSetting();
        const ringColor = _hexToRgba(this._settings[ringColorKey] ?? RING_COLOR_DEFAULTS[ringColorKey]);
        const cx = side === "left" ? 0 : RING_COLUMN_WIDTH;
        const cy = CONTENT_HEIGHT / 2;
        // Keep the ring's tip clear of the card's own rounded corner.
        // The tip already sits CARD_PADDING (14px) in from the edge via
        // the translation in _layoutChildren(); if cornerRadius grows
        // past that, the tip paints into the card's transparent rounded
        // corner cutout and appears to poke out past the card outline.
        const cornerRadius = Number.isFinite(this._settings.cornerRadius) ? Math.max(0, this._settings.cornerRadius) : 18;
        const cornerClearance = Math.max(thickness / 2 + 2, cornerRadius - CARD_PADDING);
        const outerRadius = Math.min(RING_COLUMN_WIDTH - thickness / 2 - 2, CONTENT_HEIGHT / 2 - cornerClearance);
        const fraction = Math.max(0, Math.min(1, this._fraction));
        const start = -Math.PI / 2;
        // Single half-ring: one gauge, one radius. (Previously this looped
        // over two radii - a copy-paste leftover from circles-net-half,
        // which legitimately draws two concentric rings for download+upload.
        // This widget only has one metric, so the second pass just redrew
        // the same gauge again at a smaller radius - a duplicate ring.)
        if (outerRadius > 0) {
            cr.setLineWidth(thickness);
            cr.setLineCap(Cairo.LineCap.BUTT);
            cr.setSourceRGBA(baseColor.r, baseColor.g, baseColor.b, baseColor.a);
            if (side === "left") cr.arc(cx, cy, outerRadius, start, start + Math.PI); else cr.arcNegative(cx, cy, outerRadius, start, start - Math.PI);
            cr.stroke();
            if (fraction > 0) {
                cr.setSourceRGBA(ringColor.r, ringColor.g, ringColor.b, ringColor.a);
                if (side === "left") cr.arc(cx, cy, outerRadius, start, start + fraction * Math.PI); else cr.arcNegative(cx, cy, outerRadius, start, start - fraction * Math.PI);
                cr.stroke();
            }
        }
        cr.$dispose();
    }
}
