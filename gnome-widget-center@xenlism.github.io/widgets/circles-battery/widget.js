// widgets/circles-battery/widget.js
//
// 1x1 card: a single ring gauge (base track + battery-percentage
// progress arc) - same Clutter.BinLayout-stack pattern as
// widgets/circles-cpu (St.DrawingArea behind, an St.Label on top) - but
// the ring's own color switches automatically by charge level instead
// of being one fixed color:
//
//   <= 20%             -> ringColorLow  (red by default)
//   20% < x < 50%       -> ringColorMid  (yellow by default)
//   >= 50%              -> ringColorHigh (green by default)
//   charging (any %)    -> ringColorCharging (blue by default)
//
// 2026-08-09 (handover v3): this full-circle variant used to be
// deliberately ring-only. Per user request it now ALSO centers a
// caption + percentage label inside the ring - same
// Clutter.BinLayout stack-on-top-of-the-ring-DrawingArea trick
// widgets/circles-cpu already uses for its own centered label, added
// here as `this._textBox` alongside the existing `this._ringArea`
// inside `this._stack`. While charging, the percentage is replaced by
// a bolt glyph in the charging color, matching
// widgets/circles-battery-half's existing convention. Both are
// user-togglable via `showLabel` (default true) so anyone who liked
// the old ring-only look can turn it back off.
//
// Data source: org.freedesktop.UPower's DisplayDevice - the same
// aggregate battery object GNOME Shell's own battery indicator reads,
// so this works correctly even on multi-battery laptops without this
// widget needing to combine multiple devices itself. Read via a plain
// Gio.DBusProxy exactly like widgets/settings-control/widget.js's
// NetworkManager/BlueZ proxies, subscribed to `g-properties-changed`
// for near-instant updates - PLUS a periodic re-read on a
// GLib.timeout_add_seconds() timer (refreshRateSeconds) as a backstop,
// since some UPower/driver combinations are known to be slow or
// inconsistent about firing PropertiesChanged for Percentage.
//
// Devices with no battery at all (desktop, most VMs) leave
// DisplayDevice's IsPresent false - handled defensively: the ring shows
// empty/0% rather than throwing, same "missing service leaves this one
// thing inert" convention as settings-control's four toggles.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Cairo from 'cairo';

import {SHADOW_DEFAULTS, hexToRgba as _hexToRgba, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, BORDER_DEFAULTS, OPACITY_DEFAULTS,} from '../../lib/widgetVisualKit.js';
import {createLayeredCard, applyLayeredCardStyle} from '../../lib/cardLayers.js';

const RING_SIZE = 128; // 1x1 block-type is 11x11 cells = 176px; matches widgets/circles-cpu's own sizing note.

const UPOWER_BUS_NAME = 'org.freedesktop.UPower';
const UPOWER_DISPLAY_DEVICE_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';
const UPOWER_DEVICE_IFACE = 'org.freedesktop.UPower.Device';

// org.freedesktop.UPower.Device's State enum (upower.h) - only these two
// count as "charging" for this widget's purposes (PendingCharge is a
// laptop plugged in but held below 100% by a charge-limit feature -
// still visually "charging", not "discharging").
const UP_DEVICE_STATE_CHARGING = 1;
const UP_DEVICE_STATE_PENDING_CHARGE = 5;

export default class CirclesBatteryWidget {
    /** @param {WidgetAPI} api - see WIDGET_API.md §5. */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._fraction = 0;

