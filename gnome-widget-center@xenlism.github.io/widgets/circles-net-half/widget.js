// widgets/circles-net-half/widget.js
//
// 1x1 card: network throughput drawn as two concentric HALF-circle
// (semicircle) rings - outer = download, inner = upload, same pairing
// as widgets/circles-net's full circles - sitting next to a caption +
// live download/upload numbers. Same ring-column/text-column split as
// widgets/circles-cpu-half; which side the rings hug (and therefore
// which side the text sits on) is a setting (`ringSide`), not fixed -
// see _layoutChildren() below.
//
// Each half-ring uses its own adaptive recent-traffic scale so low
// download/upload rates remain visible. Its flat edge (its "diameter") always sits on the
// boundary between the ring column and the text column, and the arcs
// bulge out toward the corresponding card edge - e.g. ringSide: "right"
// draws a ")" shape hugging the right edge, flat edge on its left where
// it meets the text. Progress always starts at the TOP of the semicircle
// and sweeps down (clockwise for the right side, counter-clockwise -
// through the "west" point - for the left side) so both orientations
// read the same way: empty at top, fuller toward the bottom as
// throughput approaches its configured max.
//
// A raw byte rate has no natural "100%" the way CPU/memory/disk percentages
// do, so this follows widgets/circles-net and uses an adaptive scale.
//
// Data source: lib/systemMetricsApi.js's SystemMetricsService
// .getNetworkUsage() (bundled-widgets-only import, WIDGET_API.md §9.2).
// Combined throughput across every interface, same choice
// widgets/circles-net already makes.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Cairo from 'cairo';

import {SystemMetricsService} from '../../lib/systemMetricsApi.js';
import {SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, hexToRgba as _hexToRgba, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, BORDER_DEFAULTS, OPACITY_DEFAULTS,} from '../../lib/widgetVisualKit.js';

// 1x1 block-type is 11x11 cells (176x176px); 14px card padding leaves a
// ~148x148 content area, split into a ring column and a text column -
// same layout constants as widgets/circles-cpu-half.
const RING_COLUMN_WIDTH = 74;
const CONTENT_HEIGHT = 148;
const COLUMN_GAP = 10;
const RING_GAP = 4; // px between the download (outer) and upload (inner) half-rings
const CARD_PADDING = 14;
const MIN_DYNAMIC_SCALE_BYTES_PER_SEC = 8 * 1024;
const SCALE_HEADROOM = 1.25;
const SCALE_DECAY = 0.85;

/** @private Human-readable throughput, e.g. 1536 -> "1.5 KB/s". Same
 * helper as widgets/circles-net's own _formatRate(). */
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

/** @private Produces a useful ratio at low traffic while retaining recent
 * peaks briefly, so the ring does not rescale abruptly on every sample. */
function _adaptiveFraction(bytesPerSec, previousScale) {
    const rate = Math.max(0, Number.isFinite(bytesPerSec) ? bytesPerSec : 0);
    const scale = Math.max(
        MIN_DYNAMIC_SCALE_BYTES_PER_SEC,
        rate * SCALE_HEADROOM,
        (Number.isFinite(previousScale) ? previousScale : 0) * SCALE_DECAY
    );
    return {scale, fraction: Math.min(1, rate / scale)};
}

