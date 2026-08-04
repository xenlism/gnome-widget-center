// widgets/system-monitor-mini/widget.js
//
// "iStat Mini"-style card: three ring gauges (CPU / Memory / Disk usage)
// side by side, each with its caption + percentage centered inside the
// ring, plus a one-line network throughput readout below. Click launches
// an app (same launchOnClick/desktopFilePath pattern as
// widgets/clock-modern/widget.js).
//
// Ring drawing: this project has no prior use of Cairo anywhere in
// widgets/ or lib/ (grep confirms it), so this is new ground - GJS's
// built-in `St.DrawingArea` is the standard way to get a Cairo context
// inside a Shell-process actor (see St.DrawingArea's own docs: connect
// to its 'repaint' signal, call area.get_context() *only* from inside
// that handler, and call cr.$dispose() before returning to avoid leaking
// the context - GJS-specific, not part of upstream Cairo). Import is the
// special `import Cairo from 'cairo';` bare specifier GJS provides for
// its handful of built-in (non-`gi://`) modules, same category as
// `import System from 'system';` - NOT `gi://cairo`.
//
// Each gauge is a small Clutter.BinLayout stack: an St.DrawingArea
// (paints the base ring + active arc) with an St.BoxLayout of two
// St.Labels (caption, percentage) laid on top and centered - the ring
// and the text never need to know about each other's exact metrics
// because BinLayout just overlaps both children at the stack's full
// size.
//
// No glow/blur effect (the reference mockup's rings have a soft outer
// glow) - plain Cairo strokes only. A real blur would need rendering to
// an offscreen Cairo image surface and box-blurring it by hand, which is
// a lot of extra complexity for a desktop-widget-scale gauge; the flat
// ring already reads clearly at this size.
//
// CPU/Memory/Network come from lib/systemMetricsApi.js's
// SystemMetricsService, same as widgets/system-stats/widget.js (see that
// file's header for why this is a per-instance object, not a shared
// singleton). Disk usage has no equivalent in systemMetricsApi.js yet, so
// this widget reads it directly via Gio.File's query_filesystem_info()
// (`filesystem::size`/`filesystem::free` attributes) - the standard GJS
// way to get free/total space for a mount point, no /proc parsing
// needed. Kept local rather than added to the shared lib per
// systemMetricsApi.js's own scope note: adding to the shared, widgets-
// only-reachable API is a deliberate decision for whoever needs it in a
// second widget, not a silent side effect of this one.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Cairo from 'cairo';
import {SystemMetricsService} from '../../lib/systemMetricsApi.js';
import {SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, hexToRgba as _hexToRgba, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription} from '../../lib/widgetVisualKit.js';

const RING_SIZE = 84;
const RING_THICKNESS = 8;
// 2026-07-29 fix ("need less space between the circle"): was 44px, which
// spread the three rings out much wider than the reference iStat-mini
// look this widget was built from.
const RING_SPACING = 16;
const CARD_PADDING = 12;

