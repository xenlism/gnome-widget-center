// widgets/network-monitor/widget.js
//
// 1x1 card: "↓ download" / "↑ upload" throughput numbers on top (each in
// its own line color), a two-line sparkline history strip on the bottom
// (download + upload overlaid, adaptively scaled together so they stay
// comparable and low traffic remains visible), on a rounded card background.
// Sibling of cpu-monitor and
// mem-monitor - see cpu-monitor/widget.js's header for the shared
// conventions (self-contained widget folders, Cairo import, etc.) this
// file repeats rather than importing from a sibling widget folder.
//
// Data source: lib/systemMetricsApi.js's SystemMetricsService.getNetworkUsage()
// (bundled-widgets-only import, WIDGET_API.md §9.2). Combined throughput
// across every interface (totalRxBytesPerSec/totalTxBytesPerSec) rather
// than picking one device, so this keeps working across Wi-Fi/Ethernet
// switches without a device-picker setting. Like getCpuUsage(), the very
// first sample is always 0 (nothing to diff against yet) - harmless here
// since _tick() runs once immediately in buildActor() and again on every
// timer tick afterward.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Cairo from 'cairo';

import {SystemMetricsService} from '../../lib/systemMetricsApi.js';
import {SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, toCssColor as _toCssColor} from '../../lib/widgetVisualKit.js';

const MAX_HISTORY = 40;
const GRAPH_HEIGHT = 46;
const CARD_PADDING = 16;
const RECENT_SCALE_SAMPLES = 8;
const MIN_SCALE_BYTES_PER_SEC = 64;
const SCALE_HEADROOM = 1.25;

/** @private Splits "#RRGGBB" or "#RRGGBBAA" into 0-1 float channels. */
function _parseHexColor(hex, fallback = '#FFFFFFFF') {
    const value = typeof hex === 'string' && /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex) ? hex : fallback;
    const r = parseInt(value.slice(1, 3), 16) / 255;
    const g = parseInt(value.slice(3, 5), 16) / 255;
    const b = parseInt(value.slice(5, 7), 16) / 255;
    const a = value.length === 9 ? parseInt(value.slice(7, 9), 16) / 255 : 1;
    return {r, g, b, a};
}

/** @private Same helper as cpu-monitor/widget.js - splits a combined Pango
 * font-description string into the pieces St's set_style() needs. */

function _splitFontDescription(fontStr, fallbackFamily = 'Sans', fallbackSize = 20) {
    try {
        const desc = Pango.FontDescription.from_string(fontStr || `${fallbackFamily} Bold ${fallbackSize}`);
        const family = desc.get_family() || fallbackFamily;
        const weight = desc.get_weight() || 400;
        const style = desc.get_style();
        const styleCss = style === Pango.Style.ITALIC ? 'italic' : style === Pango.Style.OBLIQUE ? 'oblique' : 'normal';
        const sizeRaw = desc.get_size();
        const size = sizeRaw > 0 ? Math.round(sizeRaw / Pango.SCALE) : fallbackSize;
        return {family, weight, styleCss, size};
    } catch (e) {
        return {family: fallbackFamily, weight: 700, styleCss: 'normal', size: fallbackSize};
    }
}

/** @private Human-readable throughput, e.g. 1536 -> "1.5 KB/s". */
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

