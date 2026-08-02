// widgets/cpu-monitor/widget.js
//
// 1x1 card: big "NN% CPU" text on top, a scrolling sparkline history strip
// on the bottom, on a rounded card background - see the reference mockup
// this was built from. Self-contained (per WIDGET_API.md §1, a widget only
// ever imports its own files + lib/), so the small helpers below
// (hex-color parsing, Pango font splitting, sparkline painting) are
// duplicated across cpu-monitor/mem-monitor/network-monitor rather than
// shared - same convention weather-dark/weather-minimal already use in
// this project.
//
// Data source: lib/systemMetricsApi.js's SystemMetricsService, which this
// widget is allowed to import because it ships bundled inside this
// extension (WIDGET_API.md §9.2's "bundled widgets only" path
// restriction). One instance per widget instance, as required - sharing
// one across widgets would corrupt the CPU% delta state.
//
// Graph: St.DrawingArea + Cairo (`import Cairo from 'cairo';` - GJS's
// built-in Cairo module, NOT a `gi://` import - see gjs.guide's
// Imports-and-Modules page). Every repaint clears the canvas first
// (Cairo.Operator.CLEAR) to avoid ghosting from the previous frame, and
// disposes the context (`cr.$dispose()`) afterward - a well-known GJS
// Cairo leak otherwise.

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

/** @private Splits "#RRGGBB" or "#RRGGBBAA" into 0-1 float channels. */
function _parseHexColor(hex, fallback = '#FFFFFFFF') {
    const value = typeof hex === 'string' && /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex) ? hex : fallback;
    const r = parseInt(value.slice(1, 3), 16) / 255;
    const g = parseInt(value.slice(3, 5), 16) / 255;
    const b = parseInt(value.slice(5, 7), 16) / 255;
    const a = value.length === 9 ? parseInt(value.slice(7, 9), 16) / 255 : 1;
    return {r, g, b, a};
}

/** @private Splits a combined Pango font-description string ("Sans Bold 34")
 * into the pieces St's CSS-like set_style() needs separately. Same pattern
 * WIDGET_API.md §6.4 documents for widgets/clock-modern/widget.js's
 * _parseFontDescription(). */
function _splitFontDescription(fontStr, fallbackFamily = 'Sans', fallbackSize = 34) {
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

export default class CpuMonitorWidget {
    /** @param {WidgetAPI} api - see WIDGET_API.md §5. */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._metrics = new SystemMetricsService();
        this._history = [];
        this._timerId = null;
        this._pressId = null;
    }

    // Must never throw, even with completely empty settings.
    buildActor() {
        this._actor = new St.Bin({
            style_class: 'cpu-monitor-root',
            x_expand: true,
            y_expand: true,
        });

        this._content = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true});
        this._actor.set_child(this._content);

        this._textBox = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true});
        this._valueLabel = new St.Label({style_class: 'cpu-monitor-value'});
        this._captionLabel = new St.Label({style_class: 'cpu-monitor-caption'});
        this._textBox.add_child(this._valueLabel);
        this._textBox.add_child(this._captionLabel);

        this._graphArea = new St.DrawingArea({style_class: 'cpu-monitor-graph', x_expand: true, height: GRAPH_HEIGHT});
        this._repaintId = this._graphArea.connect('repaint', area => this._onRepaint(area));

        this._content.add_child(this._textBox);
        this._content.add_child(this._graphArea);

        this._render();
        // First real sample right away rather than waiting a full
        // refresh interval for the first number to appear.
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
            fontDesc: 'Sans Bold 34',
            fontColor: '#FFFFFFFF',
            graphLineColor: '#5AC8FAFF',
            graphBaseColor: '#FFFFFF12',
            backgroundColor: '#000000FF',
            cornerRadius: 18,
            refreshRateSeconds: 3,
            launchAppPath: '',
        };
    }

    // Cross-process live update (Control Center runs in a separate GTK4
    // process) - re-render immediately, and restart the timer if the
    // refresh interval itself just changed.
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
        const {percent} = this._metrics.getCpuUsage();
        this._history.push(percent);
        if (this._history.length > MAX_HISTORY)
            this._history.shift();

        this._valueLabel.set_text(`${percent}%`);
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
                this._api.logger.info(`cpu-monitor: could not read .desktop file at ${path}`);
        } catch (e) {
            this._api.logger.info(`cpu-monitor: failed to launch ${path}: ${e}`);
        }
    }

    /** @private */
    _render() {
        const backgroundColor = _toCssColor(this._settings.backgroundColor, '#000000FF');
        const cornerRadius = this._settings.cornerRadius ?? 18;
        const fontColor = _toCssColor(this._settings.fontColor, '#FFFFFFFF');
        const graphBaseColor = _toCssColor(this._settings.graphBaseColor, '#FFFFFF12');
        const font = _splitFontDescription(this._settings.fontDesc ?? 'Sans Bold 34', 'Sans', 34);

        this._actor.set_style(
            `background-color: ${backgroundColor}; ` +
            `border-radius: ${cornerRadius}px;` +
            _shadowBoxShadowCss(this._settings)
        );

        this._textBox.set_style(`padding: ${CARD_PADDING}px ${CARD_PADDING}px 6px ${CARD_PADDING}px; spacing: 2px;`);

        this._valueLabel.set_style(
            `color: ${fontColor}; ` +
            `font-family: ${font.family}; font-weight: ${font.weight}; font-style: ${font.styleCss}; ` +
            `font-size: ${font.size}px;`
        );

        this._captionLabel.set_text('CPU');
        this._captionLabel.set_style(
            `color: ${fontColor}; ` +
            `font-family: ${font.family}; font-weight: ${font.weight}; font-style: ${font.styleCss}; ` +
            `font-size: ${Math.max(12, Math.round(font.size * 0.4))}px;`
        );

        this._graphArea.set_style(`background-color: ${graphBaseColor}; margin: 6px 0 ${CARD_PADDING}px 0;`);

        if (this._graphArea)
            this._graphArea.queue_repaint();
    }

    /** @private Cairo sparkline of this._history, scaled to a fixed 0-100
     * range (it's a percent). Never throws on an empty/short history. */
    _onRepaint(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        if (this._history.length >= 2) {
            const {r, g, b, a} = _parseHexColor(this._settings.graphLineColor ?? '#5AC8FAFF');
            const points = this._history;
            const stepX = width / Math.max(1, MAX_HISTORY - 1);
            const startIndex = MAX_HISTORY - points.length;

            cr.setLineWidth(2);
            cr.setSourceRGBA(r, g, b, a);

            points.forEach((value, i) => {
                const x = (startIndex + i) * stepX;
                const y = height - 6 - (Math.max(0, Math.min(100, value)) / 100) * (height - 12);
                if (i === 0)
                    cr.moveTo(x, y);
                else
                    cr.lineTo(x, y);
            });
            cr.stroke();
        }

        cr.$dispose();
    }
}
