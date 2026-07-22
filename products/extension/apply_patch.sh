#!/usr/bin/env bash
set -e

echo "==> Updating Toolbar layout, CSS, and Move icon..."

mkdir -p widgets lib

# ----------------------------------------------------------------------
# 1. เขียนทับไฟล์ stylesheet.css
# ----------------------------------------------------------------------
cat << 'EOF' > stylesheet.css
/* Toolbar Background & Main Container */
.widget-edit-toolbar {
    background-color: rgba(0, 0, 0, 0.85);
    border-top-left-radius: 12px;
    border-top-right-radius: 12px;
    padding: 8px 16px; /* เว้นระยะจากขอบซ้าย-ขวา 16px */
    spacing: 12px;
}

/* Base Toolbar Button */
.widget-edit-toolbar-button {
    color: #ffffff;
    padding: 6px;
    border-radius: 6px;
    min-width: 24px;
    min-height: 24px;
}

.widget-edit-toolbar-button:hover {
    background-color: rgba(255, 255, 255, 0.2);
    color: #ffffff;
}

/* Force Uniform Icon Size & Color */
.widget-edit-toolbar-icon {
    icon-size: 20px;
    color: #ffffff;
    width: 20px;
    height: 20px;
}
EOF
echo "[✓] Updated stylesheet.css"

# ----------------------------------------------------------------------
# 2. เขียนทับไฟล์ widgets/widgetEditToolbar.js
# ----------------------------------------------------------------------
cat << 'EOF' > widgets/widgetEditToolbar.js
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

export const WidgetEditToolbar = GObject.registerClass(
class WidgetEditToolbar extends St.BoxLayout {
    _init(params = {}) {
        super._init({
            style_class: 'widget-edit-toolbar',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.START,
            ...params
        });

        // Left Actions Box (Settings, Reset, Remove)
        this._leftBox = new St.BoxLayout({
            style_class: 'widget-edit-toolbar-left',
            spacing: 8,
            x_expand: false,
            x_align: Clutter.ActorAlign.START,
        });

        // Settings Button
        this._settingsBtn = this._createButton('emblem-system-symbolic', () => this.emit('action-settings'));
        // Reset Button
        this._resetBtn = this._createButton('view-refresh-symbolic', () => this.emit('action-reset'));
        // Remove / Close Button
        this._removeBtn = this._createButton('window-close-symbolic', () => this.emit('action-remove'));

        this._leftBox.add_child(this._settingsBtn);
        this._leftBox.add_child(this._resetBtn);
        this._leftBox.add_child(this._removeBtn);

        // Spacer Actor: ยืดพื้นที่ตรงกลาง เพื่อดัน Move Button ไปชิดขวาสุด
        this._spacer = new St.Widget({
            x_expand: true,
            y_expand: false,
        });

        // Move Handle Button (ใช้ 'action-unavailable-symbolic' หรือ 'object-select-symbolic' หากไอคอนเคลื่อนย้ายมาตรฐานไม่มีในธีม)
        // 'view-grid-symbolic' / 'find-location-symbolic' / 'shapes-symbolic' 
        this._moveBtn = this._createButton('action-unavailable-symbolic', null);
        
        // ลองเปลี่ยนเป็นไอคอนลูกศร 4 ทิศของระบบ GNOME
        this._setMoveIcon(this._moveBtn);
        this._moveBtn.add_style_class_name('widget-move-handle');

        this.add_child(this._leftBox);
        this.add_child(this._spacer);
        this.add_child(this._moveBtn);
    }

    _setMoveIcon(button) {
        // รายชื่อไอคอนลูกศรย้ายของ GNOME ตามลำดับสำรอง
        const iconCandidates = [
            'transform-move-symbolic',
            'view-fullscreen-symbolic',
            'open-menu-symbolic'
        ];
        
        const icon = new St.Icon({
            icon_name: 'transform-move-symbolic',
            style_class: 'widget-edit-toolbar-icon',
        });
        button.set_child(icon);
    }

    _createButton(iconName, callback) {
        const button = new St.Button({
            style_class: 'widget-edit-toolbar-button',
            can_focus: true,
            reactive: true,
        });
        const icon = new St.Icon({
            icon_name: iconName,
            style_class: 'widget-edit-toolbar-icon',
        });
        button.set_child(icon);
        if (callback)
            button.connect('clicked', callback);
        return button;
    }
});
EOF
echo "[✓] Updated widgets/widgetEditToolbar.js"

echo "==> All updates applied successfully!"