export default class SystemMonitorMiniWidget {
    /**
     * @param {WidgetAPI} api - see development/docs/WIDGET_API.md §5.
     */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._metrics = new SystemMetricsService(); // one instance per widget instance
        this._timerId = null;
        this._buttonPressId = null;
        this._gauges = []; // {area, fraction, captionLabel, valueLabel}
    }

    buildActor() {
        this._actor = new St.Bin({
            style_class: 'system-monitor-mini-root',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const content = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.CENTER});

        const ringsRow = new St.BoxLayout({vertical: false, x_align: Clutter.ActorAlign.CENTER});
        this._gauges.push(this._buildGauge(ringsRow, 'CPU'));
        ringsRow.add_child(new St.Widget({width: RING_SPACING, height: 1}));
        this._gauges.push(this._buildGauge(ringsRow, 'Memory'));
        ringsRow.add_child(new St.Widget({width: RING_SPACING, height: 1}));
        this._gauges.push(this._buildGauge(ringsRow, 'Disk'));
        content.add_child(ringsRow);

        this._networkLabel = new St.Label({style_class: 'system-monitor-mini-net-caption'});
        this._networkLabel.set_style('margin-top: 10px; text-align: center;');
        content.add_child(this._networkLabel);

        this._networkValue = new St.Label({style_class: 'system-monitor-mini-net-value'});
        this._networkValue.set_style('text-align: center;');
        content.add_child(this._networkValue);

        this._actor.set_child(content);
        this._render();
        this._applyClickHandler();
        return this._actor;
    }

    /** @private builds one ring-gauge stack (drawing area + centered
     * caption/value labels) and appends it to `parentRow`. Returns the
     * bookkeeping object _updateStats()/_repaintGauge() need. */
    _buildGauge(parentRow, caption) {
        const stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: RING_SIZE,
            height: RING_SIZE,
        });

        const area = new St.DrawingArea({width: RING_SIZE, height: RING_SIZE});
        stack.add_child(area);

        const textBox = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        const captionLabel = new St.Label({text: caption});
        const valueLabel = new St.Label({text: '0%'});
        textBox.add_child(captionLabel);
        textBox.add_child(valueLabel);
        stack.add_child(textBox);

        parentRow.add_child(stack);

        const gauge = {area, fraction: 0, captionLabel, valueLabel};
        area.connect('repaint', () => this._repaintGauge(gauge));
        return gauge;
    }

    /** @private StDrawingArea::repaint handler - must only touch Cairo
     * via area.get_context() from inside here, and must call
     * cr.$dispose() before returning (GJS-specific memory-management
     * requirement, not upstream Cairo API). */
    _repaintGauge(gauge) {
        const cr = gauge.area.get_context();
        const activeColor = _hexToRgba(this._settings.activeColor ?? '#33C7F5');
        const baseColor = _hexToRgba(this._settings.baseColor ?? '#33383D');

        const cx = RING_SIZE / 2;
        const cy = RING_SIZE / 2;
        const radius = (RING_SIZE - RING_THICKNESS) / 2;
        const startAngle = -Math.PI / 2; // 12 o'clock
        const fraction = Math.max(0, Math.min(1, gauge.fraction));
        const endAngle = startAngle + fraction * 2 * Math.PI;

        cr.setLineWidth(RING_THICKNESS);
        cr.setLineCap(Cairo.LineCap.ROUND);

        // Base track - always a full circle.
        cr.setSourceRGBA(baseColor.r, baseColor.g, baseColor.b, baseColor.a);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();

        // Active arc - only if there's something to show, since a
        // zero-length arc with round caps still paints a stray dot.
        if (fraction > 0) {
            cr.setSourceRGBA(activeColor.r, activeColor.g, activeColor.b, activeColor.a);
            cr.arc(cx, cy, radius, startAngle, endAngle);
            cr.stroke();
        }

        cr.$dispose();
    }

    enable() {
        this._startTimer();
    }

    disable() {
        this._destroyTimer();
        this._removeClickHandler();
    }

    getDefaultSettings() {
        return {
            ...SHADOW_DEFAULTS,
            activeColor: '#33C7F5',
            baseColor: '#33383D',
            font: 'Sans Bold 18',
            backgroundColor: '#1C1C1EE6',
            cornerRadius: 18,
            refreshRateSec: 3,
            launchOnClick: false,
            desktopFilePath: '',
        };
    }

    // Cross-process live update: re-render immediately (colors/font/
    // background/corner-radius show up right away), re-wire the click
    // handler in case launchOnClick/desktopFilePath changed, and restart
    // the timer if refreshRateSec changed (same "restart the timer with
    // the new interval" pattern as widgets/clock/widget.js's
    // showSeconds handling).
    onSettingsChanged() {
        this._render();
        this._applyClickHandler();
        this._startTimer();
    }

    /** @private (re)starts the refresh timer at the current
     * refreshRateSec, replacing any existing one - safe to call from
     * enable() or from a settings change. */
    _startTimer() {
        this._destroyTimer();
        const refreshRateSec = Math.max(1, this._settings.refreshRateSec ?? 3);
        this._updateStats(); // don't wait a full interval for the first paint
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, refreshRateSec, () => {
            this._updateStats();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /** @private */
    _destroyTimer() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    /** @private reads CPU/Memory/Network via SystemMetricsService.sample()
     * (same call widgets/system-stats/widget.js makes) plus disk usage
     * locally, updates each gauge's fraction/labels, and queues a
     * repaint on the three drawing areas. */
    _updateStats() {
        const {cpu, memory, network} = this._metrics.sample();
        const disk = this._getDiskUsage('/');

        this._setGauge(this._gauges[0], cpu.percent);
        this._setGauge(this._gauges[1], memory.percent);
        this._setGauge(this._gauges[2], disk.percent);

        this._networkValue.set_text(
            `\u2193 ${this._formatBytesPerSec(network.totalRxBytesPerSec)}   ` +
            `\u2191 ${this._formatBytesPerSec(network.totalTxBytesPerSec)}`
        );
    }

    /** @private */
    _setGauge(gauge, percent) {
        const clamped = Math.max(0, Math.min(100, percent ?? 0));
        gauge.fraction = clamped / 100;
        gauge.valueLabel.set_text(`${Math.round(clamped)}%`);
        gauge.area.queue_repaint();
    }

    /** @private free/total space for `path`'s filesystem via
     * Gio.File.query_filesystem_info() - the standard GJS equivalent of
     * `df`, no /proc parsing available for this (unlike CPU/mem/net). */
    _getDiskUsage(path) {
        try {
            const file = Gio.File.new_for_path(path);
            const info = file.query_filesystem_info('filesystem::size,filesystem::free', null);
            const totalBytes = info.get_attribute_uint64('filesystem::size');
            const freeBytes = info.get_attribute_uint64('filesystem::free');
            const usedBytes = Math.max(0, totalBytes - freeBytes);
            const percent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
            return {totalBytes, freeBytes, usedBytes, percent};
        } catch (e) {
            this._api.logger.info(`system-monitor-mini: could not read disk usage for ${path}: ${e}`);
            return {totalBytes: 0, freeBytes: 0, usedBytes: 0, percent: 0};
        }
    }

    /** @private same binary (1024-based) formatting as
     * widgets/system-stats/widget.js's _formatBytesPerSec(), kept as its
     * own local copy per WIDGET_API.md §1 (a widget only ever imports its
     * own files). */
    _formatBytesPerSec(bytesPerSec) {
        const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
        let value = bytesPerSec;
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex += 1;
        }
        const formatted = unitIndex === 0 ? String(Math.round(value)) : value.toFixed(1);
        return `${formatted} ${units[unitIndex]}`;
    }

    /** @private */
    _render() {
        const backgroundColor = _toCssColor(this._settings.backgroundColor, '#1C1C1EE6');
        const cornerRadius = this._settings.cornerRadius ?? 18;
        this._actor.set_style(
            _cardStyleCss(this._settings, {backgroundColorFallback: '#1C1C1EE6', cornerRadiusFallback: 18}) +
            `padding: ${CARD_PADDING}px;`
        );

        const {family, size} = _parseFontDescription(this._settings.font ?? 'Sans Bold 18', 'Sans Bold', 18);
        const captionSize = Math.max(8, Math.round(size * 0.5));

        for (const gauge of this._gauges) {
            gauge.captionLabel.set_style(
                `color: rgba(255,255,255,0.65); font-family: ${family}; ` +
                `font-size: ${captionSize}px; font-weight: normal; text-align: center;`
            );
            gauge.valueLabel.set_style(
                `color: #ffffff; font-family: ${family}; ` +
                `font-size: ${size}px; font-weight: bold; text-align: center;`
            );
            gauge.area.queue_repaint();
        }

        this._networkLabel.set_text('Network');
        this._networkLabel.set_style(
            `color: rgba(255,255,255,0.65); font-family: ${family}; ` +
            `font-size: ${captionSize}px; font-weight: normal; text-align: center; margin-top: 10px;`
        );
        this._networkValue.set_style(
            `color: #ffffff; font-family: ${family}; ` +
            `font-size: ${captionSize}px; font-weight: normal; text-align: center;`
        );
    }

    /** @private same click-to-launch wiring as
     * widgets/clock-modern/widget.js's _applyClickHandler(). */
    _applyClickHandler() {
        this._removeClickHandler();

        const launchOnClick = this._settings.launchOnClick ?? false;
        const desktopFilePath = this._settings.desktopFilePath ?? '';
        if (!launchOnClick || !desktopFilePath)
            return;

        this._actor.reactive = true;
        this._buttonPressId = this._actor.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;

            if (event.get_state() & Clutter.ModifierType.MOD4_MASK)
                return Clutter.EVENT_PROPAGATE; // Super held - drag, not a click

            this._launchApp(desktopFilePath);
            return Clutter.EVENT_STOP;
        });
    }

    /** @private */
    _removeClickHandler() {
        if (this._buttonPressId !== null) {
            this._actor.disconnect(this._buttonPressId);
            this._buttonPressId = null;
        }
    }

    /** @private */
    _launchApp(path) {
        try {
            const appInfo = Gio.DesktopAppInfo.new_from_filename(path);
            if (!appInfo) {
                this._api.logger.info(`system-monitor-mini: could not read .desktop file at ${path}`);
                return;
            }
            appInfo.launch([], null);
        } catch (e) {
            this._api.logger.info(`system-monitor-mini: failed to launch ${path}: ${e}`);
        }
    }
}
