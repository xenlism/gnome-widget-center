// widgets/circles-disk-half/widget.js
//
// 1x1 card: Disk usage drawn as a HALF-circle (semicircle) ring instead
// of the full circle widgets/circles-disk uses, sitting next to a
// caption + percentage label. Which side the ring hugs (and therefore
// which side the text sits on) is a setting (`ringSide`), not fixed -
// see _layout() below.
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
// Data source: disk usage has no equivalent in lib/systemMetricsApi.js,
// so - same as widgets/circles-disk - it's read directly via
// Gio.File's query_filesystem_info().

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Cairo from 'cairo';

import {SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, hexToRgba as _hexToRgba, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription} from '../../lib/widgetVisualKit.js';

// 1x1 block-type is 11x11 cells (176x176px); 14px card padding leaves a
// ~148x148 content area, split into a ring column and a text column.
const RING_COLUMN_WIDTH = 74;
const CONTENT_HEIGHT = 148;
const COLUMN_GAP = 10;
const CARD_PADDING = 14;

export default class CirclesDiskHalfWidget {
    /** @param {WidgetAPI} api - see WIDGET_API.md §5. */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timerId = null;
        this._fraction = 0;
    }

    buildActor() {
        this._actor = new St.Bin({
            style_class: 'circles-disk-half-root',
            x_expand: true,
            y_expand: true,
        });

        const outerBox = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true});
        this._actor.set_child(outerBox);
        outerBox.set_style(`padding: ${CARD_PADDING}px;`);

        const centerBin = new St.Bin({x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        outerBox.add_child(centerBin);

        this._row = new St.BoxLayout({vertical: false, y_align: Clutter.ActorAlign.CENTER});
        centerBin.set_child(this._row);

        this._ringArea = new St.DrawingArea({width: RING_COLUMN_WIDTH, height: CONTENT_HEIGHT});
        this._repaintId = this._ringArea.connect('repaint', () => this._onRepaint());

        this._textBox = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._textBox.set_width(CONTENT_HEIGHT - RING_COLUMN_WIDTH - COLUMN_GAP > 0
            ? CONTENT_HEIGHT - RING_COLUMN_WIDTH - COLUMN_GAP : 60);

        this._captionLabel = new St.Label({text: 'HDD', x_align: Clutter.ActorAlign.CENTER});
        this._textBox.add_child(this._captionLabel);

        this._valueLabel = new St.Label({text: '0%', x_align: Clutter.ActorAlign.CENTER});
        this._textBox.add_child(this._valueLabel);

        this._layoutChildren();
        this._render();
        this._tick();
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
    }

    getDefaultSettings() {
        return {
            ...SHADOW_DEFAULTS,
            backgroundColor: '#000000a9',
            cornerRadius: 18,

            circleBaseColor: '#FFFFFF26',
            hddRingColor: '#F5C211FF',
            ringThickness: 10,
            ringSide: 'right',

            captionText: 'HDD',
            captionFont: 'Sans 10',
            captionColor: '#FFFFFFB3',
            hddValueFont: 'Sans Bold 24',
            hddValueColor: '#FFFFFFFF',

            refreshRateSeconds: 2,
        };
    }

    onSettingsChanged() {
        this._layoutChildren();
        this._render();
        this._startTimer(); // picks up a changed refreshRateSeconds too
    }

    /** @private puts the ring column and text column in the order
     * `ringSide` calls for - "right" means ring column last (visually
     * right, since this is a plain horizontal BoxLayout), "left" means
     * ring column first. */
    _layoutChildren() {
        const side = this._settings.ringSide === 'left' ? 'left' : 'right';
        // Let the ring's flat endpoints meet the selected card edge while
        // preserving the text column's normal padding.
        this._ringArea.set_translation(side === 'left' ? -CARD_PADDING : CARD_PADDING, 0, 0);
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
        const disk = this._getDiskUsage('/');
        this._fraction = Math.max(0, Math.min(100, disk.percent ?? 0)) / 100;
        this._render();
    }

    /** @private free/total space for `path`'s filesystem via
     * Gio.File.query_filesystem_info() - same approach as
     * widgets/circles-disk. */
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
            this._api.logger.info(`circles-disk-half: could not read disk usage for ${path}: ${e}`);
            return {totalBytes: 0, freeBytes: 0, usedBytes: 0, percent: 0};
        }
    }

    /** @private */
    _render() {
        this._actor.set_style(_cardStyleCss(this._settings, {backgroundColorFallback: '#000000a9', cornerRadiusFallback: 18}));

        const captionColor = _toCssColor(this._settings.captionColor, '#FFFFFFB3');
        const captionFont = _parseFontDescription(this._settings.captionFont ?? 'Sans 10', 'Sans', 10);
        this._captionLabel.set_text(this._settings.captionText ?? 'HDD');
        this._captionLabel.set_style(
            `color: ${captionColor}; font-family: ${captionFont.family}; ` +
            `font-size: ${captionFont.size}px; text-align: center;`
        );

        const valueColor = _toCssColor(this._settings.hddValueColor, '#FFFFFFFF');
        const valueFont = _parseFontDescription(this._settings.hddValueFont ?? 'Sans Bold 24', 'Sans Bold', 24);
        this._valueLabel.set_text(`${Math.round(this._fraction * 100)}%`);
        this._valueLabel.set_style(
            `color: ${valueColor}; font-family: ${valueFont.family}; ` +
            `font-size: ${valueFont.size}px; font-weight: bold; text-align: center;`
        );

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
        const ringColor = _hexToRgba(this._settings.hddRingColor ?? '#F5C211FF');

        // Keep the curved part inside the card: a right-side ring bends
        // left toward its text, and a left-side ring bends right.
        const cx = side === 'left' ? 0 : RING_COLUMN_WIDTH;
        const cy = CONTENT_HEIGHT / 2;
        const radius = Math.min(RING_COLUMN_WIDTH - thickness / 2 - 2, CONTENT_HEIGHT / 2 - thickness / 2 - 2);
        const fraction = Math.max(0, Math.min(1, this._fraction));
        const start = -Math.PI / 2; // top

        cr.setLineWidth(thickness);
        // Flat (butt) caps, not round - a round cap would poke past the
        // flat diameter edge at the 0%/top end.
        cr.setLineCap(Cairo.LineCap.BUTT);

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

        cr.$dispose();
    }
}
