export class WidgetWrapper {
    constructor(widget) {
        this._widget = widget;
    }
    get raw() {
        return this._widget;
    }
    on(signal, callback) {
        this._widget.connect(signal, callback);
        return this;
    }
    visible(isVisible) {
        if ("set_visible" in this._widget) {
            this._widget.set_visible(isVisible);
        }
        return this;
    }
    enabled(isEnabled) {
        if ("set_sensitive" in this._widget) {
            this._widget.set_sensitive(isEnabled);
        } else if ("set_reactive" in this._widget) {
            this._widget.set_reactive(isEnabled);
        }
        return this;
    }
    style_class(className) {
        if ("add_css_class" in this._widget) {
            this._widget.add_css_class(className);
        } else if ("add_style_class_name" in this._widget) {
            this._widget.add_style_class_name(className);
        }
        return this;
    }
    remove(widget) {
        if ("remove" in this._widget) {
            this._widget.remove(widget.raw);
        } else if ("remove_child" in this._widget) {
            this._widget.remove_child(widget.raw);
        }
        return this;
    }
    focus() {
        if ("grab_focus" in this._widget) {
            this._widget.grab_focus();
        } else if ("grab_key_focus" in this._widget) {
            this._widget.grab_key_focus();
        }
        return this;
    }
    margin(top, right, bottom, left) {
        if (top !== undefined) this._widget.set_margin_top(top);
        if (bottom !== undefined) this._widget.set_margin_bottom(bottom);
        if (right !== undefined) {
            if ("set_margin_end" in this._widget) this._widget.set_margin_end(right); else if ("set_margin_right" in this._widget) this._widget.set_margin_right(right);
        }
        if (left !== undefined) {
            if ("set_margin_start" in this._widget) this._widget.set_margin_start(left); else if ("set_margin_left" in this._widget) this._widget.set_margin_left(left);
        }
        return this;
    }
    marginAll(px) {
        return this.margin(px, px, px, px);
    }
    opacity(value) {
        if ("set_opacity" in this._widget) {
            const isSt = "add_style_class_name" in this._widget;
            this._widget.set_opacity(isSt ? Math.round(value * 255) : value);
        }
        return this;
    }
    destroy() {
        const widget = this._widget;
        if (!widget) return this;
        try {
            const isSt = "add_style_class_name" in widget;
            if (isSt) {
                if ("destroy" in widget) widget.destroy();
            } else if ("close" in widget) {
                widget.close();
            } else if ("unparent" in widget && widget.get_parent?.()) {
                widget.unparent();
            }
        } catch (e) {}
        this._widget = null;
        return this;
    }
}