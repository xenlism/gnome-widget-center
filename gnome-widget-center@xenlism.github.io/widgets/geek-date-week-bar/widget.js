import St from "gi://St";

import GLib from "gi://GLib";

import Clutter from "gi://Clutter";

import { SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, TEXT_SHADOW_DEFAULTS, textShadowCss as _textShadowCss, cardStyleCss as _cardStyleCss, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

export default class GeekDateWeekBarWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._logger = api.logger;
        this._timeoutId = null;
    }
    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: "geek-date-week-bar-widget-root",
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER
        });
        this._topLabel = new St.Label({
            style_class: "geek-date-week-bar-widget-top",
            x_expand: true
        });
        this._bottomLabel = new St.Label({
            style_class: "geek-date-week-bar-widget-bottom",
            x_expand: true
        });
        this._actor.add_child(this._topLabel);
        this._actor.add_child(this._bottomLabel);
        this._render();
        return this._actor;
    }
    enable() {
        this._logger.info("geek-date-week-bar enabled");
        this._render();
        this._setupTimer();
    }
    disable() {
        this._logger.info("geek-date-week-bar disabled");
        this._destroyTimer();
    }
    getDefaultSettings() {
        return {
            ...SHADOW_DEFAULTS,
            ...TEXT_SHADOW_DEFAULTS,
            textShadowEnabled: true,
            textShadowDistance: 2,
            textShadowBlur: 4,
            dateFont: "Sans Bold 22",
            dateColor: "#ffffff",
            weekFont: "Sans Bold 12",
            weekColor: "#e6e6e6",
            backgroundColor: "#FFFFFF00",
            textAlign: "center",
            cornerRadius: 18,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS
        };
    }
    onSettingsChanged() {
        this._render();
        this._destroyTimer();
        this._setupTimer();
    }
    _setupTimer() {
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._render();
            return GLib.SOURCE_CONTINUE;
        });
    }
    _destroyTimer() {
        if (this._timeoutId !== null) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }
    _render() {
        const now = GLib.DateTime.new_now_local();
        const {family: dateFontFamily, size: dateFontSize} = _parseFontDescription(this._settings.dateFont ?? "Sans Bold 22", "Sans Bold", 22);
        const {family: weekFontFamily, size: weekFontSize} = _parseFontDescription(this._settings.weekFont ?? "Sans Bold 12", "Sans Bold", 12);
        const dateColor = this._settings.dateColor ?? "#ffffff";
        const weekColor = this._settings.weekColor ?? "#e6e6e6";
        const textAlign = [ "left", "center", "right" ].includes(this._settings.textAlign) ? this._settings.textAlign : "center";
        const textShadowCss = _textShadowCss(this._settings);
        this._actor.set_style((this._api.resolveCardCss?.() ?? _cardStyleCss(this._settings, {
            cornerRadiusFallback: 18
        })) + "padding: 8px 18px; " + "spacing: 2px;");
        const topText = (now.format("%d %B %Y") ?? "").toUpperCase();
        this._topLabel.set_text(topText);
        this._topLabel.set_style(`color: ${dateColor}; font-family: ${dateFontFamily}; ` + `font-size: ${dateFontSize}px; font-weight: bold; text-align: ${textAlign}; ` + `${textShadowCss}`);
        const bottomText = (now.format("%A") ?? "").toUpperCase();
        this._bottomLabel.set_text(bottomText);
        this._bottomLabel.set_style(`color: ${weekColor}; font-family: ${weekFontFamily}; ` + `font-size: ${weekFontSize}px; text-align: ${textAlign}; ` + `${textShadowCss}`);
    }
}