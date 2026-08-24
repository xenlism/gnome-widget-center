import Clutter from "gi://Clutter";

import St from "gi://St";

import GLib from "gi://GLib";

import Meta from "gi://Meta";

import Gio from "gi://Gio";

import Cairo from "cairo";

import { SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, hexToRgba as _hexToRgba, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/cardLayers.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
const RING_COLUMN_WIDTH = 74;

const CONTENT_HEIGHT = 148;

const COLUMN_GAP = 10;

const CARD_PADDING = 14;

const EDGE_SNAP_DISTANCE = 250;

export default class CirclesDiskHalfWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timerId = null;
        this._fraction = 0;
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "circles-disk-half-root"
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
            height: CONTENT_HEIGHT
        });
        this._repaintId = this._ringArea.connect("repaint", () => this._onRepaint());
        this._textBox = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._textBox.set_width(CONTENT_HEIGHT - RING_COLUMN_WIDTH - COLUMN_GAP > 0 ? CONTENT_HEIGHT - RING_COLUMN_WIDTH - COLUMN_GAP : 60);
        this._captionLabel = new St.Label({
            text: "HDD",
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
        this._ringArea.set_translation(side === "left" ? -CARD_PADDING : CARD_PADDING, 0, 0);
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
        if (this._ringArea) this._ringArea.queue_repaint();
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
        this._layoutChildren();
        const disk = this._getDiskUsage("/");
        this._fraction = Math.max(0, Math.min(100, disk.percent ?? 0)) / 100;
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
            this._api.logger.info(`circles-disk-half: could not read disk usage for ${path}: ${e}`);
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
        const captionFont = _parseFontDescription(this._settings.captionFont ?? "Sans 10", "Sans", 10);
        this._captionLabel.set_text(this._settings.captionText ?? "HDD");
        this._captionLabel.set_style(`color: ${captionColor}; font-family: ${captionFont.family}; ` + `font-size: ${captionFont.size}px; text-align: center;`);
        const valueColor = _toCssColor(this._settings.hddValueColor, "#FFFFFFFF");
        const valueFont = _parseFontDescription(this._settings.hddValueFont ?? "Sans Bold 24", "Sans Bold", 24);
        this._valueLabel.set_text(`${Math.round(this._fraction * 100)}%`);
        this._valueLabel.set_style(`color: ${valueColor}; font-family: ${valueFont.family}; ` + `font-size: ${valueFont.size}px; font-weight: bold; text-align: center;`);
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
        const ringColor = _hexToRgba(this._settings.hddRingColor ?? "#F5C211FF");
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