export default class NetworkMonitorWidget {
    /** @param {WidgetAPI} api - see WIDGET_API.md §5. */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._metrics = new SystemMetricsService();
        this._rxHistory = [];
        this._txHistory = [];
        this._timerId = null;
        this._pressId = null;
    }

    buildActor() {
        this._actor = new St.Bin({
            style_class: 'network-monitor-root',
            x_expand: true,
            y_expand: true,
        });

        this._content = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true});
        this._actor.set_child(this._content);

        this._textBox = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true});
        this._downloadLabel = new St.Label({style_class: 'network-monitor-download'});
        this._uploadLabel = new St.Label({style_class: 'network-monitor-upload'});
        this._captionLabel = new St.Label({style_class: 'network-monitor-caption'});
        this._textBox.add_child(this._downloadLabel);
        this._textBox.add_child(this._uploadLabel);
        this._textBox.add_child(this._captionLabel);

        this._graphArea = new St.DrawingArea({style_class: 'network-monitor-graph', x_expand: true, height: GRAPH_HEIGHT});
        this._repaintId = this._graphArea.connect('repaint', area => this._onRepaint(area));

        this._content.add_child(this._textBox);
        this._content.add_child(this._graphArea);

        this._render();
        this._tick();
        return this._actor;
    }

    enable() {
        this._startTimer();
    }

    disable() {
        this._stopTimer();
        if (this._repaintId !== null && this._graphArea) {
            this._graphArea.disconnect(this._repaintId);
            this._repaintId = null;
        }
        this._disconnectClick();
    }

    getDefaultSettings() {
        return {
            ...SHADOW_DEFAULTS,
            fontDesc: 'Sans Bold 20',
            fontColor: '#FFFFFFFF',
            downloadLineColor: '#5AC8FAFF',
            uploadLineColor: '#FF9F0AFF',
            graphBaseColor: '#FFFFFF12',
            backgroundColor: '#FFFFFF00',
            cornerRadius: 18,
            refreshRateSeconds: 3,
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
        const seconds = Math.max(1, this._settings.refreshRateSeconds ?? 3);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        this._connectClick();
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

        this._rxHistory.push(totalRxBytesPerSec);
        if (this._rxHistory.length > MAX_HISTORY)
            this._rxHistory.shift();

        this._txHistory.push(totalTxBytesPerSec);
        if (this._txHistory.length > MAX_HISTORY)
            this._txHistory.shift();

        this._downloadLabel.set_text(`\u2193 ${_formatRate(totalRxBytesPerSec)}`);
        this._uploadLabel.set_text(`\u2191 ${_formatRate(totalTxBytesPerSec)}`);

        if (this._graphArea)
            this._graphArea.queue_repaint();
    }

    /** @private */
    _disconnectClick() {
        if (this._pressId !== null && this._actor) {
            this._actor.disconnect(this._pressId);
            this._pressId = null;
        }
    }

    /** @private */
    _connectClick() {
        this._disconnectClick();

        const path = this._settings.launchAppPath;
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
    _launchApp() {
        const path = this._settings.launchAppPath;
        if (!path)
            return;
        try {
            const appInfo = Gio.DesktopAppInfo.new_from_filename(path);
            if (appInfo)
                appInfo.launch([], null);
            else
                this._api.logger.info(`network-monitor: could not read .desktop file at ${path}`);
        } catch (e) {
            this._api.logger.info(`network-monitor: failed to launch ${path}: ${e}`);
        }
    }

    /** @private */
    _render() {
        const backgroundColor = _toCssColor(this._settings.backgroundColor, '#FFFFFF00');
        const cornerRadius = this._settings.cornerRadius ?? 18;
        const fontColor = _toCssColor(this._settings.fontColor, '#FFFFFFFF');
        const downloadColor = _toCssColor(this._settings.downloadLineColor, '#5AC8FAFF');
        const uploadColor = _toCssColor(this._settings.uploadLineColor, '#FF9F0AFF');
        const graphBaseColor = _toCssColor(this._settings.graphBaseColor, '#FFFFFF12');
        const font = _splitFontDescription(this._settings.fontDesc ?? 'Sans Bold 20', 'Sans', 20);

        this._actor.set_style(
            `background-color: ${backgroundColor}; ` +
            `border-radius: ${cornerRadius}px;` +
            _shadowBoxShadowCss(this._settings)
        );

        this._textBox.set_style(`padding: ${CARD_PADDING}px ${CARD_PADDING}px 4px ${CARD_PADDING}px; spacing: 2px;`);

        const numberStyle = (color) =>
            `color: ${color}; font-family: ${font.family}; font-weight: ${font.weight}; ` +
            `font-style: ${font.styleCss}; font-size: ${font.size}px;`;

        this._downloadLabel.set_style(numberStyle(downloadColor));
        this._uploadLabel.set_style(numberStyle(uploadColor));

        this._captionLabel.set_text('NET');
        this._captionLabel.set_style(
            `color: ${fontColor}; ` +
            `font-family: ${font.family}; font-weight: ${font.weight}; font-style: ${font.styleCss}; ` +
            `font-size: ${Math.max(11, Math.round(font.size * 0.55))}px; ` +
            'padding-top: 2px;'
        );

        this._graphArea.set_style(`background-color: ${graphBaseColor}; margin: 6px 0 ${CARD_PADDING}px 0;`);

        if (this._graphArea)
            this._graphArea.queue_repaint();
    }

    /** @private Draws both sparklines on one adaptive scale based on recent
     * traffic. The shared scale keeps directions comparable, while dropping
     * an old burst after a few samples lets small current traffic be seen. */
    _onRepaint(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const longest = Math.max(this._rxHistory.length, this._txHistory.length);
        if (longest >= 2) {
            const recentValues = [
                ...this._rxHistory.slice(-RECENT_SCALE_SAMPLES),
                ...this._txHistory.slice(-RECENT_SCALE_SAMPLES),
            ];
            const maxValue = Math.max(MIN_SCALE_BYTES_PER_SEC, ...recentValues) * SCALE_HEADROOM;
            const stepX = width / Math.max(1, MAX_HISTORY - 1);

            const drawLine = (history, hexColor) => {
                if (history.length < 2)
                    return;
                const {r, g, b, a} = _parseHexColor(hexColor);
                const startIndex = MAX_HISTORY - history.length;

                cr.setLineWidth(2);
                cr.setSourceRGBA(r, g, b, a);
                history.forEach((value, i) => {
                    const x = (startIndex + i) * stepX;
                    // Square-root response gives lower rates enough height
                    // to read while retaining the full range for bursts.
                    const fraction = Math.sqrt(Math.min(1, Math.max(0, value) / maxValue));
                    const y = height - 6 - fraction * (height - 12);
                    if (i === 0)
                        cr.moveTo(x, y);
                    else
                        cr.lineTo(x, y);
                });
                cr.stroke();
            };

            drawLine(this._rxHistory, this._settings.downloadLineColor ?? '#5AC8FAFF');
            drawLine(this._txHistory, this._settings.uploadLineColor ?? '#FF9F0AFF');
        }

        cr.$dispose();
    }
}
