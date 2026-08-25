// lib/halfCircleGaugeKit.js
//
// Shared scaffolding for the "circles-*-half" widget family
// (circles-battery-half, circles-cpu-half, circles-disk-half,
// circles-mem-half, circles-net-half). All five render the same
// visual shape - a half-circle ring gauge (one or more concentric
// rings) docked to whichever screen edge the widget is nearest,
// beside a caption + value text column - and, before this module
// existed, each widget.js carried its own byte-for-byte copy of:
//   - edge-snap side detection (_detectEdgeSide)
//   - ring/text row layout + child reordering (_layoutChildren)
//   - concentric half-ring painting (_onRepaint)
//
// Only the metric source (UPower / SystemMetricsService / disk
// usage) and the text/color mapping differ per widget; that part
// stays in each widget.js. Each widget still owns its own class
// (buildActor/enable/disable/getDefaultSettings/onSettingsChanged,
// per WIDGET_API.md §3) and *composes* a HalfCircleGauge instance
// rather than subclassing it - lib/widgetLoader.js dynamically
// imports each widget.js's default export directly, so the
// per-widget class shape must stay intact.

import Clutter from "gi://Clutter";

import St from "gi://St";

import Meta from "gi://Meta";

import Cairo from "cairo";

import { hexToRgba as _hexToRgba } from "./widgetVisualKit.js";

export const RING_COLUMN_WIDTH = 74;

export const CONTENT_HEIGHT = 148;

export const COLUMN_GAP = 10;

export const RING_GAP = 4;

export const CARD_PADDING = 14;

export const EDGE_SNAP_DISTANCE = 250;

export class HalfCircleGauge {
    /**
     * @param {() => St.Widget|null} getActor - returns the widget's
     *   root actor (this._actor), used for edge-snap detection. Passed
     *   as a getter rather than a value since it's still null the first
     *   time buildActor() runs.
     */
    constructor(getActor) {
        this._getActor = getActor;
        this.row = null;
        this.ringArea = null;
        this.textBox = null;
        this._repaintId = null;
    }

    /**
     * Builds the ring DrawingArea + text column and appends them as
     * children of a new row, which is itself added to `parent`. Returns
     * { row, ringArea, textBox } (also stored on `this`) so the caller
     * can add caption/value labels into `textBox`.
     *
     * @param {St.Widget} parent - typically a centered St.Bin
     * @param {() => void} onRepaint - connected to ringArea's "repaint"
     */
    build(parent, onRepaint) {
        this.row = new St.BoxLayout({
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER
        });
        if (typeof parent.set_child === "function") parent.set_child(this.row); else parent.add_child(this.row);
        this.ringArea = new St.DrawingArea({
            width: RING_COLUMN_WIDTH,
            height: CONTENT_HEIGHT,
            clip_to_allocation: true
        });
        this._repaintId = this.ringArea.connect("repaint", onRepaint);
        this.textBox = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        this.textBox.set_width(CONTENT_HEIGHT - RING_COLUMN_WIDTH - COLUMN_GAP > 0 ? CONTENT_HEIGHT - RING_COLUMN_WIDTH - COLUMN_GAP : 60);
        return {
            row: this.row,
            ringArea: this.ringArea,
            textBox: this.textBox
        };
    }

    /** Disconnects the "repaint" signal. Call from the widget's disable(). */
    destroy() {
        if (this._repaintId !== null && this.ringArea) {
            this.ringArea.disconnect(this._repaintId);
            this._repaintId = null;
        }
    }

