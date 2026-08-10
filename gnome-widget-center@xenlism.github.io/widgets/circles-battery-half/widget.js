// widgets/circles-battery-half/widget.js
//
// 1x1 card: battery charge drawn as a HALF-circle (semicircle) ring
// instead of the full circle widgets/circles-battery uses, sitting next
// to a caption + percentage label - same ring-column/text-column split
// as widgets/circles-cpu-half. Which side the ring hugs (and therefore
// which side the text sits on) is a setting (`ringSide`), not fixed -
// see _layoutChildren() below.
//
// The half-ring's flat edge (its "diameter") always sits on the
// boundary between the ring column and the text column, and the arc
// bulges out toward the corresponding card edge - e.g. ringSide:
// "right" draws a ")" shape hugging the right edge, with the flat edge
// on its left where it meets the text. Progress always starts at the
// TOP of the semicircle and sweeps down (clockwise for the right side,
// counter-clockwise - through the "west" point - for the left side) so
// both orientations read the same way: empty at top, fuller toward the
// bottom as the percentage increases.
//
// Ring/text color banding is the same idea as widgets/circles-battery:
//
//   <= 20%             -> ringColorLow  (red by default)
//   20% < x < 50%       -> ringColorMid  (yellow by default)
//   >= 50%              -> ringColorHigh (green by default)
//   charging (any %)    -> ringColorCharging (blue by default), and the
//                          text label is replaced by a bolt glyph in
//                          that same color instead of a percentage
//
// Data source: org.freedesktop.UPower's DisplayDevice - same aggregate
// battery object widgets/circles-battery reads, via a plain
// Gio.DBusProxy subscribed to `g-properties-changed` for near-instant
// updates, plus a periodic re-read on a GLib.timeout_add_seconds()
// timer (refreshRateSeconds) as a backstop - identical rationale to
// widgets/circles-battery's own header comment.
//
// Devices with no battery at all (desktop, most VMs) leave
// DisplayDevice's IsPresent false - handled defensively: the ring shows
// empty/0% rather than throwing.
//
// 2026-08-09 (handover v3): migrated to lib/cardLayers.js's
// createLayeredCard()/applyLayeredCardStyle() - same §C blur-isolation
// treatment widgets/circles-battery got in the prior session, so
// turning on Blur now only blurs this card's background fill, not the
// ring/caption/percentage content drawn on top of it. This also fixed a
// real overflow bug that came along for the ride: the old single
// `St.Bin` root had no `clip_to_allocation`, and `_layoutChildren()`'s
// `set_translation()` on `this._ringArea` (shifting it by
// `CARD_PADDING` so the ring's flat edge lines up with the card edge)
// was pushing the ring's drawn pixels past the card's own rounded-rect
// bounds with nothing to clip them - visible in the user's screenshot
// as the ring bleeding out past the card into the desktop background.
// createLayeredCard()'s `content` layer now has `clip_to_allocation:
// true` (see that file), so the same translation still gets the flat
// edge flush with the card edge, but anything that pokes past it is now
// clipped to the card rectangle instead of escaping it.
//
// 2026-08-09 (handover v5): the translation above was dropped as an
// extra-cautious measure, leaving the ring inset by the full
// `CARD_PADDING` on its outer (card-facing) side same as every other
// element in the card - safe, but visibly far from the edge.
//
// 2026-08-10: translation restored in `_layoutChildren()` now that the
// v3 clip fix above is confirmed to hold it - the ring's outer curve
// sits flush with the card edge again, with the clip (not distance from
// the edge) doing the work of preventing bleed-through.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Cairo from 'cairo';

import {SHADOW_DEFAULTS, hexToRgba as _hexToRgba, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, BORDER_DEFAULTS, OPACITY_DEFAULTS,} from '../../lib/widgetVisualKit.js';
import {createLayeredCard, applyLayeredCardStyle} from '../../lib/cardLayers.js';

// Auto edge-snap: when the card's own on-screen position puts it
// within this many pixels of a monitor's left or right edge, the ring
// hugs that edge automatically (overriding the manual `ringSide`
// setting) - see _effectiveRingSide() below. 250px matches the other
// circles-*-half widgets' identical convention.
const EDGE_SNAP_DISTANCE = 250;

// 1x1 block-type is 11x11 cells (176x176px); 14px card padding leaves a
// ~148x148 content area, split into a ring column and a text column -
// same layout constants as widgets/circles-cpu-half.
const RING_COLUMN_WIDTH = 74;
const CONTENT_HEIGHT = 148;
const COLUMN_GAP = 10;
const CARD_PADDING = 14;
const RING_GAP = 4;

