import Clutter from "gi://Clutter";

import St from "gi://St";

import GLib from "gi://GLib";

import { SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

export default class CalendarModernWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
    }
    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: "calendar-modern-widget-root",
            vertical: true
        });
        this._monthLabel = new St.Label({
            style_class: "calendar-modern-widget-month"
        });
        this._weekdayLabel = new St.Label({
            style_class: "calendar-modern-widget-weekday"
        });
        this._dayLabel = new St.Label({
            style_class: "calendar-modern-widget-day"
        });
        this._actor.add_child(this._monthLabel);
        this._actor.add_child(this._weekdayLabel);
        this._actor.add_child(this._dayLabel);
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
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
            cardColor: "#ffffff",
            accentColor: "#d81f26",
            textColor: "#1a1a1a"
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
        this._actor.set_style((this._api.resolveCardCss?.() ?? _cardStyleCss(this._settings, {
            backgroundColorKey: "cardColor",
            cornerRadiusFallback: 22
        })) + " padding: 18px 12px; spacing: 4px;");
        this._monthLabel.set_text((now.format("%B") ?? "").toUpperCase());
        this._monthLabel.set_style(`color: ${textColor}; font-weight: bold; font-size: 20px; ` + "text-align: center;");
        this._weekdayLabel.set_text((now.format("%A") ?? "").toUpperCase());
        this._weekdayLabel.set_style(`color: ${accentColor}; font-weight: bold; font-size: 14px; ` + "text-align: center;");
        this._dayLabel.set_text(`${now.get_day_of_month()}`);
        this._dayLabel.set_style(`color: ${textColor}; font-weight: bold; font-size: 56px; ` + "text-align: center;");
    }
}