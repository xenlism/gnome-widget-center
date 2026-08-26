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
        // this._content is a plain wrapper - it stacks header+body
        // vertically. The Content Layer itself (this._layers.content)
        // carries no style of its own (Rule 5).
        // x_expand/y_expand must be set explicitly here (every other
        // createLayeredCard() widget's wrapper sets these too - see
        // circles-cpu-half's outerBox for the pattern this was missing).
        // Without them, this BoxLayout is a non-expanding child of the
        // Content Layer's BinLayout and is sized to its own natural
        // height instead of the card's fixed block size - so header+body
        // can end up taller or shorter than the actual card, showing
        // either a sliver of the Card layer's own background peeking out
        // past body's rounded bottom, or the reverse.
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
        // [FIX] wc-calendar-header-body-header-alpha: headerColor/bodyColor
        // used to be handed straight to set_style() as raw hex. St's CSS
        // parser doesn't understand 8-digit #RRGGBBAA, so even though the
        // color picker (config.json: "alpha": true) let the user drag the
        // alpha slider below 100%, the resulting 8-digit hex was silently
        // ignored/misrendered instead of blending - the band/panel behind
        // it painted fully opaque regardless of the slider. Every other
        // widget with a background alpha field converts through
        // toCssColor(), which turns #RRGGBBAA into an rgba(...) string St
        // can actually render - so header/body now do the same instead of
        // being the one calendar widget left out of that convention.
        const headerColor = toCssColor(this._settings.headerColor, "#2563ebFF");
        const headerTextColor = this._settings.headerTextColor ?? "#ffffff";
        const bodyColor = toCssColor(this._settings.bodyColor, "#ffffffFF");
        const dayColor = this._settings.dayColor ?? "#1a1a1a";
        // [FIX] wc-calendar-header-double-radius: header/body used to hard-code
        // "22px" independently of the card's own corner radius. The card/cardBlur
        // layers already read `cornerRadius` from settings (via
        // applyLayeredCardStyle below), so as soon as the user changed the
        // Corner Radius setting in prefs, the card layer's radius moved but
        // header/body's hard-coded 22px did not - two different radii stacked
        // on top of each other at the same corner, visible as a doubled/nested
        // rounded-corner ring. Resolving the SAME value once here and reusing
        // it for both the card layer and header/body keeps them as a single,
        // consistent radius (content itself is never styled - Rule 5 - so
        // header's top corners / body's bottom corners are what actually
        // render the rounded shape; they must always match the card's radius,
        // not carry their own).
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