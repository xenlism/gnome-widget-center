import Clutter from "gi://Clutter";

import St from "gi://St";

import GLib from "gi://GLib";

import { SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss } from "../../lib/widgetVisualKit.js";

export default class CalendarMinimalWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
    }
    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: "calendar-minimal-widget-root",
            vertical: true
        });
        this._dayLabel = new St.Label({
            style_class: "calendar-minimal-widget-day"
        });
        this._subtitleLabel = new St.Label({
            style_class: "calendar-minimal-widget-subtitle"
        });
        this._actor.add_child(this._dayLabel);
        this._actor.add_child(this._subtitleLabel);
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
            cardColor: "#ffffff",
            textColor: "#1a1a1a",
            accentColor: "#d81f26",
            showMonth: true
        };
    }
    onSettingsChanged() {
        this._render();
    }
    _render() {
        const now = GLib.DateTime.new_now_local();
        const cardColor = this._settings.cardColor ?? "#ffffff";
        const textColor = this._settings.textColor ?? "#1a1a1a";
        const accentColor = this._settings.accentColor ?? "#6b6b6b";
        const showMonth = this._settings.showMonth ?? true;
        this._actor.set_style("border-radius: 22px; " + "padding: 18px 12px; " + "spacing: 4px;" + _shadowBoxShadowCss(this._settings));
        this._dayLabel.set_text(`${now.get_day_of_month()}`);
        this._dayLabel.set_style(`color: ${textColor}; font-weight: 300; font-size: 64px; ` + "text-align: center;");
        const weekday = (now.format("%A") ?? "").toUpperCase();
        const month = (now.format("%B") ?? "").toUpperCase();
        this._subtitleLabel.set_text(showMonth ? `${weekday} · ${month}` : weekday);
        this._subtitleLabel.set_style(`color: ${accentColor}; font-weight: bold; font-size: 12px; ` + "text-align: center;");
    }
}