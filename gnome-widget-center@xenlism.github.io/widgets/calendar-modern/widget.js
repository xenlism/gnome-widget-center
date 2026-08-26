import Clutter from "gi://Clutter";

import St from "gi://St";

import GLib from "gi://GLib";

import { SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
export default class CalendarModernWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "calendar-modern-widget-root"
        });
        this._actor = this._layers.root;
        this._content = new St.BoxLayout({
            vertical: true
        });
        this._layers.content.add_child(this._content);
        this._monthLabel = new St.Label({
            style_class: "calendar-modern-widget-month"
        });
        this._weekdayLabel = new St.Label({
            style_class: "calendar-modern-widget-weekday"
        });
        this._dayLabel = new St.Label({
            style_class: "calendar-modern-widget-day"
        });
        this._content.add_child(this._monthLabel);
        this._content.add_child(this._weekdayLabel);
        this._content.add_child(this._dayLabel);
        this._render();
        return this._actor;
    }
    enable() {
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._render();
            return GLib.SOURCE_CONTINUE;
        });
    }
    disable() {
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }
    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
        };
    }
    onSettingsChanged() {
        this._render();
    }
    _render() {
        const now = GLib.DateTime.new_now_local();
        const cardColor = this._settings.cardColor ?? "#ffffff";
        const accentColor = this._settings.accentColor ?? "#d81f26";
        const textColor = this._settings.textColor ?? "#1a1a1a";
        applyLayeredCardStyle(this._layers, this._settings, {
            backgroundColorKey: "cardColor",
            cornerRadiusFallback: 22
        }, false);
        this._content.set_style(" padding: 18px 12px; spacing: 4px;");
        this._monthLabel.set_text((now.format("%B") ?? "").toUpperCase());
        this._monthLabel.set_style(`color: ${textColor}; font-weight: bold; font-size: 20px; ` + "text-align: center;");
        this._weekdayLabel.set_text((now.format("%A") ?? "").toUpperCase());
        this._weekdayLabel.set_style(`color: ${accentColor}; font-weight: bold; font-size: 14px; ` + "text-align: center;");
        this._dayLabel.set_text(`${now.get_day_of_month()}`);
        this._dayLabel.set_style(`color: ${textColor}; font-weight: bold; font-size: 56px; ` + "text-align: center;");
    }
}