    /**
     * Returns "left"/"right" if the widget is currently docked within
     * EDGE_SNAP_DISTANCE of a monitor edge, or null if it's free-floating
     * (in which case the caller should fall back to settings.ringSide).
     */
    detectEdgeSide() {
        try {
            const actor = this._getActor();
            if (!actor || !actor.get_stage()) return null;
            const [x] = actor.get_transformed_position();
            const [width] = actor.get_transformed_size();
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

    /**
     * Resolves manual vs. auto-detected side, reorders the row's
     * children (ring-then-text when docked left, text-then-ring when
     * docked right), and applies the ring's edge-clearing translation.
     * Mutates `settings.ringSide` in place when auto-detection disagrees
     * with the stored value, matching every widget's prior behavior.
     * Returns the resolved side ("left" | "right") for _onRepaint to use.
     */
    layoutChildren(settings) {
        const manual = settings.ringSide === "left" ? "left" : "right";
        const detected = this.detectEdgeSide();
        if (detected !== null && detected !== manual) settings.ringSide = detected;
        const side = detected ?? manual;
        this.ringArea.set_translation(side === "left" ? -CARD_PADDING : CARD_PADDING, 0, 0);
        this.row.remove_all_children();
        const gap = new St.Widget({
            width: COLUMN_GAP,
            height: 1
        });
        if (side === "left") {
            this.row.add_child(this.ringArea);
            this.row.add_child(gap);
            this.row.add_child(this.textBox);
        } else {
            this.row.add_child(this.textBox);
            this.row.add_child(gap);
            this.row.add_child(this.ringArea);
        }
        if (this.ringArea) this.ringArea.queue_repaint();
        return side;
    }

    /**
     * Paints one or more concentric half-ring gauges into `this.ringArea`,
     * outermost ring first. A single-entry `rings` array draws the classic
     * one-metric gauge (battery/cpu/disk/mem); a multi-entry array draws
     * concentric rings spaced by RING_GAP (net's download+upload, or any
     * widget showing the same value on 2 rings for visual consistency).
     *
     * @param {object} opts
     * @param {object} opts.settings - widget settings (for ringSide,
     *   cornerRadius, ringThickness)
     * @param {number} [opts.thickness] - ring stroke width in px
     * @param {string} [opts.baseColor] - 8-char hex for the unfilled track
     * @param {{fraction: number, color: string}[]} opts.rings - outermost
     *   ring first; `color` is an 8-char hex settings value
     */
    paintRings({settings: settings, thickness: thicknessArg, baseColor: baseColorArg, rings: rings}) {
        const cr = this.ringArea.get_context();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        const side = settings.ringSide === "left" ? "left" : "right";
        const thickness = Math.max(2, thicknessArg ?? settings.ringThickness ?? 10);
        const baseColor = _hexToRgba(baseColorArg ?? settings.circleBaseColor ?? "#FFFFFF26");
        const cx = side === "left" ? 0 : RING_COLUMN_WIDTH;
        const cy = CONTENT_HEIGHT / 2;
        // Keep the outermost ring's tip clear of the card's own rounded
        // corner. The tip already sits CARD_PADDING (14px) in from the
        // edge via the translation in layoutChildren(); if cornerRadius
        // grows past that, the tip paints into the card's transparent
        // rounded-corner cutout and appears to poke out past the card
        // outline. Inner rings sit further in already and stay safe
        // automatically since their radius is derived from outerRadius.
        const cornerRadius = Number.isFinite(settings.cornerRadius) ? Math.max(0, settings.cornerRadius) : 18;
        const cornerClearance = Math.max(thickness / 2 + 2, cornerRadius - CARD_PADDING);
        const outerRadius = Math.min(RING_COLUMN_WIDTH - thickness / 2 - 2, CONTENT_HEIGHT / 2 - cornerClearance);
        const start = -Math.PI / 2;
        cr.setLineWidth(thickness);
        cr.setLineCap(Cairo.LineCap.BUTT);
        rings.forEach((ring, index) => {
            const radius = outerRadius - index * (thickness + RING_GAP);
            if (radius <= 0) return;
            const fraction = Math.max(0, Math.min(1, ring.fraction));
            cr.setSourceRGBA(baseColor.r, baseColor.g, baseColor.b, baseColor.a);
            if (side === "left") cr.arc(cx, cy, radius, start, start + Math.PI); else cr.arcNegative(cx, cy, radius, start, start - Math.PI);
            cr.stroke();
            if (fraction > 0) {
                const c = _hexToRgba(ring.color);
                cr.setSourceRGBA(c.r, c.g, c.b, c.a);
                if (side === "left") cr.arc(cx, cy, radius, start, start + fraction * Math.PI); else cr.arcNegative(cx, cy, radius, start, start - fraction * Math.PI);
                cr.stroke();
            }
        });
        cr.$dispose();
    }
}
