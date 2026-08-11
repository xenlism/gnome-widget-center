import Clutter from "gi://Clutter";

import GLib from "gi://GLib";

import { $ } from "../../lib/gjskit/st/index.js";

import { SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, borderCss as _borderCss, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

export default class CalendarHeaderWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
    }
    buildActor() {
        const root = $.box({
            style_class: "calendar-header-widget-root",
            vertical: true
        });
        const header = $.box({
            style_class: "calendar-header-widget-header",
            vertical: true
        });
        const monthLabel = $.label({
            style_class: "calendar-header-widget-month"
        });
        const weekdayLabel = $.label({
            style_class: "calendar-header-widget-weekday"
        });
        header.append(monthLabel).append(weekdayLabel);
        const body = $.box({
            style_class: "calendar-header-widget-body",
            vertical: true
        });
        const dayLabel = $.label({
            style_class: "calendar-header-widget-day"
        });
        body.append(dayLabel);
        root.append(header).append(body);
        this._actor = root.raw;
        this._header = header.raw;
        this._monthLabel = monthLabel.raw;
        this._weekdayLabel = weekdayLabel.raw;
        this._body = body.raw;
        this._dayLabel = dayLabel.raw;
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
            headerColor: "#2563eb",
            headerTextColor: "#ffffff",
            bodyColor: "#ffffff",
            dayColor: "#1a1a1a"
        };
    }
    onSettingsChanged() {
        this._render();
    }
    _render() {
        const now = GLib.DateTime.new_now_local();
        const headerColor = this._settings.headerColor ?? "#2563eb";
        const headerTextColor = this._settings.headerTextColor ?? "#ffffff";
        const bodyColor = this._settings.bodyColor ?? "#ffffff";
        const dayColor = this._settings.dayColor ?? "#1a1a1a";
        this._actor.set_style("border-radius: 22px; " + "spacing: 0px;" + _borderCss(this._settings) + _shadowBoxShadowCss(this._settings));
        this._header.set_style(`background-color: ${headerColor}; ` + "border-radius: 22px 22px 0 0; " + "padding: 14px 12px 10px 12px; " + "spacing: 2px;");
        this._monthLabel.set_text((now.format("%B") ?? "").toUpperCase());
        this._monthLabel.set_style(`color: ${headerTextColor}; font-weight: bold; font-size: 14px; ` + "text-align: center;");
        this._weekdayLabel.set_text((now.format("%A") ?? "").toUpperCase());
        this._weekdayLabel.set_style(`color: ${headerTextColor}; font-weight: bold; font-size: 18px; ` + "text-align: center;");
        this._body.set_style(`background-color: ${bodyColor}; ` + "border-radius: 0 0 22px 22px; " + "padding: 14px 12px;");
        this._dayLabel.set_text(`${now.get_day_of_month()}`);
        this._dayLabel.set_style(`color: ${dayColor}; font-weight: bold; font-size: 56px; ` + "text-align: center;");
    }
}