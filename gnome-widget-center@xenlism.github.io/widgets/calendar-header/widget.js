import Clutter from "gi://Clutter";

import GLib from "gi://GLib";

import St from "gi://St";

import { SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, BORDER_DEFAULTS, OPACITY_DEFAULTS, toCssColor } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/cardLayers.js";

import { resolveCornerRadius } from "../../lib/widgetVisualKit.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
export default class CalendarHeaderWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._timeoutId = null;
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "calendar-header-widget-root"
        });
        this._actor = this._layers.root;
        this._content = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true
        });
        this._layers.content.add_child(this._content);
        const header = new St.BoxLayout({
            style_class: "calendar-header-widget-header",
            vertical: true,
            x_expand: true
        });
        const monthLabel = new St.Label({
            style_class: "calendar-header-widget-month"
        });
        const weekdayLabel = new St.Label({
            style_class: "calendar-header-widget-weekday"
        });
        header.add_child(monthLabel);
        header.add_child(weekdayLabel);
        const body = new St.BoxLayout({
            style_class: "calendar-header-widget-body",
            vertical: true,
            x_expand: true,
            y_expand: true
        });
        const dayLabel = new St.Label({
            style_class: "calendar-header-widget-day",
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true
        });
        body.add_child(dayLabel);
        this._content.add_child(header);
        this._content.add_child(body);
        this._header = header;
        this._monthLabel = monthLabel;
        this._weekdayLabel = weekdayLabel;
        this._body = body;
        this._dayLabel = dayLabel;
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
        const headerColor = toCssColor(this._settings.headerColor, "#2563ebFF");
        const headerTextColor = this._settings.headerTextColor ?? "#ffffff";
        const bodyColor = toCssColor(this._settings.bodyColor, "#ffffffFF");
        const dayColor = this._settings.dayColor ?? "#1a1a1a";
        const cornerRadius = resolveCornerRadius(this._settings, 22, "cornerRadius");
        applyLayeredCardStyle(this._layers, this._settings, {
            cornerRadiusFallback: 22
        }, false);
        this._content.set_style("spacing: 0px;");
        this._header.set_style(`background-color: ${headerColor}; ` + `border-radius: ${cornerRadius}px ${cornerRadius}px 0 0; ` + "padding: 14px 12px 10px 12px; " + "spacing: 2px;");
        this._monthLabel.set_text((now.format("%B") ?? "").toUpperCase());
        this._monthLabel.set_style(`color: ${headerTextColor}; font-weight: bold; font-size: 14px; ` + "text-align: center;");
        this._weekdayLabel.set_text((now.format("%A") ?? "").toUpperCase());
        this._weekdayLabel.set_style(`color: ${headerTextColor}; font-weight: bold; font-size: 18px; ` + "text-align: center;");
        this._body.set_style(`background-color: ${bodyColor}; ` + `border-radius: 0 0 ${cornerRadius}px ${cornerRadius}px; ` + "padding: 14px 12px;");
        this._dayLabel.set_text(`${now.get_day_of_month()}`);
        this._dayLabel.set_style(`color: ${dayColor}; font-weight: bold; font-size: 56px; ` + "text-align: center;");
    }
}