// widgets/circles-disk/widget.js
//
// 1x1 card: a single ring gauge (base track + disk-usage progress arc)
// with the "DISK" caption and the live percentage centered inside it -
// see the reference mockup this was built from. Pattern is
// widgets/system-monitor-mini's per-metric gauge (Clutter.BinLayout stack:
// St.DrawingArea behind, an St.BoxLayout of labels on top), split out
// into its own full-size 1x1 card.
//
// Data source: disk usage has no equivalent in lib/systemMetricsApi.js
// (unlike CPU/memory/network), so this widget reads it directly via
// Gio.File's query_filesystem_info() (`filesystem::size`/
// `filesystem::free` attributes) - the standard GJS way to get free/total
// space for a mount point, same approach widgets/system-monitor-mini
// already uses locally for its own Disk gauge. Kept local rather than
// added to the shared lib per systemMetricsApi.js's own scope note.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Cairo from 'cairo';
import {
    SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, hexToRgba as _hexToRgba,
    toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, BORDER_DEFAULTS, OPACITY_DEFAULTS,} from '../../lib/widgetVisualKit.js';

const RING_SIZE = 128; // 1x1 block-type is now 11x11 cells (176px) not 10x10 (160px); scaled 116 * (176/160) = 127.6 -> 128

export default class CirclesDiskWidget {
    /** @param {WidgetAPI} api - see WIDGET_API.md §5. */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timerId = null;
        this._pressId = null;
        this._fraction = 0;
    }

    buildActor() {
        this._actor = new St.Bin({
            style_class: 'circles-disk-root',
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
        this._labelLabel = new St.Label({text: 'DISK', style_class: 'circles-disk-label'});
        this._valueLabel = new St.Label({text: '0%', style_class: 'circles-disk-value'});
        textBox.add_child(this._labelLabel);
        textBox.add_child(this._valueLabel);
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
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
            backgroundColor: '#FFFFFF00',
            cornerRadius: 18,

            labelFont: 'Sans 12',
            labelColor: '#FFFFFFB3',
            percentFont: 'Sans Bold 22',
            percentColor: '#FFFFFFFF',

            circleBaseColor: '#FFFFFF26',
            ringColor: '#F5A623FF',
            ringThickness: 10,

            diskPath: '/',
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
        this._tick(); // don't wait a full interval for the first real value
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
        const diskPath = this._settings.diskPath || '/';
        const {percent} = this._getDiskUsage(diskPath);
        const clamped = Math.max(0, Math.min(100, percent ?? 0));
        this._fraction = clamped / 100;
        this._valueLabel.set_text(`${Math.round(clamped)}%`);
        if (this._ringArea)
            this._ringArea.queue_repaint();
    }

    /** @private free/total space for `path`'s filesystem via
     * Gio.File.query_filesystem_info() - the standard GJS equivalent of
     * `df`. Never throws - returns 0% on any failure (missing mount,
     * permission error, etc). */
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
            this._api.logger.info(`circles-disk: could not read disk usage for ${path}: ${e}`);
            return {totalBytes: 0, freeBytes: 0, usedBytes: 0, percent: 0};
        }
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
                this._api.logger.info(`circles-disk: could not read .desktop file at ${path}`);
        } catch (e) {
            this._api.logger.info(`circles-disk: failed to launch ${path}: ${e}`);
        }
    }

    /** @private */
    _render() {
        const backgroundColor = _toCssColor(this._settings.backgroundColor, '#FFFFFF00');
        const cornerRadius = this._settings.cornerRadius ?? 18;
        this._actor.set_style(_cardStyleCss(this._settings, {cornerRadiusFallback: 18}));

        const labelColor = _toCssColor(this._settings.labelColor, '#FFFFFFB3');
        const percentColor = _toCssColor(this._settings.percentColor, '#FFFFFFFF');
        const labelFont = _parseFontDescription(this._settings.labelFont ?? 'Sans 12', 'Sans', 12);
        const percentFont = _parseFontDescription(this._settings.percentFont ?? 'Sans Bold 22', 'Sans Bold', 22);

        this._labelLabel.set_style(
            `color: ${labelColor}; font-family: ${labelFont.family}; ` +
            `font-size: ${labelFont.size}px; text-align: center;`
        );
        this._valueLabel.set_style(
            `color: ${percentColor}; font-family: ${percentFont.family}; ` +
            `font-size: ${percentFont.size}px; font-weight: bold; text-align: center;`
        );

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
        const ringColor = _hexToRgba(this._settings.ringColor ?? '#33D17AFF');

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
        // a stray dot otherwise).
        if (fraction > 0) {
            cr.setSourceRGBA(ringColor.r, ringColor.g, ringColor.b, ringColor.a);
            cr.arc(cx, cy, radius, startAngle, endAngle);
            cr.stroke();
        }

        cr.$dispose();
    }
}
