import St from 'gi://St';
import { WidgetWrapper } from '../core/Wrapper.js';

export class StWidgetWrapper extends WidgetWrapper {
    style_class(style) {
        this._widget.set_style_class_name(style);
        return this;
    }

    // Sets a fixed pixel size on the underlying St actor. Widgets in
    // gnome-widget-center are grid-placed by block-type (cols x rows,
    // see WidgetLoader/BlockSizeManager), so their root container's size should
    // always come from that contract rather than being left to grow with
    // whatever content ends up inside it.
    size(width, height) {
        this._widget.set_size(width, height);
        return this;
    }

    // Enables/disables clipping of this actor (and its children) to its
    // own allocation - optionally inflated by `overflowPx` on every side.
    // Combined with size(), this is what stops a widget's content (a
    // long label, a big font) from visually overflowing its declared
    // block-type footprint into whatever is placed next to it on the
    // desktop - see development/widgetapi-handover.md.
    //
    // `overflowPx` (default 0, exact clip) exists so a widget's own
    // drop-shadow - painted via CSS `box-shadow` on this same actor, see
    // lib/widgetVisualKit.js's shadowBoxShadowCss() - isn't clipped away
    // entirely: 0 keeps the old hard `clip_to_allocation` behavior
    // (nothing bleeds, including shadow); >0 switches to an explicit
    // Clutter clip rect inflated by that many px in every direction, so
    // paint (shadow included) can bleed up to `overflowPx` before being
    // cut. Callers are responsible for keeping `overflowPx` within
    // whatever gap is guaranteed between neighboring widgets (e.g. the
    // `widget-spacing` GSetting - see widgetLoader.js's
    // _enforceBlockSize()) so a bled shadow never reaches into a
    // neighboring widget's own block footprint.
    clip(enabled = true, overflowPx = 0) {
        if (!enabled) {
            this._widget.clip_to_allocation = false;
            this._widget.remove_clip();
            return this;
        }

        const margin = Math.max(0, Number(overflowPx) || 0);
        if (margin === 0) {
            this._widget.clip_to_allocation = true;
            return this;
        }

        // Explicit clip rect instead of clip_to_allocation: the latter is
        // always exactly the actor's own allocation with no way to
        // inflate it, which is precisely the restriction being lifted
        // here.
        this._widget.clip_to_allocation = false;
        const [width, height] = this._widget.get_size();
        this._widget.set_clip(-margin, -margin, width + margin * 2, height + margin * 2);
        return this;
    }
}