export default class CirclesNetHalfWidget {
    /** @param {WidgetAPI} api - see WIDGET_API.md §5. */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._metrics = new SystemMetricsService();
        this._timerId = null;
        this._downloadFraction = 0;
        this._uploadFraction = 0;
        this._downloadScale = MIN_DYNAMIC_SCALE_BYTES_PER_SEC;
        this._uploadScale = MIN_DYNAMIC_SCALE_BYTES_PER_SEC;
    }

    buildActor() {
        this._actor = new St.Bin({
            style_class: 'circles-net-half-root',
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

        this._captionLabel = new St.Label({text: 'NET', x_align: Clutter.ActorAlign.CENTER});
        this._textBox.add_child(this._captionLabel);

        this._downloadLabel = new St.Label({x_align: Clutter.ActorAlign.CENTER});
        this._textBox.add_child(this._downloadLabel);

        this._uploadLabel = new St.Label({x_align: Clutter.ActorAlign.CENTER});
        this._textBox.add_child(this._uploadLabel);

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
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
            backgroundColor: '#FFFFFF00',
            cornerRadius: 18,

            circleBaseColor: '#FFFFFF26',
            downloadColor: '#5AC8FAFF',
            uploadColor: '#FF9F0AFF',
            ringThickness: 9,
            ringSide: 'right',

            captionText: 'NET',
            captionFont: 'Sans 10',
            captionColor: '#FFFFFFB3',
            valueFont: 'Sans Bold 13',

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
        // Let the rings' flat endpoints meet the selected card edge while
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
    _render() {
        this._actor.set_style(_cardStyleCss(this._settings, {backgroundColorFallback: '#FFFFFF00', cornerRadiusFallback: 18}));

        const captionColor = _toCssColor(this._settings.captionColor, '#FFFFFFB3');
        const captionFont = _parseFontDescription(this._settings.captionFont ?? 'Sans 10', 'Sans', 10);
        this._captionLabel.set_text(this._settings.captionText ?? 'NET');
        this._captionLabel.set_style(
            `color: ${captionColor}; font-family: ${captionFont.family}; ` +
            `font-size: ${captionFont.size}px; text-align: center;`
        );

        const downloadColor = _toCssColor(this._settings.downloadColor, '#5AC8FAFF');
        const uploadColor = _toCssColor(this._settings.uploadColor, '#FF9F0AFF');
        const valueFont = _parseFontDescription(this._settings.valueFont ?? 'Sans Bold 13', 'Sans Bold', 13);

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

    /** @private StDrawingArea::repaint handler - draws the two
     * concentric half-rings, download outer + upload inner. Only
     * touches Cairo via area.get_context() from inside here, and
     * disposes the context before returning (GJS-specific requirement). */
    _onRepaint() {
        const cr = this._ringArea.get_context();

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const side = this._settings.ringSide === 'left' ? 'left' : 'right';
        const thickness = Math.max(2, this._settings.ringThickness ?? 9);
        const baseColor = _hexToRgba(this._settings.circleBaseColor ?? '#FFFFFF26');

        // Keep the curved part inside the card: a right-side ring bends
        // left toward its text, and a left-side ring bends right.
        const cx = side === 'left' ? 0 : RING_COLUMN_WIDTH;
        const cy = CONTENT_HEIGHT / 2;
        const start = -Math.PI / 2; // top

        const outerRadius = Math.min(RING_COLUMN_WIDTH - thickness / 2 - 2, CONTENT_HEIGHT / 2 - thickness / 2 - 2);
        const rings = [
            {radius: outerRadius, fraction: this._downloadFraction, color: this._settings.downloadColor ?? '#5AC8FAFF'},
            {radius: outerRadius - (thickness + RING_GAP), fraction: this._uploadFraction, color: this._settings.uploadColor ?? '#FF9F0AFF'},
        ];

        cr.setLineWidth(thickness);
        // Flat (butt) caps, not round - a round cap would poke past the
        // flat diameter edge at the 0%/top end.
        cr.setLineCap(Cairo.LineCap.BUTT);

        for (const ring of rings) {
            if (ring.radius <= 0)
                continue;

            cr.setSourceRGBA(baseColor.r, baseColor.g, baseColor.b, baseColor.a);
            if (side === 'left')
                cr.arc(cx, cy, ring.radius, start, start + Math.PI);
            else
                cr.arcNegative(cx, cy, ring.radius, start, start - Math.PI);
            cr.stroke();

            const fraction = Math.max(0, Math.min(1, ring.fraction));
            if (fraction > 0) {
                const {r, g, b, a} = _hexToRgba(ring.color);
                cr.setSourceRGBA(r, g, b, a);
                if (side === 'left')
                    cr.arc(cx, cy, ring.radius, start, start + fraction * Math.PI);
                else
                    cr.arcNegative(cx, cy, ring.radius, start, start - fraction * Math.PI);
                cr.stroke();
            }
        }

        cr.$dispose();
    }
}