        this._upowerProxy = null;
        this._upowerSignalId = null;
        this._timerId = null;
    }

    buildActor() {
        // 2026-08-09 blur fix: createLayeredCard() gives this widget a
        // dedicated background actor to style/blur/fade, separate from
        // the content (ring + label) below - see lib/cardLayers.js's
        // header comment. Previously this._actor was a single St.Bin
        // that was both the styled/blurred card AND the parent of the
        // ring drawing area, so turning on Blur blurred the ring itself
        // too, not just the card fill behind it.
        this._layers = createLayeredCard({contentStyleClass: 'circles-battery-root'});
        this._actor = this._layers.root;

        const outerBox = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true});
        this._layers.content.add_child(outerBox);
        outerBox.set_style('padding: 14px;');

        this._stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: RING_SIZE,
            height: RING_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        outerBox.add_child(this._stack);

        this._ringArea = new St.DrawingArea({width: RING_SIZE, height: RING_SIZE});
        this._stack.add_child(this._ringArea);
        this._repaintId = this._ringArea.connect('repaint', () => this._onRepaint());

        this._textBox = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._captionLabel = new St.Label({text: 'BATTERY', x_align: Clutter.ActorAlign.CENTER});
        this._valueLabel = new St.Label({text: '0%', x_align: Clutter.ActorAlign.CENTER});
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
            ringColorLow: '#E01B24FF',
            ringColorMid: '#F5C211FF',
            ringColorHigh: '#33D17AFF',
            ringColorCharging: '#3584E4FF',
            ringThickness: 10,

            showLabel: true,
            captionText: 'BATTERY',
            captionFont: 'Sans 10',
            captionColor: '#FFFFFFB3',
            percentFont: 'Sans Bold 22',
            percentColor: '#FFFFFFFF',

            refreshRateSeconds: 5,
        };
    }

    onSettingsChanged() {
        this._render();
        this._startTimer(); // picks up a changed refreshRateSeconds too
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
            this._api.logger.error(`circles-battery: could not reach UPower: ${e.message}`);
            this._upowerProxy = null;
        }
        this._readBattery();
    }

    /** @private reads Percentage/State/IsPresent off the cached proxy
     * properties (populated at proxy-creation time and kept live by
     * `g-properties-changed`), updates the ring fraction, and queues a
     * repaint. */
    _readBattery() {
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
        // applyLayeredCardStyle() covers background-color/border/corner-
        // radius/shadow (CSS on this._layers.background) PLUS blur
        // (Clutter.BlurEffect) and opacity - all three now correctly
        // isolated to the background layer, never touching the ring/
        // label content above it. Opacity here is only the background's
        // own fade for symmetry with blur; the widget's overall opacity
        // setting is still also applied to the whole card by
        // extension.js's _applyCardEffects() on entry.actor, same as
        // every other widget - see that method's doc comment for why
        // both exist (root opacity = "fade the whole card the same way
        // dragging a window's opacity slider does", the more common
        // reading of an "opacity" setting; this background-only call
        // is layered belt-and-braces so background fades even if a
        // caller wants ONLY that in the future - harmless no-op overlap
        // today since both read the exact same settings.opacity value).
        applyLayeredCardStyle(this._layers, this._settings, {backgroundColorFallback: '#FFFFFF00', cornerRadiusFallback: 18});

        const ringColorKey = this._currentRingColorSetting();
        const ringColorDefault = {
            ringColorLow: '#E01B24FF', ringColorMid: '#F5C211FF',
            ringColorHigh: '#33D17AFF', ringColorCharging: '#3584E4FF',
        }[ringColorKey];
        const ringColorCss = _toCssColor(this._settings[ringColorKey], ringColorDefault);

        if (this._textBox)
            this._textBox.visible = this._settings.showLabel ?? true;

        if (this._captionLabel) {
            const captionColor = _toCssColor(this._settings.captionColor, '#FFFFFFB3');
            const captionFont = _parseFontDescription(this._settings.captionFont ?? 'Sans 10', 'Sans', 10);
            this._captionLabel.set_text(this._settings.captionText ?? 'BATTERY');
            this._captionLabel.set_style(
                `color: ${captionColor}; font-family: ${captionFont.family}; ` +
                `font-size: ${captionFont.size}px; text-align: center;`
            );
        }

        if (this._valueLabel) {
            const font = _parseFontDescription(this._settings.percentFont ?? 'Sans Bold 22', 'Sans Bold', 22);
            if (this._charging) {
                // Bolt glyph instead of a percentage while charging, in
                // the ring's own (charging) color - same convention as
                // widgets/circles-battery-half.
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
        }

        if (this._ringArea)
            this._ringArea.queue_repaint();
    }

    /** @private StDrawingArea::repaint handler - only touches Cairo via
     * area.get_context() from inside here, disposes the context before
     * returning (GJS-specific requirement). */
    _onRepaint() {
        const cr = this._ringArea.get_context();

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const thickness = Math.max(2, this._settings.ringThickness ?? 10);
        const baseColor = _hexToRgba(this._settings.circleBaseColor ?? '#FFFFFF26');

        const ringColorKey = this._currentRingColorSetting();
        const ringColorDefault = {
            ringColorLow: '#E01B24FF', ringColorMid: '#F5C211FF',
            ringColorHigh: '#33D17AFF', ringColorCharging: '#3584E4FF',
        }[ringColorKey];
        const ringColor = _hexToRgba(this._settings[ringColorKey] ?? ringColorDefault);

        const cx = RING_SIZE / 2;
        const cy = RING_SIZE / 2;
        const radius = (RING_SIZE - thickness) / 2 - 2;
        const startAngle = -Math.PI / 2; // 12 o'clock
        const fraction = Math.max(0, Math.min(1, this._fraction));
        const endAngle = startAngle + fraction * 2 * Math.PI;

        cr.setLineWidth(thickness);
        cr.setLineCap(Cairo.LineCap.ROUND);

        // Base track - always a full circle.
        cr.setSourceRGBA(baseColor.r, baseColor.g, baseColor.b, baseColor.a);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();

        // Progress arc - skip a zero-length arc (round caps still paint
        // a stray dot otherwise). Same proportional arc as the
        // non-charging case; only its color changes here (via
        // ringColor above already resolving to ringColorCharging).
        if (fraction > 0) {
            cr.setSourceRGBA(ringColor.r, ringColor.g, ringColor.b, ringColor.a);
            cr.arc(cx, cy, radius, startAngle, endAngle);
            cr.stroke();
        }

        cr.$dispose();
    }
}