const UPOWER_BUS_NAME = 'org.freedesktop.UPower';
const UPOWER_DISPLAY_DEVICE_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';
const UPOWER_DEVICE_IFACE = 'org.freedesktop.UPower.Device';

// org.freedesktop.UPower.Device's State enum (upower.h) - only these two
// count as "charging" for this widget's purposes (PendingCharge is a
// laptop plugged in but held below 100% by a charge-limit feature -
// still visually "charging", not "discharging").
const UP_DEVICE_STATE_CHARGING = 1;
const UP_DEVICE_STATE_PENDING_CHARGE = 5;

const RING_COLOR_DEFAULTS = {
    ringColorLow: '#E01B24FF', ringColorMid: '#F5C211FF',
    ringColorHigh: '#33D17AFF', ringColorCharging: '#3584E4FF',
};

export default class CirclesBatteryHalfWidget {
    /** @param {WidgetAPI} api - see WIDGET_API.md §5. */
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
        this._layers = createLayeredCard({contentStyleClass: 'circles-battery-half-root'});
        this._actor = this._layers.root;


        const outerBox = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true});
        this._layers.content.add_child(outerBox);
        outerBox.set_style(`padding: ${CARD_PADDING}px;`);

        const centerBin = new St.Bin({x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        outerBox.add_child(centerBin);

        this._row = new St.BoxLayout({vertical: false, y_align: Clutter.ActorAlign.CENTER});
        centerBin.set_child(this._row);

        this._ringArea = new St.DrawingArea({width: RING_COLUMN_WIDTH, height: CONTENT_HEIGHT, clip_to_allocation: true});
        this._repaintId = this._ringArea.connect('repaint', () => this._onRepaint());

        this._textBox = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._textBox.set_width(CONTENT_HEIGHT - RING_COLUMN_WIDTH - COLUMN_GAP > 0
            ? CONTENT_HEIGHT - RING_COLUMN_WIDTH - COLUMN_GAP : 60);

        this._captionLabel = new St.Label({text: 'BATTERY', x_align: Clutter.ActorAlign.CENTER});
        this._textBox.add_child(this._captionLabel);

        // One label doubles as both the percentage text (not charging)
        // and the bolt glyph (charging) - same simplification as
        // widgets/circles-battery's single centered label.
        this._valueLabel = new St.Label({text: '0%', x_align: Clutter.ActorAlign.CENTER});
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
            } catch (e) {
                // proxy may already be gone.
            }
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
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
            backgroundColor: '#FFFFFF00',
            cornerRadius: 18,

            circleBaseColor: '#FFFFFF26',
            ...RING_COLOR_DEFAULTS,
            ringThickness: 10,
            ringSide: 'right',

            captionText: 'BATTERY',
            captionFont: 'Sans 10',
            captionColor: '#FFFFFFB3',
            percentFont: 'Sans Bold 24',
            percentColor: '#FFFFFFFF',

            refreshRateSeconds: 5,
        };
    }

    onSettingsChanged() {
        this._layoutChildren();
        this._render();
        this._startTimer(); // picks up a changed refreshRateSeconds too
    }

    /** @private looks at the card's actual on-screen position and
     * returns 'left'/'right' only when it currently sits within
     * EDGE_SNAP_DISTANCE of that monitor edge (closest edge if somehow
     * within range of both). Returns null when not near either edge, or
     * when position/monitor info isn't available yet (e.g. not mapped to
     * the stage) - callers fall back to the manual `ringSide` setting in
     * that case, they never fall back inside this method. */
    _detectEdgeSide() {
        try {
            if (!this._actor || !this._actor.get_stage())
                return null;

            const [x] = this._actor.get_transformed_position();
            const [width] = this._actor.get_transformed_size();
            if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0)
                return null;

            const monitorIndex = global.display.get_monitor_index_for_rect(
                new Meta.Rectangle({x: Math.round(x), y: 0, width: Math.max(1, Math.round(width)), height: 1})
            );
            const geometry = global.display.get_monitor_geometry(monitorIndex);
            if (!geometry)
                return null;

            const distLeft = x - geometry.x;
            const distRight = (geometry.x + geometry.width) - (x + width);

            if (distLeft <= EDGE_SNAP_DISTANCE && distLeft <= distRight)
                return 'left';
            if (distRight <= EDGE_SNAP_DISTANCE)
                return 'right';
        } catch (e) {
            // Monitor/stage info not available - treat as "not near an edge".
        }
        return null;
    }

    /** @private puts the ring column and text column in the order
     * `_effectiveRingSide()` calls for - "right" means ring column last
     * (visually right, since this is a plain horizontal BoxLayout),
     * "left" means ring column first. Also re-evaluates the edge-snap
     * side every time this runs (see _effectiveRingSide()), so dragging
     * the card near a screen edge updates the layout live. */
    _layoutChildren() {
        const manual = this._settings.ringSide === 'left' ? 'left' : 'right';
        const detected = this._detectEdgeSide();

        // Position wins over a stale manual setting: if the card is
        // actually sitting within EDGE_SNAP_DISTANCE of an edge that
        // disagrees with the stored `ringSide`, correct the setting
        // itself (not just this frame's layout) so it stays in sync -
        // e.g. dragged to the right edge while ringSide was still
        // 'left' gets written back to 'right'.
        if (detected !== null && detected !== manual)
            this._settings.ringSide = detected;

        const side = detected ?? manual;
        this._row.remove_all_children();
        if (side === 'left') {
            this._row.add_child(this._ringArea);
            this._row.add_child(new St.Widget({width: COLUMN_GAP, height: 1}));
            this._row.add_child(this._textBox);
        } else {
            this._row.add_child(this._textBox);
            this._row.add_child(new St.Widget({width: COLUMN_GAP, height: 1}));
            this._row.add_child(this._ringArea);
        }

        // 2026-08-10: re-added (as a `set_translation()`, same mechanism
        // v5's comment above used to describe before it was dropped) to
        // close the `CARD_PADDING` (14px) gap the user reported between
        // the ring's outer curve and the card's actual edge. v5 dropped
        // this specifically because, at the time, `content` had no
        // `clip_to_allocation`, so pushing the ring `CARD_PADDING` past
        // its padded position let the drawn arc bleed straight through
        // the card's rounded-rect border into the desktop background.
        // That's no longer true: lib/cardLayers.js's createLayeredCard()
        // now clips `content` to the full card rectangle (2026-08-09,
        // handover v3), so this same translation lands the ring's flat/
        // curved edges exactly flush with the card edge and anything
        // that would poke past it is clipped there instead of escaping -
        // safe to restore.
        const push = side === 'left' ? -CARD_PADDING : CARD_PADDING;
        this._ringArea.set_translation(push, 0, 0);

        // Side flips change the ring's arc geometry (cx/direction), not
        // just which column it's in - repaint so a live edge-snap
        // change (drag near an edge) is reflected immediately.
        if (this._ringArea)
            this._ringArea.queue_repaint();
    }

    /** @private (re)starts the periodic backstop refresh - see this
     * file's header for why this exists alongside `g-properties-changed`. */
    _startTimer() {
        this._stopTimer();
        const seconds = Math.max(1, this._settings.refreshRateSeconds ?? 5);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._readBattery();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /** @private */
    _stopTimer() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    /** @private */
    _connectUPower() {
        try {
            this._upowerProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                UPOWER_BUS_NAME, UPOWER_DISPLAY_DEVICE_PATH, UPOWER_DEVICE_IFACE, null
            );
            this._upowerSignalId = this._upowerProxy.connect('g-properties-changed', () => this._readBattery());
        } catch (e) {
            this._api.logger.error(`circles-battery-half: could not reach UPower: ${e.message}`);
            this._upowerProxy = null;
        }
        this._readBattery();
    }

    /** @private reads Percentage/State/IsPresent off the cached proxy
     * properties (populated at proxy-creation time and kept live by
     * `g-properties-changed`), updates the ring fraction + label, and
     * queues a repaint. */
    _readBattery() {
        // Re-check the edge-snap side on every periodic refresh, so a
        // card dragged near a monitor edge picks up the flip within one
        // refresh interval (there's no reliably-available cross-version
        // St/Clutter signal to react to a drag the instant it happens).
        this._layoutChildren();
        const isPresent = this._upowerProxy?.get_cached_property('IsPresent')?.unpack() ?? false;
        const percent = this._upowerProxy?.get_cached_property('Percentage')?.unpack() ?? 0;
        const state = this._upowerProxy?.get_cached_property('State')?.unpack() ?? 0;

        const clamped = isPresent ? Math.max(0, Math.min(100, percent)) : 0;
        const charging = isPresent && (state === UP_DEVICE_STATE_CHARGING || state === UP_DEVICE_STATE_PENDING_CHARGE);

        this._fraction = clamped / 100;
        this._charging = charging;
        this._render();
    }

    /** @private picks the ring color for the current state: charging
     * color while plugged in (regardless of percentage), otherwise the
     * low/mid/high color banded by percentage. */
    _currentRingColorSetting() {
        if (this._charging)
            return 'ringColorCharging';
        if (this._fraction * 100 <= 20)
            return 'ringColorLow';
        if (this._fraction * 100 < 50)
            return 'ringColorMid';
        return 'ringColorHigh';
    }

    /** @private */
    _render() {
        applyLayeredCardStyle(this._layers, this._settings, {backgroundColorFallback: '#FFFFFF00', cornerRadiusFallback: 18});

        const captionColor = _toCssColor(this._settings.captionColor, '#FFFFFFB3');
        const captionFont = _parseFontDescription(this._settings.captionFont ?? 'Sans 10', 'Sans', 10);
        this._captionLabel.set_text(this._settings.captionText ?? 'BATTERY');
        this._captionLabel.set_style(
            `color: ${captionColor}; font-family: ${captionFont.family}; ` +
            `font-size: ${captionFont.size}px; text-align: center;`
        );

        const ringColorKey = this._currentRingColorSetting();
        const ringColorCss = _toCssColor(this._settings[ringColorKey], RING_COLOR_DEFAULTS[ringColorKey]);
        const font = _parseFontDescription(this._settings.percentFont ?? 'Sans Bold 24', 'Sans Bold', 24);

        if (this._charging) {
            // No percentage text while charging - just a bolt glyph, in
            // the same color as the (charging-colored) ring, same
            // convention as widgets/circles-battery.
            this._valueLabel.set_text('\u26A1'); // ⚡
            this._valueLabel.set_style(
                `color: ${ringColorCss}; font-family: ${font.family}; ` +
                `font-size: ${font.size}px; text-align: center;`
            );
        } else {
            const percentColor = _toCssColor(this._settings.percentColor, '#FFFFFFFF');
            this._valueLabel.set_text(`${Math.round(this._fraction * 100)}%`);
            this._valueLabel.set_style(
                `color: ${percentColor}; font-family: ${font.family}; ` +
                `font-size: ${font.size}px; font-weight: bold; text-align: center;`
            );
        }

        if (this._ringArea)
            this._ringArea.queue_repaint();
    }

    /** @private StDrawingArea::repaint handler - draws the half-ring
     * track + progress arc. Only touches Cairo via area.get_context()
     * from inside here, and disposes the context before returning
     * (GJS-specific requirement). */
    _onRepaint() {
        const cr = this._ringArea.get_context();

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const side = this._settings.ringSide === 'left' ? 'left' : 'right';
        const thickness = Math.max(2, this._settings.ringThickness ?? 10);
        const baseColor = _hexToRgba(this._settings.circleBaseColor ?? '#FFFFFF26');

        const ringColorKey = this._currentRingColorSetting();
        const ringColor = _hexToRgba(this._settings[ringColorKey] ?? RING_COLOR_DEFAULTS[ringColorKey]);

        // Keep the curved part inside the card: a right-side ring bends
        // left toward its text, and a left-side ring bends right.
        const cx = side === 'left' ? 0 : RING_COLUMN_WIDTH;
        const cy = CONTENT_HEIGHT / 2;
        const outerRadius = Math.min(RING_COLUMN_WIDTH - thickness / 2 - 2, CONTENT_HEIGHT / 2 - thickness / 2 - 2);
        const fraction = Math.max(0, Math.min(1, this._fraction));
        const start = -Math.PI / 2; // top
        const rings = [outerRadius, outerRadius - thickness - RING_GAP];

        cr.setLineWidth(thickness);
        // Flat (butt) caps, not round - a round cap would poke past the
        // flat diameter edge at the 0%/top end.
        cr.setLineCap(Cairo.LineCap.BUTT);

        for (const radius of rings) {
            if (radius <= 0)
                continue;
            cr.setSourceRGBA(baseColor.r, baseColor.g, baseColor.b, baseColor.a);
            if (side === 'left')
                cr.arc(cx, cy, radius, start, start + Math.PI);
            else
                cr.arcNegative(cx, cy, radius, start, start - Math.PI);
            cr.stroke();

            if (fraction > 0) {
                cr.setSourceRGBA(ringColor.r, ringColor.g, ringColor.b, ringColor.a);
                if (side === 'left')
                    cr.arc(cx, cy, radius, start, start + fraction * Math.PI);
                else
                    cr.arcNegative(cx, cy, radius, start, start - fraction * Math.PI);
                cr.stroke();
            }
        }

        cr.$dispose();
    }
}
