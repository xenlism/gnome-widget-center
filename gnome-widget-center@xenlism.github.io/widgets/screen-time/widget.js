import Clutter from "gi://Clutter";

import St from "gi://St";

import GLib from "gi://GLib";

import Cairo from "cairo";

import { SHADOW_DEFAULTS, hexToRgba as _hexToRgba, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";

import { configJsonDefaults } from "../../lib/widgetConfigDefaults.js";

const BAR_HEIGHT = 8;

// Flush the in-memory accumulated-seconds counter to disk (via
// this._settings, which WidgetSettings persists) at most this often,
// rather than on every single poll - screen time only needs to survive
// a Shell restart to within about a minute of accuracy.
const FLUSH_EVERY_SECONDS = 60;

function _todayString() {
    const now = GLib.DateTime.new_now_local();
    return now.format("%Y-%m-%d");
}

function _formatDuration(totalSeconds) {
    const clamped = Math.max(0, Math.round(totalSeconds));
    const hours = Math.floor(clamped / 3600);
    const minutes = Math.floor(clamped % 3600 / 60);
    if (hours <= 0) return `${minutes}m`;
    return `${hours}h ${minutes}m`;
}

export default class ScreenTimeWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._pollTimerId = null;
        this._todaySeconds = 0;
        this._unflushedSeconds = 0;
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "screen-time-root"
        });
        this._actor = this._layers.root;
        const outerBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_expand: true
        });
        outerBox.set_style("padding: 14px; spacing: 12px;");
        this._layers.content.add_child(outerBox);
        this._icon = new St.Icon({
            icon_name: "preferences-system-time-symbolic",
            icon_size: 32,
            y_align: Clutter.ActorAlign.CENTER
        });
        outerBox.add_child(this._icon);
        const textColumn = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        textColumn.set_style("spacing: 4px;");
        outerBox.add_child(textColumn);
        this._captionLabel = new St.Label({
            text: "SCREEN TIME"
        });
        this._valueLabel = new St.Label({
            text: "0m"
        });
        this._barArea = new St.DrawingArea({
            height: BAR_HEIGHT,
            x_expand: true
        });
        this._barRepaintId = this._barArea.connect("repaint", area => this._onBarRepaint(area));
        this._subCaptionLabel = new St.Label({
            text: ""
        });
        textColumn.add_child(this._captionLabel);
        textColumn.add_child(this._valueLabel);
        textColumn.add_child(this._barArea);
        textColumn.add_child(this._subCaptionLabel);
        this._normalizeState();
        this._render();
        return this._actor;
    }
    enable() {
        this._startPolling();
    }
    disable() {
        this._stopPolling();
        this._flush(true);
        if (this._barRepaintId !== null && this._barArea) {
            this._barArea.disconnect(this._barRepaintId);
            this._barRepaintId = null;
        }
    }
    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS
        };
    }
    onSettingsChanged() {
        this._render();
        this._startPolling();
    }
    // --- state ------------------------------------------------------
    _normalizeState() {
        const today = _todayString();
        if (this._settings.screenTimeDate !== today) {
            this._settings.screenTimeDate = today;
            this._settings.screenTimeSecondsToday = 0;
        }
        this._todaySeconds = Math.max(0, Number(this._settings.screenTimeSecondsToday) || 0);
        this._unflushedSeconds = 0;
    }
    _flush(force = false) {
        if (!force && this._unflushedSeconds < FLUSH_EVERY_SECONDS) return;
        this._settings.screenTimeDate = _todayString();
        this._settings.screenTimeSecondsToday = this._todaySeconds;
        this._unflushedSeconds = 0;
    }
    _startPolling() {
        this._stopPolling();
        const seconds = Math.max(5, this._settings.pollSeconds ?? 15);
        this._pollTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._poll(seconds);
            return GLib.SOURCE_CONTINUE;
        });
    }
    _stopPolling() {
        if (this._pollTimerId !== null) {
            GLib.source_remove(this._pollTimerId);
            this._pollTimerId = null;
        }
    }
    _poll(pollIntervalSeconds) {
        const today = _todayString();
        if (this._settings.screenTimeDate !== today) {
            // Rolled over into a new day - flush yesterday's total, then
            // start today at zero.
            this._flush(true);
            this._settings.screenTimeDate = today;
            this._settings.screenTimeSecondsToday = 0;
            this._todaySeconds = 0;
        }
        let idleMs = Infinity;
        try {
            idleMs = global.backend.get_core_idle_monitor().get_idletime();
        } catch (e) {
            this._api.logger.warn?.(`screen-time: could not read idle time: ${e.message}`);
        }
        const idleThresholdMs = Math.max(1, this._settings.idleThresholdSeconds ?? 60) * 1000;
        if (idleMs < idleThresholdMs) {
            this._todaySeconds += pollIntervalSeconds;
            this._unflushedSeconds += pollIntervalSeconds;
            this._flush(false);
        }
        this._render();
    }
    // --- rendering ----------------------------------------------------
    _goalSeconds() {
        return Math.max(1, this._settings.dailyGoalHours ?? 6) * 3600;
    }
    _currentBarColorHex() {
        const percent = this._todaySeconds / this._goalSeconds() * 100;
        const pick = (value, fallback) => typeof value === "string" && value ? value : fallback;
        if (percent > 100) return pick(this._settings.barColorOver, "#E01B24FF");
        if (percent >= 70) return pick(this._settings.barColorWarn, "#F5C211FF");
        return pick(this._settings.barColorGood, "#33D17AFF");
    }
    _render() {
        applyLayeredCardStyle(this._layers, this._settings, {
            backgroundColorFallback: "#1B1E2AF5",
            cornerRadiusFallback: 18
        }, false);
        if (this._icon) {
            this._icon.visible = this._settings.showIcon ?? true;
            this._icon.set_style(`color: ${_toCssColor(this._settings.iconColor, "#FFFFFFB3")};`);
        }
        if (this._captionLabel) {
            const font = _parseFontDescription(this._settings.captionFont ?? "Sans Bold 9", "Sans Bold", 9);
            this._captionLabel.set_text(this._settings.captionText ?? "SCREEN TIME");
            this._captionLabel.set_style(`color: ${_toCssColor(this._settings.captionColor, "#FFFFFFB3")}; ` + `font-family: ${font.family}; font-size: ${font.size}px; letter-spacing: 1px;`);
        }
        if (this._valueLabel) {
            const font = _parseFontDescription(this._settings.valueFont ?? "Sans Bold 20", "Sans Bold", 20);
            this._valueLabel.set_text(_formatDuration(this._todaySeconds));
            this._valueLabel.set_style(`color: ${_toCssColor(this._settings.valueColor, "#FFFFFFFF")}; ` + `font-family: ${font.family}; font-size: ${font.size}px; font-weight: bold;`);
        }
        if (this._subCaptionLabel) {
            const goalHours = Math.max(1, this._settings.dailyGoalHours ?? 6);
            const percent = Math.round(this._todaySeconds / this._goalSeconds() * 100);
            this._subCaptionLabel.set_text(`of ${goalHours}h goal \u00b7 ${percent}%`);
            this._subCaptionLabel.set_style(`color: ${_toCssColor(this._settings.subCaptionColor, "#FFFFFF80")}; font-size: 9px;`);
        }
        if (this._barArea) this._barArea.queue_repaint();
    }
    _onBarRepaint(area) {
        const cr = area.get_context();
        const [ width, height ] = area.get_surface_size();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        const radius = height / 2;
        const trackColor = _hexToRgba(this._settings.barTrackColor ?? "#FFFFFF26");
        cr.setSourceRGBA(trackColor.r, trackColor.g, trackColor.b, trackColor.a);
        this._roundedRect(cr, 0, 0, width, height, radius);
        cr.fill();
        const fraction = Math.max(0, Math.min(1, this._todaySeconds / this._goalSeconds()));
        if (fraction > 0) {
            const fillWidth = Math.max(height, width * fraction);
            const fillColor = _hexToRgba(this._currentBarColorHex());
            cr.setSourceRGBA(fillColor.r, fillColor.g, fillColor.b, fillColor.a);
            this._roundedRect(cr, 0, 0, fillWidth, height, radius);
            cr.fill();
        }
        cr.$dispose();
    }
    _roundedRect(cr, x, y, width, height, radius) {
        const r = Math.min(radius, height / 2, width / 2 || radius);
        cr.newSubPath();
        cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
        cr.closePath();
    }
}
