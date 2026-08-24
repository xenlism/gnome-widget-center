import St from "gi://St";

import GLib from "gi://GLib";

import Clutter from "gi://Clutter";

import { SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, TEXT_SHADOW_DEFAULTS, textShadowCss as _textShadowCss, cardStyleCss as _cardStyleCss, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/cardLayers.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
export default class GeekDateWeekBayWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._logger = api.logger;
        this._timeoutId = null;
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "geek-date-week-bay-widget-root"
        });
        this._actor = this._layers.root;
        this._content = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER
        });
        this._layers.content.add_child(this._content);
        this._topLabel = new St.Label({
            style_class: "geek-date-week-bay-widget-top",
            x_expand: true
        });
        this._bottomLabel = new St.Label({
            style_class: "geek-date-week-bay-widget-bottom",
            x_expand: true
        });
        this._content.add_child(this._topLabel);
        this._content.add_child(this._bottomLabel);
        this._render();
        return this._actor;
    }
    enable() {
        this._logger.info("geek-date-week-bay enabled");
        this._render();
        this._setupTimer();
    }
    disable() {
        this._logger.info("geek-date-week-bay disabled");
        this._destroyTimer();
    }
    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
            ...TEXT_SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
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
        const {family: dateFontFamily, size: dateFontSize} = _parseFontDescription(this._settings.dateFont ?? "Sans Bold 32", "Sans Bold", 32);
        const {family: weekFontFamily, size: weekFontSize} = _parseFontDescription(this._settings.weekFont ?? "Sans Bold 16", "Sans Bold", 16);
        const dateColor = this._settings.dateColor ?? "#ffffff";
        const weekColor = this._settings.weekColor ?? "#e6e6e6";
        const textAlign = [ "left", "center", "right" ].includes(this._settings.textAlign) ? this._settings.textAlign : "center";
        const textShadowCss = _textShadowCss(this._settings);
        applyLayeredCardStyle(this._layers, this._settings, {
            cornerRadiusFallback: 18
        }, false);
        this._content.set_style("padding: 14px 24px; " + "spacing: 5px;");
        const topText = (now.format("%d %B %Y") ?? "").toUpperCase();
        this._topLabel.set_text(topText);
        this._topLabel.set_style(`color: ${dateColor}; font-family: ${dateFontFamily}; ` + `font-size: ${dateFontSize}px; font-weight: bold; text-align: ${textAlign}; ` + `${textShadowCss}`);
        const bottomText = (now.format(this._settings.weekFormat === "DDD" ? "%a" : "%A") ?? "").toUpperCase();
        this._bottomLabel.set_text(bottomText);
        this._bottomLabel.set_style(`color: ${weekColor}; font-family: ${weekFontFamily}; ` + `font-size: ${weekFontSize}px; text-align: ${textAlign}; ` + `${textShadowCss}`);
    }
}