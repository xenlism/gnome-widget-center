// widgets/circles-net/widget.js
//
// 1x1 card: two concentric ring gauges sharing one center - outer ring =
// download throughput, inner ring = upload throughput, each a base
// track + progress arc using its own adaptive recent-traffic scale. A raw
// byte rate has no natural "100%" the way CPU/memory/disk percentages do;
// adapting the scale keeps light traffic visible instead of leaving the
// rings empty on a fast connection. The "NET"
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
import Cairo from 'cairo';

import {SystemMetricsService} from '../../lib/systemMetricsApi.js';
import {
    SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, hexToRgba as _hexToRgba,
    toCssColor as _toCssColor, parseFontDescription as _parseFontDescription,
} from '../../lib/widgetVisualKit.js';

const RING_SIZE = 128; // 1x1 block-type is now 11x11 cells (176px) not 10x10 (160px); scaled 116 * (176/160) = 127.6 -> 128
const RING_GAP = 4; // px between the download (outer) and upload (inner) bands
const MIN_DYNAMIC_SCALE_BYTES_PER_SEC = 8 * 1024;
const SCALE_HEADROOM = 1.25;
const SCALE_DECAY = 0.85;

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

/** @private Maintains a responsive scale for one traffic direction.
 * New peaks become visible immediately with a little headroom; a previous
 * peak fades gradually so ordinary fluctuations do not make the ring jump. */
function _adaptiveFraction(bytesPerSec, previousScale) {
    const rate = Math.max(0, Number.isFinite(bytesPerSec) ? bytesPerSec : 0);
    const scale = Math.max(
        MIN_DYNAMIC_SCALE_BYTES_PER_SEC,
        rate * SCALE_HEADROOM,
        (Number.isFinite(previousScale) ? previousScale : 0) * SCALE_DECAY
    );
    return {scale, fraction: Math.min(1, rate / scale)};
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
        this._downloadScale = MIN_DYNAMIC_SCALE_BYTES_PER_SEC;
        this._uploadScale = MIN_DYNAMIC_SCALE_BYTES_PER_SEC;
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
            ...SHADOW_DEFAULTS,
            backgroundColor: '#FFFFFF00',
            cornerRadius: 18,

            labelFont: 'Sans 12',
            labelColor: '#FFFFFFB3',
            percentFont: 'Sans Bold 14',

            circleBaseColor: '#FFFFFF26',
            downloadColor: '#5AC8FAFF',
            uploadColor: '#FF9F0AFF',
            ringThickness: 9,

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

        const download = _adaptiveFraction(totalRxBytesPerSec, this._downloadScale);
        const upload = _adaptiveFraction(totalTxBytesPerSec, this._uploadScale);
        this._downloadScale = download.scale;
        this._uploadScale = upload.scale;
        this._downloadFraction = download.fraction;
        this._uploadFraction = upload.fraction;

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
        const backgroundColor = _toCssColor(this._settings.backgroundColor, '#FFFFFF00');
        const cornerRadius = this._settings.cornerRadius ?? 18;
        this._actor.set_style(_cardStyleCss(this._settings, {cornerRadiusFallback: 18}));

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
