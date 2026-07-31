// widgets/circles-net/widget.js
//
// 1x1 card: two concentric ring gauges sharing one center - outer ring =
// download throughput, inner ring = upload throughput, each a base
// track + progress arc scaled against its own configurable max-speed
// setting (maxDownloadMbps/maxUploadMbps), since a raw byte rate has no
// natural "100%" the way CPU/memory/disk percentages do. The "NET"
// caption plus the live download/upload numbers (each in its own ring's
// color) sit centered on top - same Clutter.BinLayout stack idea as
// widgets/circles-cpu and widgets/system-monitor-mini, with two rings
// nested the way widgets/circles-clock nests three.
//
// Data source: lib/systemMetricsApi.js's SystemMetricsService
// .getNetworkUsage() (bundled-widgets-only import, WIDGET_API.md §9.2).
// Combined throughput across every interface, same choice
// widgets/network-monitor/widget.js already makes, so this keeps working
// across Wi-Fi/Ethernet switches without a device-picker setting.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Cairo from 'cairo';

import {SystemMetricsService} from '../../lib/systemMetricsApi.js';

const RING_SIZE = 116;
const RING_GAP = 4; // px between the download (outer) and upload (inner) bands

/** @private "#rrggbb" or "#rrggbbaa" -> {r,g,b,a} each 0..1, for Cairo. */
function _hexToRgba(hex) {
    const m = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(hex ?? '');
    if (!m)
        return {r: 1, g: 1, b: 1, a: 1};
    const h = m[1];
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return {r, g, b, a};
}

/** @private 8-digit "#rrggbbaa" -> "rgba(r, g, b, a)" for St CSS, which
 * doesn't understand 8-digit hex on its own. Anything else passes
 * through unchanged. */
function _toCssColor(hex, fallback) {
    const value = typeof hex === 'string' ? hex : fallback;
    const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})$/.exec(value);
    if (!m)
        return value;
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    const a = Math.round((parseInt(m[2], 16) / 255) * 1000) / 1000;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** @private splits a combined Pango font-description string into the
 * family/size pieces St's set_style() needs - same pattern as
 * widgets/clock-modern/widget.js's _parseFontDescription(). */
function _parseFontDescription(fontStr, fallbackFamily, fallbackSize) {
    try {
        const desc = Pango.FontDescription.from_string(fontStr);
        const rawSize = desc.get_size();
        const size = rawSize > 0 ? Math.round(rawSize / Pango.SCALE) : fallbackSize;
        desc.unset_fields(Pango.FontMask.SIZE);
        const family = desc.to_string().trim();
        return {family: family || fallbackFamily, size};
    } catch (e) {
        return {family: fallbackFamily, size: fallbackSize};
    }
}

/** @private Human-readable throughput, e.g. 1536 -> "1.5 KB/s". Same
 * helper as widgets/network-monitor/widget.js's _formatRate(). */
function _formatRate(bytesPerSec) {
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let value = Math.max(0, bytesPerSec);
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }
    const decimals = i > 0 && value < 10 ? 1 : 0;
    return `${value.toFixed(decimals)} ${units[i]}`;
}

