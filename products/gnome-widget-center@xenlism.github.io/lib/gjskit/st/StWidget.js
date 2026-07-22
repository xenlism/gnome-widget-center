import St from 'gi://St';
import { WidgetWrapper } from '../core/Wrapper.js';

export class StWidgetWrapper extends WidgetWrapper {
    style_class(style) {
        this._widget.set_style_class_name(style);
        return this;
    }

    // Sets a fixed pixel size on the underlying St actor. Widgets in
    // gnome-widget-center are grid-placed by block-type (cols x rows,
    // see WidgetLoader/GridEngine), so their root container's size should
    // always come from that contract rather than being left to grow with
    // whatever content ends up inside it.
    size(width, height) {
        this._widget.set_size(width, height);
        return this;
    }

    // Enables/disables clipping of children to this actor's allocation.
    // Combined with size(), this is what stops a widget's content (a
    // long label, a big font) from visually overflowing its declared
    // block-type footprint into whatever is placed next to it on the
    // desktop - see development/widgetapi-handover.md.
    clip(enabled = true) {
        this._widget.clip_to_allocation = enabled;
        return this;
    }
}
