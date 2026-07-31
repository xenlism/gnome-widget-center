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
        if ('set_visible' in this._widget) {
            this._widget.set_visible(isVisible);
        }
        return this;
    }

    enabled(isEnabled) {
        if ('set_sensitive' in this._widget) {
            this._widget.set_sensitive(isEnabled);
        } else if ('set_reactive' in this._widget) {
            this._widget.set_reactive(isEnabled);
        }
        return this;
    }

    style_class(className) {
        if ('add_css_class' in this._widget) {
            this._widget.add_css_class(className);
        } else if ('add_style_class_name' in this._widget) {
            this._widget.add_style_class_name(className);
        }
        return this;
    }

    remove(widget) {
        if ('remove' in this._widget) {
            this._widget.remove(widget.raw);
        } else if ('remove_child' in this._widget) {
            this._widget.remove_child(widget.raw);
        }
        return this;
    }

    focus() {
        if ('grab_focus' in this._widget) {
            this._widget.grab_focus();
        } else if ('grab_key_focus' in this._widget) {
            this._widget.grab_key_focus();
        }
        return this;
    }

    // เพิ่ม: รองรับ Margin (แบบ CSS: top, right, bottom, left)
    margin(top, right, bottom, left) {
        if (top !== undefined) this._widget.set_margin_top(top);
        if (bottom !== undefined) this._widget.set_margin_bottom(bottom);
        
        // แปลง start/end ของ GTK ให้ตรงกับ left/right ของ St
        if (right !== undefined) {
            if ('set_margin_end' in this._widget) this._widget.set_margin_end(right);
            else if ('set_margin_right' in this._widget) this._widget.set_margin_right(right);
        }
        if (left !== undefined) {
            if ('set_margin_start' in this._widget) this._widget.set_margin_start(left);
            else if ('set_margin_left' in this._widget) this._widget.set_margin_left(left);
        }
        return this;
    }

    // ทางลัด: กำหนดระยะห่างรอบด้านเท่ากัน
    marginAll(px) {
        return this.margin(px, px, px, px);
    }

    // เพิ่ม: รองรับ Opacity (แปลง 0.0-1.0 ให้เป็น 0-255 สำหรับ St อัตโนมัติ)
    opacity(value) {
        if ('set_opacity' in this._widget) {
            // ตรวจสอบว่าเป็น St (0-255) หรือ GTK (0.0-1.0)
            const isSt = 'add_style_class_name' in this._widget;
            this._widget.set_opacity(isSt ? Math.round(value * 255) : value);
        }
        return this;
    }

    // เพิ่ม: การทำลาย Widget อย่างปลอดภัย
    //
    // GTK4 removed Gtk.Widget.destroy() for anything that isn't a
    // toplevel (see https://discourse.gnome.org/t/how-to-not-destroy-a-widget/7449).
    // Calling it unconditionally (as before) always threw for
    // Box/Button/Label/etc. and was only ever silently swallowed by the
    // try/catch below, so it never actually did anything useful there.
    // St (Clutter-based) actors are unaffected and still support
    // destroy(), so we branch on which toolkit we're wrapping.
    destroy() {
        const widget = this._widget;
        if (!widget) return this;

        try {
            const isSt = 'add_style_class_name' in widget;

            if (isSt) {
                // St/Clutter actors: destroy() unparents and recursively
                // destroys children. Still valid on GNOME 47-50.
                if ('destroy' in widget) widget.destroy();
            } else if ('close' in widget) {
                // GTK4 toplevels (Gtk.Window and subclasses) are closed,
                // not destroyed.
                widget.close();
            } else if ('unparent' in widget && widget.get_parent?.()) {
                // GTK4 non-toplevels: unparent and let refcounting
                // finalize the object once nothing else references it.
                widget.unparent();
            }
        } catch (e) {
            // ป้องกัน Error ถ้า Widget ถูกทำลายไปแล้ว
        }

        this._widget = null;
        return this;
    }
}
