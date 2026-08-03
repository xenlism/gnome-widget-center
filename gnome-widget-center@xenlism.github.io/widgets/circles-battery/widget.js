// widgets/circles-battery/widget.js
//
// 1x1 card: a single ring gauge (base track + battery-percentage
// progress arc) - same Clutter.BinLayout-stack pattern as
// widgets/circles-cpu (St.DrawingArea behind, an St.Label on top) - but
// the ring's own color switches automatically by charge level instead
// of being one fixed color:
//
//   < 20%              -> ringColorLow  (red by default)
//   20% <= x < 50%      -> ringColorMid  (yellow by default)
//   >= 50%              -> ringColorHigh (green by default)
//   charging (any %)    -> ringColorCharging (blue by default), and the
//                          centered text is replaced by a bolt glyph in
//                          that same color instead of a percentage
//
// Data source: org.freedesktop.UPower's DisplayDevice - the same
// aggregate battery object GNOME Shell's own battery indicator reads,
// so this works correctly even on multi-battery laptops without this
// widget needing to combine multiple devices itself. Read via a plain
// Gio.DBusProxy exactly like widgets/settings-control/widget.js's
// NetworkManager/BlueZ proxies (WIDGET_API.md §9.1: subscribe via
// `g-properties-changed`, never poll) - no bundled-widgets-only import
// needed here since this is plain Gio, not lib/systemMetricsApi.js.
//
// Devices with no battery at all (desktop, most VMs) leave
// DisplayDevice's IsPresent false - handled defensively: the ring shows
// empty/0% rather than throwing, same "missing service leaves this one
// thing inert" convention as settings-control's four toggles.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';
import Cairo from 'cairo';

import {SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, hexToRgba as _hexToRgba, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription} from '../../lib/widgetVisualKit.js';

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
    }

    buildActor() {
        this._actor = new St.Bin({
            style_class: 'circles-battery-root',
            x_expand: true,
            y_expand: true,
        });

        const outerBox = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true});
        this._actor.set_child(outerBox);
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

        // One label doubles as both the percentage text (not charging)
        // and the bolt glyph (charging) - simplest way to keep exactly
        // one centered text node instead of swapping actors in/out.
        this._valueLabel = new St.Label({
            text: '0%',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._stack.add_child(this._valueLabel);

        this._render();
        return this._actor;
    }

    enable() {
        this._connectUPower();
    }

    disable() {
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
            backgroundColor: '#000000a9',
            cornerRadius: 18,

            circleBaseColor: '#FFFFFF26',
            ringColorLow: '#E01B24FF',
            ringColorMid: '#F5C211FF',
            ringColorHigh: '#33D17AFF',
            ringColorCharging: '#3584E4FF',
            ringThickness: 10,

            percentFont: 'Sans Bold 22',
            percentColor: '#FFFFFFFF',
        };
    }

    onSettingsChanged() {
        this._render();
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
     * `g-properties-changed`), updates the ring fraction + label, and
     * queues a repaint. */
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
        if (this._fraction * 100 < 20)
            return 'ringColorLow';
        if (this._fraction * 100 < 50)
            return 'ringColorMid';
        return 'ringColorHigh';
    }

    /** @private */
    _render() {
        const backgroundColor = _toCssColor(this._settings.backgroundColor, '#000000a9');
        const cornerRadius = this._settings.cornerRadius ?? 18;
        this._actor.set_style(
            `background-color: ${backgroundColor}; ` +
            `border-radius: ${cornerRadius}px;` +
            _shadowBoxShadowCss(this._settings)
        );

        const ringColorKey = this._currentRingColorSetting();
        const ringColorDefault = {
            ringColorLow: '#E01B24FF', ringColorMid: '#F5C211FF',
            ringColorHigh: '#33D17AFF', ringColorCharging: '#3584E4FF',
        }[ringColorKey];
        const ringColorCss = _toCssColor(this._settings[ringColorKey], ringColorDefault);

        if (this._charging) {
            // No percentage text while charging - just a bolt glyph, in
            // the same color as the (charging-colored) ring, per this
            // widget's spec.
            this._valueLabel.set_text('\u26A1'); // ⚡
            const font = _parseFontDescription(this._settings.percentFont ?? 'Sans Bold 22', 'Sans Bold', 22);
            this._valueLabel.set_style(
                `color: ${ringColorCss}; font-family: ${font.family}; ` +
                `font-size: ${font.size}px; text-align: center;`
            );
        } else {
            const percentColor = _toCssColor(this._settings.percentColor, '#FFFFFFFF');
            const percentFont = _parseFontDescription(this._settings.percentFont ?? 'Sans Bold 22', 'Sans Bold', 22);
            this._valueLabel.set_text(`${Math.round(this._fraction * 100)}%`);
            this._valueLabel.set_style(
                `color: ${percentColor}; font-family: ${percentFont.family}; ` +
                `font-size: ${percentFont.size}px; font-weight: bold; text-align: center;`
            );
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
