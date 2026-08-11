import St from "gi://St";

import { WidgetWrapper } from "../core/Wrapper.js";

export class StWidgetWrapper extends WidgetWrapper {
    style_class(style) {
        this._widget.set_style_class_name(style);
        return this;
    }
    size(width, height) {
        this._widget.set_size(width, height);
        return this;
    }
    clip(enabled = true, overflowPx = 0) {
        if (!enabled) {
            this._widget.clip_to_allocation = false;
            this._widget.remove_clip();
            return this;
        }
        const margin = Math.max(0, Number(overflowPx) || 0);
        if (margin === 0) {
            this._widget.remove_clip();
            this._widget.clip_to_allocation = true;
            return this;
        }
        this._widget.clip_to_allocation = false;
        const [width, height] = this._widget.get_size();
        this._widget.set_clip(-margin, -margin, width + margin * 2, height + margin * 2);
        return this;
    }
}