export default class CirclesNetWidget {
    /** @param {WidgetAPI} api - see WIDGET_API.md §5. */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._metrics = new SystemMetricsService();
        this._timerId = null;
        this._pressId = null;
        this._downloadFraction = 0;
        this._uploadFraction = 0;
    }

    buildActor() {
        this._actor = new St.Bin({
            style_class: 'circles-net-root',
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

        const textBox = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._labelLabel = new St.Label({text: 'NET', style_class: 'circles-net-label'});
        this._downloadLabel = new St.Label({style_class: 'circles-net-download'});
        this._uploadLabel = new St.Label({style_class: 'circles-net-upload'});
        textBox.add_child(this._labelLabel);
        textBox.add_child(this._downloadLabel);
        textBox.add_child(this._uploadLabel);
        this._stack.add_child(textBox);

        this._render();
        this._tick();
        this._applyClickHandler();
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
        this._removeClickHandler();
    }

    getDefaultSettings() {
        return {
            backgroundColor: '#00000026',
            cornerRadius: 18,

            labelFont: 'Sans 12',
            labelColor: '#FFFFFFB3',
            percentFont: 'Sans Bold 14',

            circleBaseColor: '#FFFFFF26',
            downloadColor: '#5AC8FAFF',
            uploadColor: '#FF9F0AFF',
            ringThickness: 9,

            maxDownloadMbps: 100,
            maxUploadMbps: 20,
            refreshRateSeconds: 2,
            launchAppPath: '',
        };
    }

    onSettingsChanged() {
        this._render();
        this._startTimer(); // also re-wires the click handler, see below
    }

    /** @private */
    _startTimer() {
        this._stopTimer();
        const seconds = Math.max(1, this._settings.refreshRateSeconds ?? 2);
        this._tick();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        this._applyClickHandler();
    }

    /** @private */
    _stopTimer() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    /** @private */
    _tick() {
        const {totalRxBytesPerSec, totalTxBytesPerSec} = this._metrics.getNetworkUsage();

        const maxDownloadBytesPerSec = Math.max(1, this._settings.maxDownloadMbps ?? 100) * 1_000_000 / 8;
        const maxUploadBytesPerSec = Math.max(1, this._settings.maxUploadMbps ?? 20) * 1_000_000 / 8;

        this._downloadFraction = Math.max(0, Math.min(1, totalRxBytesPerSec / maxDownloadBytesPerSec));
        this._uploadFraction = Math.max(0, Math.min(1, totalTxBytesPerSec / maxUploadBytesPerSec));

        this._downloadLabel.set_text(`\u2193 ${_formatRate(totalRxBytesPerSec)}`);
        this._uploadLabel.set_text(`\u2191 ${_formatRate(totalTxBytesPerSec)}`);

        if (this._ringArea)
            this._ringArea.queue_repaint();
    }

    /** @private */
    _applyClickHandler() {
        this._removeClickHandler();

        const path = this._settings.launchAppPath ?? '';
        if (!path) {
            this._actor.reactive = false;
            return;
        }

        this._actor.reactive = true;
        this._pressId = this._actor.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            if (event.get_state() & Clutter.ModifierType.MOD4_MASK)
                return Clutter.EVENT_PROPAGATE; // Super held - drag, not a click

            this._launchApp();
            return Clutter.EVENT_STOP;
        });
    }

    /** @private */
    _removeClickHandler() {
        if (this._pressId !== null && this._actor) {
            this._actor.disconnect(this._pressId);
            this._pressId = null;
        }
    }

    /** @private */
    _launchApp() {
        const path = this._settings.launchAppPath ?? '';
        if (!path)
            return;
        try {
            const appInfo = Gio.DesktopAppInfo.new_from_filename(path);
            if (appInfo)
                appInfo.launch([], null);
            else
                this._api.logger.info(`circles-net: could not read .desktop file at ${path}`);
        } catch (e) {
            this._api.logger.info(`circles-net: failed to launch ${path}: ${e}`);
        }
    }

    /** @private */
    _render() {
        const backgroundColor = _toCssColor(this._settings.backgroundColor, '#00000026');
        const cornerRadius = this._settings.cornerRadius ?? 18;
        this._actor.set_style(
            `background-color: ${backgroundColor}; ` +
            `border-radius: ${cornerRadius}px;`
        );

        const labelColor = _toCssColor(this._settings.labelColor, '#FFFFFFB3');
        const downloadColor = _toCssColor(this._settings.downloadColor, '#5AC8FAFF');
        const uploadColor = _toCssColor(this._settings.uploadColor, '#FF9F0AFF');
        const labelFont = _parseFontDescription(this._settings.labelFont ?? 'Sans 12', 'Sans', 12);
        const valueFont = _parseFontDescription(this._settings.percentFont ?? 'Sans Bold 14', 'Sans Bold', 14);

        this._labelLabel.set_style(
            `color: ${labelColor}; font-family: ${labelFont.family}; ` +
            `font-size: ${labelFont.size}px; text-align: center; margin-bottom: 2px;`
        );
        this._downloadLabel.set_style(
            `color: ${downloadColor}; font-family: ${valueFont.family}; ` +
            `font-size: ${valueFont.size}px; font-weight: bold; text-align: center;`
        );
        this._uploadLabel.set_style(
            `color: ${uploadColor}; font-family: ${valueFont.family}; ` +
            `font-size: ${valueFont.size}px; font-weight: bold; text-align: center;`
        );

        if (this._ringArea)
            this._ringArea.queue_repaint();
    }

    /** @private draws the two concentric rings - download outer, upload
     * inner. Never throws on missing settings. */
    _onRepaint() {
        const cr = this._ringArea.get_context();

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const thickness = Math.max(2, this._settings.ringThickness ?? 9);
        const baseColor = _hexToRgba(this._settings.circleBaseColor ?? '#FFFFFF26');
        const cx = RING_SIZE / 2;
        const cy = RING_SIZE / 2;
        const startAngle = -Math.PI / 2; // 12 o'clock

        const outerRadius = RING_SIZE / 2 - thickness / 2 - 2;
        const rings = [
            {radius: outerRadius, fraction: this._downloadFraction, color: this._settings.downloadColor ?? '#5AC8FAFF'},
            {radius: outerRadius - (thickness + RING_GAP), fraction: this._uploadFraction, color: this._settings.uploadColor ?? '#FF9F0AFF'},
        ];

        cr.setLineWidth(thickness);
        cr.setLineCap(Cairo.LineCap.ROUND);

        for (const ring of rings) {
            if (ring.radius <= 0)
                continue;

            // Base track - always a full circle.
            cr.setSourceRGBA(baseColor.r, baseColor.g, baseColor.b, baseColor.a);
            cr.arc(cx, cy, ring.radius, 0, 2 * Math.PI);
            cr.stroke();

            // Progress arc - skip a zero-length arc (round caps still
            // paint a stray dot otherwise).
            const fraction = Math.max(0, Math.min(1, ring.fraction));
            if (fraction > 0) {
                const {r, g, b, a} = _hexToRgba(ring.color);
                cr.setSourceRGBA(r, g, b, a);
                cr.arc(cx, cy, ring.radius, startAngle, startAngle + fraction * 2 * Math.PI);
                cr.stroke();
            }
        }

        cr.$dispose();
    }
}
