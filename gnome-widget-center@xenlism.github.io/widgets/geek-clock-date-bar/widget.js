import St from "gi://St";

import GLib from "gi://GLib";

import Clutter from "gi://Clutter";

import { SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, toCssColor as _toCssColor, parseFontDescription as _parseFontDescription, TEXT_SHADOW_DEFAULTS, textShadowCss as _textShadowCss, cardStyleCss as _cardStyleCss, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

export default class GeekClockDateBarWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._logger = api.logger;
        this._timeoutId = null;
    }
    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: "geek-clock-date-bar-widget-root",
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER
        });
        this._clockLabel = new St.Label({
            style_class: "geek-clock-date-bar-widget-clock",
            x_expand: true
        });
        this._dateLabel = new St.Label({
            style_class: "geek-clock-date-bar-widget-date",
            x_expand: true
        });
        this._actor.add_child(this._clockLabel);
        this._actor.add_child(this._dateLabel);
        this._render();
        return this._actor;
    }
    enable() {
        this._logger.info("geek-clock-date-bar enabled");
        this._render();
        this._setupTimer();
    }
    disable() {
        this._logger.info("geek-clock-date-bar disabled");
        this._destroyTimer();
    }
    getDefaultSettings() {
        return {
            ...SHADOW_DEFAULTS,
            ...TEXT_SHADOW_DEFAULTS,
            textShadowEnabled: true,
            textShadowDistance: 2,
            textShadowBlur: 4,
            clockFont: "Sans Bold 30",
            clockColor: "#ffffff",
            clock24Hour: true,
            clockShowSeconds: false,
            dateTextEnabled: true,
            dateFont: "Sans Bold 14",
            dateColor: "#e6e6e6",
            dateFormat: "auto",
            textAlign: "center",
            backgroundColor: "#FFFFFF00",
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
        const showSeconds = this._settings.clockShowSeconds ?? false;
        const interval = showSeconds ? 1 : 30;
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
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
    _clockFormat() {
        const is24Hour = this._settings.clock24Hour ?? true;
        const showSeconds = this._settings.clockShowSeconds ?? false;
        if (is24Hour) return showSeconds ? "%H:%M:%S" : "%H:%M";
        return showSeconds ? "%I:%M:%S %p" : "%I:%M %p";
    }
    _resolveDateFormat() {
        const setting = this._settings.dateFormat ?? "auto";
        if (setting === "mm-dd-yyyy" || setting === "dd-mm-yyyy") return setting;
        try {
            const names = GLib.get_language_names();
            for (const name of names) {
                const match = /^[a-z]{2,3}_([A-Z]{2})/.exec(name);
                if (match) {
                    const country = match[1];
                    return country === "US" ? "mm-dd-yyyy" : "dd-mm-yyyy";
                }
            }
        } catch (e) {
            this._logger.info(`geek-clock-date-bar: could not detect locale country: ${e}`);
        }
        return "dd-mm-yyyy";
    }
    _render() {
        const now = GLib.DateTime.new_now_local();
        const {family: clockFontFamily, size: clockFontSize} = _parseFontDescription(this._settings.clockFont ?? "Sans Bold 30", "Sans Bold", 30);
        const {family: dateFontFamily, size: dateFontSize} = _parseFontDescription(this._settings.dateFont ?? "Sans Bold 14", "Sans Bold", 14);
        const clockColor = this._settings.clockColor ?? "#ffffff";
        const dateColor = this._settings.dateColor ?? "#e6e6e6";
        const textAlign = [ "left", "center", "right" ].includes(this._settings.textAlign) ? this._settings.textAlign : "center";
        const textShadowCss = _textShadowCss(this._settings);
        const dateTextEnabled = this._settings.dateTextEnabled ?? true;
        this._actor.set_style((this._api.resolveCardCss?.() ?? _cardStyleCss(this._settings, {
            cornerRadiusFallback: 18
        })) + "padding: 8px 18px; " + "spacing: 2px;");
        const clockText = now.format(this._clockFormat()) ?? "";
        this._clockLabel.set_text(clockText);
        this._clockLabel.set_style(`color: ${clockColor}; font-family: ${clockFontFamily}; ` + `font-size: ${clockFontSize}px; font-weight: bold; text-align: ${textAlign}; ` + `${textShadowCss}`);
        this._dateLabel.visible = dateTextEnabled;
        if (dateTextEnabled) {
            const dateFormat = this._resolveDateFormat();
            const dateText = dateFormat === "mm-dd-yyyy" ? now.format("%m-%d-%Y") ?? "" : now.format("%d-%m-%Y") ?? "";
            this._dateLabel.set_text(dateText);
            this._dateLabel.set_style(`color: ${dateColor}; font-family: ${dateFontFamily}; ` + `font-size: ${dateFontSize}px; text-align: ${textAlign}; ` + `${textShadowCss}`);
        }
    }
}